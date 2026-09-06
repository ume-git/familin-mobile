// トルマモ のサービスワーカー。
// アプリ本体（見た目・プログラム）だけをキャッシュしておき、
// 電波が無い場所でもアプリ自体は開けるようにする。
// 登録データ本体はIndexedDBに入っており、ここでは一切扱わない。

const キャッシュ名 = "familin-shell-v1";
const キャッシュ対象 = [
  "./",
  "./index.html",
  "./crypto.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(キャッシュ名).then((cache) => cache.addAll(キャッシュ対象))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((キー一覧) =>
      Promise.all(キー一覧.filter((k) => k !== キャッシュ名).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  event.respondWith(
    caches.match(event.request).then((キャッシュ済み) => キャッシュ済み || fetch(event.request))
  );
});
