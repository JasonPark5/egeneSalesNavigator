const CACHE = 'egene-v1';
// sw.js 자신의 위치 기준 상대경로 — 루트('/')가 아니라 하위 경로(예: GitHub Pages
// 프로젝트 사이트의 /repo이름/)에 배포돼도 정확한 경로로 캐싱되도록 함.
const ASSETS = [
  './',
  './index.html',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './manifest.json',
  './pipeline-client.js',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = e.request.url;

  // 로컬 API(/api/*, ActionFlow 브릿지) / Nominatim: 항상 네트워크 (캐시하지 않음)
  if (url.includes('/api/') || url.includes('nominatim')) return;

  // index.html / 루트: network-first (최신 코드 우선)
  if (e.request.mode === 'navigate' || url.endsWith('/') || url.endsWith('/index.html')) {
    e.respondWith(
      fetch(e.request)
        .then(r => {
          const copy = r.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
          return r;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // 그 외(아이콘 등): cache-first
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
