/* MED2 S1 — téléchargement complet des cours, illustrations et fichiers de l’application.
   Les références sont découvertes dans le HTML et les JSON : les nouvelles images n’ont
   plus besoin d’être ajoutées à une liste manuelle. Une installation interrompue garde
   les copies précédentes ; les PDF personnels restent dans leur stockage IndexedDB. */
const VERSION = '20261016-v043-identite';
const CACHE = 'med2-s1-' + VERSION;
const SCOPE = new URL('./', self.registration.scope);
const SHELL = new URL('./index.html', SCOPE).href;
const REPORT = new URL('./__installation.json', SCOPE).href;
const PRECACHE = [
  './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './apple-touch-icon.png',
  './data/catalogue.json', './data/examens.json', './data/modalites.json',
  './data/pedagogie.json', './data/entrainements.json',
];
const NETWORK_TIMEOUT = 15000;

const keyOf = (url) => {
  const u = new URL(url, SCOPE);
  u.search = '';
  u.hash = '';
  return u.href;
};
const relative = (url) => './' + new URL(url).pathname.slice(SCOPE.pathname.length);
const wait = (ms) => new Promise((resolve) => setTimeout(() => resolve(null), ms));

async function cachedCopy(key) {
  try {
    const current = await caches.open(CACHE);
    const hit = await current.match(key);
    if (hit) return hit;
    for (const name of (await caches.keys()).reverse()) {
      if (!name.startsWith('med2-s1-') || name === CACHE) continue;
      const hit = await (await caches.open(name)).match(key);
      if (hit) return hit;
    }
  } catch {}
  return null;
}

/* Le stockage peut être plein ou refusé : cela ne doit jamais masquer une réponse réseau. */
async function putSafely(cache, key, response) {
  try {
    await cache.put(key, response);
    return true;
  } catch {
    return false;
  }
}

async function fetchWithTimeout(url, timeout = NETWORK_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { cache: 'no-cache', credentials: 'same-origin', signal: controller.signal });
    /* Lire le corps avant de lever le délai : les gros JSON/images peuvent rester bloqués après les en-têtes. */
    const body = await response.arrayBuffer();
    const headers = new Headers(response.headers);
    headers.delete('content-encoding');
    headers.set('content-length', String(body.byteLength));
    return new Response([204, 205, 304].includes(response.status) ? null : body, { status: response.status, statusText: response.statusText, headers });
  } finally {
    clearTimeout(timer);
  }
}

function localResource(path) {
  if (!path || /[${}]/.test(path)) return null;
  try {
    const url = new URL(path, SCOPE);
    if (url.origin !== SCOPE.origin || !url.pathname.startsWith(SCOPE.pathname)) return null;
    if (!/\.(?:html|json|js|css|png|webp|jpe?g|gif|avif|svg|woff2?|webmanifest)$/i.test(url.pathname)) return null;
    return keyOf(url);
  } catch {
    return null;
  }
}

/* Parcours de toutes les propriétés, y compris les figures hors sections et les futures banques. */
function discoverJSON(value, add) {
  if (typeof value === 'string') {
    const direct = localResource(value);
    if (direct) add(direct);
    discoverAssets(value, add);
  } else if (Array.isArray(value)) {
    value.forEach((entry) => discoverJSON(entry, add));
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach((entry) => discoverJSON(entry, add));
  }
}

function discoverAssets(text, add) {
  for (const match of text.matchAll(/(?:\.\/)?Assets\/[A-Za-z0-9_./%-]+\.(?:png|webp|jpe?g|gif|avif|svg|woff2?)/gi)) {
    const url = localResource(match[0]);
    if (url) add(url);
  }
}

function discoverHTML(text, add) {
  discoverAssets(text, add);
  for (const match of text.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
    const url = localResource(match[1]);
    if (url) add(url);
  }
}

