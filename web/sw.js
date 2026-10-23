// Only immutable, same-origin public assets are cached. Auth/RPC/private data bypass this worker.
const BUILD = __MOFISH_ASSET_MANIFEST__;
const PREFIX = 'mofish-static-';
const CACHE = PREFIX + BUILD.buildId;
const metaUrl = new URL('./__cached-build.json', self.registration.scope).href;
const assetUrl = file => new URL(file, self.registration.scope).href;
const assets = new Set([...BUILD.shell, ...BUILD.lazy].map(assetUrl));
const clientEntries = new Map();

async function verifyAsset(file, response) {
  if (!response.ok) throw new Error('Asset download failed');
  const expected = BUILD.hashes?.[file];
  if (expected) {
    const digest = await crypto.subtle.digest('SHA-256', await response.clone().arrayBuffer());
    const actual = [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2,'0')).join('');
    if (actual !== expected) throw new Error('Mixed build rejected');
  }
}
async function cacheAsset(cache, file) {
  const cached = await cache.match(assetUrl(file));
  const response = cached || await fetch(new Request(assetUrl(file), {cache:'reload'}));
  await verifyAsset(file,response);
  if (!cached) await cache.put(assetUrl(file), response);
}

self.addEventListener('install', event => event.waitUntil((async () => {
  const cache = await caches.open(CACHE);
  try {
    await Promise.all(BUILD.shell.map(file => cacheAsset(cache,file)));
    await cache.put(metaUrl, new Response(JSON.stringify(BUILD), {headers:{'Content-Type':'application/json'}}));
  } catch (error) {
    await caches.delete(CACHE); // An incomplete install never replaces the working version.
    throw error;
  }
})()));

async function pruneUnused() {
  const clients = await self.clients.matchAll({type:'window',includeUncontrolled:true});
  // Unknown/legacy clients may still need their old lazy chunks. Never guess they are disposable.
  if (clients.some(client => !clientEntries.has(client.id))) return;
  const inUse = new Set(clients.map(client => clientEntries.get(client.id)));
  for (const key of await caches.keys()) {
    if (!key.startsWith(PREFIX) || key === CACHE) continue;
    const cached = await caches.open(key);
    const metadata = await cached.match(metaUrl);
    const manifest = metadata ? await metadata.json() : null;
    if (!manifest || !inUse.has(assetUrl(manifest.entry))) await caches.delete(key);
  }
}
self.addEventListener('activate', event => event.waitUntil((async () => {
  await self.clients.claim();
  const clients = await self.clients.matchAll({type:'window',includeUncontrolled:true});
  for (const client of clients) client.postMessage({type:'MOFISH_BUILD_QUERY'});
  await pruneUnused();
})()));

self.addEventListener('message', event => {
  if (event.data?.type === 'MOFISH_USE_UPDATE') event.waitUntil(self.skipWaiting());
  if (event.data?.type === 'MOFISH_BUILD_STATUS' && event.source?.id) {
    const entry = event.data.entry;
    if (typeof entry === 'string' && new URL(entry,self.location.origin).origin === self.location.origin) {
      clientEntries.set(event.source.id, new URL(entry,self.location.origin).href);
      event.waitUntil(pruneUnused());
      event.source.postMessage?.({type:'MOFISH_SHELL_CACHED',entry:assetUrl(BUILD.entry)});
    }
  }
  // Only requested after the 3D module was actually used; 2D sessions never prefetch Three.js.
  if (event.data?.type === 'MOFISH_CACHE_3D') event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(BUILD.lazy.map(file => cacheAsset(cache,file)));
    event.source?.postMessage({type:'MOFISH_3D_CACHED',entry:assetUrl(BUILD.entry)});
  })().catch(() => {}));
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  const canonical = new URL(url);
  if (canonical.pathname.includes('/assets/')) canonical.search = '';
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (/(^|\/)(auth|rest|rpc)(\/|$)/.test(url.pathname) || request.headers.get('authorization')) return;
  if (url.href === assetUrl('asset-manifest.json')) {
    event.respondWith(Promise.resolve(new Response(JSON.stringify(BUILD),{headers:{'Content-Type':'application/json','Cache-Control':'no-cache'}})));
    return;
  }
  if (request.mode === 'navigate') {
    // The HTML and its hashed code stay on one build until an installed update is chosen.
    event.respondWith(caches.open(CACHE).then(async cache => (await cache.match(assetUrl('index.html'))) || fetch(request)));
    return;
  }
  if (!assets.has(canonical.href) && !url.pathname.includes('/assets/')) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(canonical.href) || await caches.match(canonical.href);
    if (cached) return cached;
    const response = await fetch(request);
    if (assets.has(canonical.href)) {
      const file = [...BUILD.shell,...BUILD.lazy].find(file => assetUrl(file) === canonical.href);
      await verifyAsset(file,response);
      await cache.put(canonical.href,response.clone());
    }
    return response;
  })());
});
