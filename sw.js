/* 오프라인 실행용 Service Worker
 * - 앱 파일(같은 주소): 네트워크 우선, 실패/지연 시 저장본 사용 → 온라인이면 항상 최신
 * - 폰트·html2canvas(CDN): 저장본 우선 → 오프라인에서도 글꼴·화면 저장 동작
 * - 동기화 서버 요청(Supabase 등): 건드리지 않음 (캐시하면 안 됨)
 * 앱 파일을 고친 뒤에는 VERSION 숫자를 올리면 모든 기기가 새로 받습니다.
 */
var VERSION = 'v2';
var CACHE = 'recordable-' + VERSION;
var APP = ['./', 'index.html', 'setup.html', 'config.js', 'sync.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];
var CDN = [
  'https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.css',
  'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js'
];
var CDN_HOSTS = ['cdn.jsdelivr.net', 'cdnjs.cloudflare.com'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return c.addAll(APP).then(function () {
      return Promise.all(CDN.map(function (u) { return c.add(new Request(u, { mode: 'cors' })).catch(function () {}); }));
    });
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf('recordable-') === 0 && k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function timeout(ms) { return new Promise(function (_, rej) { setTimeout(rej, ms); }); }

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);

  if (url.origin === self.location.origin) {
    e.respondWith(
      Promise.race([fetch(req), timeout(4000)]).then(function (res) {
        if (res && res.ok) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); }
        return res;
      }).catch(function () {
        return caches.match(req, { ignoreSearch: true }).then(function (hit) {
          return hit || (req.mode === 'navigate' ? caches.match('index.html') : Response.error());
        });
      })
    );
    return;
  }

  if (CDN_HOSTS.indexOf(url.hostname) >= 0) {
    e.respondWith(caches.match(req).then(function (hit) {
      return hit || fetch(req).then(function (res) {
        if (res && (res.ok || res.type === 'opaque')) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); }
        return res;
      });
    }));
  }
  // 그 외(동기화 서버 등)는 브라우저 기본 동작
});