let downloadTask = null;
const progressPorts = new Set();
let latestProgress = null;
async function notifyProgress(message) {
  latestProgress = message;
  for (const port of progressPorts) {
    try { port.postMessage(message); } catch {}
  }
  try {
    for (const client of await self.clients.matchAll({ includeUncontrolled: true, type: 'window' })) client.postMessage(message);
  } catch {}
}

async function readReport(verify = false) {
  try {
    const response = await (await caches.open(CACHE)).match(REPORT);
    const report = response ? await response.json() : null;
    if (verify && report?.resources) {
      report.missing = [];
      for (const path of report.resources) if (!await cachedCopy(keyOf(path))) report.missing.push(path);
      report.available = report.total - report.missing.length;
      report.complete = !report.missing.length && !report.failed.length;
    }
    return report;
  } catch {
    return null;
  }
}

function cacheCourses(port) {
  if (port) progressPorts.add(port);
  if (!downloadTask) {
    downloadTask = downloadCourses().finally(() => {
      downloadTask = null;
      latestProgress = null;
      progressPorts.clear();
    });
  } else if (port && latestProgress) {
    port.postMessage(latestProgress);
  }
  return downloadTask;
}

async function downloadCourses() {
  const cache = await caches.open(CACHE);
  const previous = await readReport();
  const retry = new Set((previous?.failed || []).map((item) => keyOf(item.path)));
  const expected = new Set();
  const queue = [];
  const failed = new Map();
  let cursor = 0, done = 0, lastNotice = 0;
  const add = (path) => {
    const url = localResource(path);
    if (!url || expected.has(url)) return;
    expected.add(url);
    queue.push(url);
  };
  PRECACHE.forEach(add);
  const progress = async (force = false) => {
    if (force || Date.now() - lastNotice > 250) {
      lastNotice = Date.now();
      await notifyProgress({ type: 'OFFLINE_PROGRESS', done, total: expected.size });
    }
  };
  await progress(true);
  const worker = async () => {
    while (cursor < queue.length) {
      const url = queue[cursor++];
      const source = /\.(?:html|json|js|css)$/i.test(new URL(url).pathname);
      const current = await cache.match(url);
      let response = current || await cachedCopy(url);
      /* Revalider une fois par version, ou après échec. Les autres copies courantes se réutilisent. */
      if (source || !current || retry.has(url)) {
        try {
          const fresh = await fetchWithTimeout(url, 60000);
          if (!fresh.ok) throw new Error('HTTP ' + fresh.status);
          if (/\.json$/i.test(new URL(url).pathname)) await fresh.clone().json();
          response = fresh;
          if (!await putSafely(cache, url, fresh.clone())) throw new Error('Stockage indisponible ou plein');
        } catch (error) {
          failed.set(url, error.name === 'AbortError' ? 'Connexion trop lente ou interrompue' : error.message);
        }
      }
      /* Si le réseau échoue, conserver aussi dans le nouveau cache la copie de secours. */
      if (response && !await cache.match(url)) {
        if (!await putSafely(cache, url, response.clone())) failed.set(url, 'Stockage indisponible ou plein');
      }
      if (response && source) {
        try {
          const text = await response.text();
          if (/\.json$/i.test(new URL(url).pathname)) discoverJSON(JSON.parse(text), add);
          else discoverHTML(text, add);
        } catch {
          failed.set(url, 'Fichier illisible');
        }
      }
      done++;
      await progress();
    }
  };
  const heartbeat = setInterval(() => { progress(true).catch(() => {}); }, 10000);
  try {
    await Promise.all([worker(), worker(), worker(), worker()]);
  } finally {
    clearInterval(heartbeat);
  }
  const missing = [];
  for (const url of expected) if (!await cachedCopy(url)) missing.push(relative(url));
  const report = {
    schemaVersion: 2, version: VERSION, total: expected.size,
    available: expected.size - missing.length, missing, resources: [...expected].map(relative),
    failed: [...failed].map(([url, reason]) => ({ path: relative(url), reason })),
    complete: !missing.length && !failed.size, at: new Date().toISOString(),
  };
  await putSafely(cache, REPORT, new Response(JSON.stringify(report), { headers: { 'content-type': 'application/json' } }));
  await notifyProgress({ type: 'OFFLINE_COMPLETE', report });
  return report;
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    /* Un refus de stockage ne bloque pas l’application en ligne ni la version déjà installée. */
    try { await cacheCourses(); } catch {}
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    let migrated = true;
    const older = (await caches.keys()).filter((name) => name.startsWith('med2-s1-') && name !== CACHE);
    /* Copier aussi le shell et les JSON : une mise à jour coupée ne doit pas effacer les cours. */
    for (const name of older.slice().reverse()) {
      const old = await caches.open(name);
      for (const request of await old.keys()) {
        const key = keyOf(request.url);
        if (!key.startsWith(SCOPE.href) || key === REPORT || await cache.match(key)) continue;
        const response = await old.match(request);
        if (response && !await putSafely(cache, key, response)) migrated = false;
      }
    }
    const report = await readReport();
    if (migrated && report?.complete) for (const name of older) await caches.delete(name);
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  const port = event.ports?.[0];
  if (event.data?.type === 'OFFLINE_STATUS') {
    event.waitUntil(readReport(true).then((report) => port?.postMessage({ type: 'OFFLINE_STATUS', report, progress: latestProgress })));
  }
  if (event.data?.type === 'CACHE_COURSES') {
    event.waitUntil(cacheCourses(port).then((report) => {
      port?.postMessage({ type: 'OFFLINE_COMPLETE', report });
    }).catch((error) => {
      port?.postMessage({ type: 'OFFLINE_ERROR', message: error.message });
    }));
  }
});

