/* TaskBoard Service Worker
 *
 * アプリ本体とルール/辞書データを端末にキャッシュし、圏外でも起動できるようにする。
 * Supabase のデータ API（/rest/v1）はキャッシュせず、そのまま通す。
 * アプリ側がタスクデータを localStorage に保持しているので、
 * 通信が失敗しても最後に同期した内容が表示される。
 *
 * 原本・スケッチの画像（Storage の公開 URL）だけは端末に保存し、以後はネットワークに出ずに返す。
 * 画像は差し替えると URL ごと変わる（中身が変わらない）ので、古い内容を返す心配は無い。
 * このキャッシュはアプリの版と切り離してあり、アプリを更新しても消えない。
 *
 * ファイルを更新したら CACHE_VERSION を上げること。
 */
var CACHE_VERSION = 'taskboard-v4.1.6';
var IMAGE_CACHE = 'taskboard-images'; // app.js と同じ名前
var IMAGE_PATH = '/storage/v1/object/public/taskboard/';
var IMAGE_CACHE_MAX = 400; // これを超えたら古いものから消す（1大会で数十枚程度）
var SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './config.js',
  './manifest.webmanifest',
  './apple-touch-icon.png',
  './icon-192.png',
  './favicon-32.png',
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

/*
 * 古い版のキャッシュを消す。自分の名前（taskboard-）で始まるものだけを対象にすること。
 * GoalView 4D は同じサーバーの /taskboard/ に TaskBoard を置いて地図の上に埋め込む。
 * キャッシュはサーバー（オリジン）ごとに共有なので、名前を問わず消すと
 * GoalView 4D 側のオフライン用キャッシュ（地図アプリ本体）まで消してしまう。
 */
var OWN_CACHE_PREFIX = 'taskboard-';

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.map(function (k) {
          if (k.indexOf(OWN_CACHE_PREFIX) !== 0) return null; // 他のアプリのキャッシュには触れない
          return k === CACHE_VERSION || k === IMAGE_CACHE ? null : caches.delete(k);
        }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;

  var url = new URL(req.url);
  if (url.pathname.indexOf(IMAGE_PATH) === 0) {
    event.respondWith(cachedImage(url.href));
    return;
  }
  // それ以外の別オリジン（Supabase のデータ API など）はキャッシュに触れずネットワークへ
  if (url.origin !== self.location.origin) return;
  // 管理画面（admin/）と、管理画面が読み込むもの（config.js など）は常に最新を使う。
  // キャッシュすると、設定を変えても管理画面に1回遅れて反映される
  if (url.pathname.indexOf('/admin/') >= 0) return;
  if (req.referrer && req.referrer.indexOf('/admin/') >= 0) return;

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

/**
 * <img> からの要求は no-cors で来るが、そのまま取ると中身の見えない応答になり、
 * ブラウザによってはキャッシュの容量を1件数MBとして数えられてしまう。CORS で取り直して保存する。
 */
function cachedImage(href) {
  return caches.open(IMAGE_CACHE).then(function (cache) {
    return cache.match(href).then(function (hit) {
      if (hit) return hit;
      return fetch(href, { mode: 'cors', credentials: 'omit' }).then(function (res) {
        if (res.ok) {
          cache.put(href, res.clone()).then(function () { return trim(cache); });
        }
        return res;
      });
    });
  });
}

function trim(cache) {
  return cache.keys().then(function (keys) {
    var extra = keys.length - IMAGE_CACHE_MAX;
    for (var i = 0; i < extra; i++) cache.delete(keys[i]);
  });
}
