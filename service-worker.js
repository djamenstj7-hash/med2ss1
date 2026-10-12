/* MED2 S1 · V0.19 — light shell, navigation network-first, offline fallback */
const CACHE='med2-s1-shell-20261012-v01951-images-Assets';
const SHELL=new URL('./index.html',self.registration.scope).href;
const ASSETS=['./index.html','./manifest.webmanifest','./data/catalogue.json','./data/examens.json','./data/modalites.json','./data/pedagogie.json','./data/entrainements.json','./icon-192.png','./icon-512.png','./Assets/lb-centre-germinatif.svg','./Assets/lb-maturation.svg','./Assets/snv-circuits.svg','./Assets/snv-pupille.svg','./Assets/snv-synapse.svg','./Assets/variabilite-facteurs.svg','./Assets/variabilite-grossesse-interactions.svg','./Assets/viro-trois-cycles.svg','./Assets/viro-virion-structure.svg','./Assets/dm-superiorite-noninferiorite.svg','./Assets/dm-parcours-ce.svg','./Assets/info-echange-partage.svg','./Assets/info-donnee-sens.svg'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('med2-s1-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',e=>{
 const req=e.request;if(req.method!=='GET')return;
 const url=new URL(req.url);if(url.origin!==self.location.origin||!url.pathname.startsWith(new URL('./',self.registration.scope).pathname))return;
 e.respondWith(fetch(req).then(res=>{
   if(res.ok){const copy=res.clone();e.waitUntil(caches.open(CACHE).then(c=>c.put(req.mode==='navigate'?SHELL:req,copy)).catch(()=>{}));}
   return res;
 }).catch(async()=> (await caches.match(req.mode==='navigate'?SHELL:req))||Response.error()));
});