function sameVersion(a, b) {
  const ea = a.headers.get('etag'), eb = b.headers.get('etag');
  if (ea && eb) return ea === eb;
  const la = a.headers.get('last-modified'), lb = b.headers.get('last-modified');
  return !!(la && lb && la === lb && a.headers.get('content-length') === b.headers.get('content-length'));
}

async function networkFirst(event, request, key, timeoutMs) {
  const network = fetchWithTimeout(request.url).then(async (response) => {
    if (response?.ok) {
      if (/\.json$/i.test(new URL(request.url).pathname)) await response.clone().json();
      try {
        const cache = await caches.open(CACHE);
        const old = await cache.match(key);
        if (!old || !sameVersion(response, old)) await putSafely(cache, key, response.clone());
      } catch {}
    }
    return response;
  });
  const cached = await cachedCopy(key);
  if (!cached) {
    try { return await network; } catch { return Response.error(); }
  }
  const first = await Promise.race([network.catch(() => null), wait(timeoutMs)]);
  if (first?.ok) return first;
  event.waitUntil(network.catch(() => null));
  return cached;
}

async function cacheFirst(request) {
  const key = keyOf(request.url);
  const hit = await cachedCopy(key);
  if (hit) return hit;
  try {
    const response = await fetchWithTimeout(request.url);
    if (response?.ok) {
      try { await putSafely(await caches.open(CACHE), key, response.clone()); } catch {}
    }
    return response;
  } catch {
    return Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(SCOPE.pathname)) return;
  const path = url.pathname.slice(SCOPE.pathname.length);
  if (request.mode === 'navigate' || path === '' || path === 'index.html') {
    event.respondWith(networkFirst(event, request, SHELL, 3500));
    return;
  }
  if (path === 'service-worker.js' || path === '__installation.json') return;
  if (path.startsWith('Assets/') || /\.(?:png|webp|jpe?g|gif|avif|svg|woff2?|webmanifest)$/i.test(path)) {
    event.respondWith(cacheFirst(request));
    return;
  }
  event.respondWith(networkFirst(event, request, keyOf(request.url), 4000));
});
