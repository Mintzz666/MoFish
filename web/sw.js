// MoFish 静态资源缓存。
//
// 边界（阶段 A 明确要求）：
// - 只缓存本站同源的静态资源；跨源请求（Supabase Auth / PostgREST）直接放行、绝不进缓存。
// - 只处理 GET；POST/PUT 等写操作从不经过这里。
// - 云端私有数据一律不缓存：即使将来 API 变成同源，也要先把它从 FILES 与本分支里排除。
const CACHE = 'mofish-static-v2';
const FILES = ['./', './index.html', './style.css', './app.js', './model.js', './storage.js', './config.js',
  './cloud/config.js', './cloud/auth.js', './cloud/api.js', './cloud/client.js', './cloud/sync.js',
  './ui/account.js', './icon.svg', './manifest.webmanifest'];

self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES))));

self.addEventListener('activate', event => event.waitUntil(
  caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('mofish-static-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim())
));

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // 跨源（含 Supabase）不拦截：认证/存档接口必须每次都打到真实服务端。
  if (url.origin !== self.location.origin) return;
  // 兜底：即便同源，也不缓存任何看起来像接口或带凭据的请求。
  if (/(^|\/)(auth|rest|rpc)(\/|$)/.test(url.pathname) || request.headers.get('authorization')) return;

  event.respondWith(
    fetch(request)
      .then(response => {
        if (response.ok && FILES.some(file => new URL(file, self.registration.scope).href === request.url)) {
          const copy = response.clone();
          event.waitUntil(caches.open(CACHE).then(cache => cache.put(request, copy)));
        }
        return response;
      })
      .catch(() => caches.match(request).then(cached => cached || (request.mode === 'navigate' ? caches.match('./index.html') : Response.error())))
  );
});
