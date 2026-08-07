/* TaskBoard Service Worker
 *
 * アプリ本体とルール/辞書データを端末にキャッシュし、圏外でも起動できるようにする。
 * GAS API（別オリジン）へのリクエストは一切キャッシュせず、そのまま通す。
 * アプリ側がタスクデータを localStorage に保持しているので、
 * 通信が失敗しても最後に同期した内容が表示される。
 *
 * ファイルを更新したら CACHE_VERSION を上げること。
 */
var CACHE_VERSION = 'taskboard-v3.3.1';
var SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './config.js',
  './manifest.webmanifest',
  './icon.svg',
  './icon-maskable.svg',
  './data/dictionary.json',
  './data/axmer2026-ch15.json'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(function (cache) { return cache.addAll(SHELL); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.map(function (k) {
          return k === CACHE_VERSION ? null : caches.delete(k);
        }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;

  var url = new URL(req.url);
  // 別オリジン（GAS API など）はキャッシュに触れずネットワークへ
  if (url.origin !== self.location.origin) return;

  // stale-while-revalidate: まずキャッシュを返し、裏で更新する
  event.respondWith(
    caches.open(CACHE_VERSION).then(function (cache) {
      return cache.match(req, { ignoreSearch: true }).then(function (cached) {
        var network = fetch(req).then(function (res) {
          if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
          return res;
        }).catch(function () {
          // オフライン。キャッシュがあればそれ、無ければアプリ本体を返す。
          return cached || cache.match('./index.html');
        });
        return cached || network;
      });
    })
  );
});
