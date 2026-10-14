/* MED2 S1 · V0.30 — service worker
   - Page et données (data/*.json) : réseau d'abord, en requête conditionnelle : si le fichier n'a pas changé,
     le serveur répond « 304 » et rien n'est retéléchargé. Sans réponse après quelques secondes, la copie
     locale est servie et la mise à jour se termine en arrière-plan.
   - Images, schémas et polices : cache d'abord (noms de fichiers stables).
   - Précache tolérant : un fichier absent du dépôt n'empêche plus l'installation (il est seulement signalé
     dans Réglages › Installation).
   - Clés de cache sans paramètres d'URL : le cache ne grossit plus à chaque ouverture. */
const VERSION = '20261014-v041-fiches-six-cours';
const CACHE = 'med2-s1-' + VERSION;
const PRECACHE = ["./index.html", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png", "./data/catalogue.json", "./data/examens.json", "./data/modalites.json", "./data/pedagogie.json", "./data/entrainements.json", "./Assets/dm-parcours-ce.svg", "./Assets/dm-superiorite-noninferiorite.svg", "./Assets/info-donnee-sens.svg", "./Assets/info-echange-partage.svg", "./Assets/lb-centre-germinatif.svg", "./Assets/lb-maturation.svg", "./Assets/pd-puissance-efficacite.svg", "./Assets/pk-cmax-tmax-asc.svg", "./Assets/pk-demi-vie.svg", "./Assets/pk-plateau.svg", "./Assets/snv-circuits.svg", "./Assets/snv-pupille.svg", "./Assets/snv-synapse.svg", "./Assets/stp-bornes.svg", "./Assets/variabilite-facteurs.svg", "./Assets/variabilite-grossesse-interactions.svg", "./Assets/viro-cycle-enterovirus.svg", "./Assets/viro-cycle-herpes.svg", "./Assets/viro-trois-cycles.svg", "./Assets/viro-virion-structure.svg", "./Assets/fonts/atkinson-next-latin-ext.woff2", "./Assets/fonts/atkinson-next-latin.woff2", "./Assets/fiches/anemie.webp", "./Assets/fiches/dendritic.webp", "./Assets/fiches/epo.webp", "./Assets/fiches/ganglion.webp", "./Assets/fiches/hemostase.webp", "./Assets/fiches/hla.webp", "./Assets/fiches/immuneclock.webp", "./Assets/fiches/immuneorgans.webp", "./Assets/fiches/lb.webp", "./Assets/fiches/lymphflow.webp", "./Assets/fiches/myelo.webp", "./Assets/fiches/neutro.webp", "./Assets/fiches/nfs.webp", "./Assets/fiches/rbc.webp", "./Assets/fiches/semio-cardio-foyers.webp", "./Assets/fiches/semio-digestif-regions.webp", "./Assets/fiches/semio-gyneco-anatomie.webp", "./Assets/fiches/semio-neuro-nerfs.webp", "./Assets/fiches/semio-pneumo-exam.webp", "./Assets/fiches/semio-rhumato-fiche.webp", "./Assets/fiches/semio-uro-reperes.webp", "./Assets/fiches/tcr.webp", "./Assets/fiches/v13-legal-ecchymose.webp", "./Assets/fiches/v13-legal-erosion.webp", "./Assets/fiches/v13-legal-excoriation.webp", "./Assets/fiches/v13-trauma-imaging.webp"];
const SCOPE = new URL('./', self.registration.scope);
const SHELL = new URL('./index.html', SCOPE).href;
const REPORT = new URL('./__installation.json', SCOPE).href;

const keyOf = (url) => {
  const u = new URL(url);
  u.search = '';
  u.hash = '';
  return u.href;
};
const wait = (ms) => new Promise((r) => setTimeout(() => r(null), ms));

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      const missing = [];
      let i = 0;
      const queue = PRECACHE.slice();
      const worker = async () => {
        while (i < queue.length) {
          const path = queue[i++];
          const url = new URL(path, SCOPE).href;
          try {
            const res = await fetch(url, { cache: 'no-cache' });
            if (res.ok) await cache.put(keyOf(url), res);
            else missing.push(path);
          } catch (e) {
            missing.push(path);
          }
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
      await cache.put(
        REPORT,
        new Response(JSON.stringify({ version: VERSION, total: PRECACHE.length, missing, at: new Date().toISOString() }), {
          headers: { 'content-type': 'application/json' },
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      for (const name of await caches.keys()) {
        if (!name.startsWith('med2-s1-') || name === CACHE) continue;
        /* Les photos déjà consultées restent disponibles hors ligne après une mise à jour. */
        const old = await caches.open(name);
        for (const req of await old.keys()) {
          if (!/\/Assets\//.test(req.url)) continue;
          const key = keyOf(req.url);
          if (!(await cache.match(key))) {
            const res = await old.match(req);
            if (res) await cache.put(key, res);
          }
        }
        await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

/* Même version ? (ETag, sinon date de modification + taille) : évite de réécrire 8 Mo à chaque ouverture,
   ce qui faisait grossir l'espace occupé par le site. */
function sameVersion(a, b) {
  const ea = a.headers.get('etag'),
    eb = b.headers.get('etag');
  if (ea && eb) return ea === eb;
  const la = a.headers.get('last-modified'),
    lb = b.headers.get('last-modified');
  return !!(la && lb && la === lb && a.headers.get('content-length') === b.headers.get('content-length'));
}

async function networkFirst(event, request, key, timeoutMs) {
  const cache = await caches.open(CACHE);
  const network = fetch(request.url, { cache: 'no-cache', credentials: 'same-origin' }).then(async (res) => {
    if (res && res.ok) {
      const old = await cache.match(key);
      if (!old || !sameVersion(res, old)) await cache.put(key, res.clone());
    }
    return res;
  });
  const cached = await cache.match(key);
  if (!cached) {
    try {
      return await network;
    } catch (e) {
      return Response.error();
    }
  }
  const first = await Promise.race([network.catch(() => null), wait(timeoutMs)]);
  if (first && first.ok) return first;
  event.waitUntil(network.catch(() => null));
  return cached;
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const key = keyOf(request.url);
  const hit = await cache.match(key);
  if (hit) return hit;
  try {
    const res = await fetch(request);
    if (res && res.ok) await cache.put(key, res.clone());
    return res;
  } catch (e) {
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
  if (path.startsWith('data/')) {
    event.respondWith(networkFirst(event, request, keyOf(request.url), 4000));
    return;
  }
  if (path.startsWith('Assets/') || /\.(png|webp|jpe?g|svg|woff2|webmanifest)$/.test(path)) {
    event.respondWith(cacheFirst(request));
    return;
  }
  event.respondWith(networkFirst(event, request, keyOf(request.url), 4000));
});
