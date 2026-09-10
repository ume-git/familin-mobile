// トルマモ のサービスワーカー。
// 電波が無い場所でもアプリが開けるように、アプリ本体をキャッシュしておく。
// 登録データ本体はIndexedDBに入っており、ここでは一切扱わない。
//
// 【重要】更新のしかたについて
// 以前はキャッシュを最優先で返していたため、こちらが新しい版を出しても
// 端末はいつまでも古い版を開き続けてしまっていた。
// そこで、アプリ本体（HTML・JS）は「まずネットを見に行き、つながらないときだけ
// キャッシュを使う」方式に変えた。これで公開した内容がその場で届く。
//
// 版を上げるときは、必ず下の 版 を書き換えること。
// 中身が1文字でも変われば、端末が新しいサービスワーカーとして認識して入れ替える。

const 版 = "2026-09-10c";
const キャッシュ名 = `torumamo-shell-${版}`;

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
  // 古い版の入れ替えを待たず、すぐ新しい版を有効にする。
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((キー一覧) =>
        Promise.all(キー一覧.filter((k) => k !== キャッシュ名).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

// 中身が変わるもの（HTML・JS）は、ネットを優先する。
async function ネットを優先する(request){
  try {
    const 応答 = await fetch(request);
    if(応答 && 応答.ok){
      const 控え = 応答.clone();
      caches.open(キャッシュ名).then((cache) => cache.put(request, 控え)).catch(() => {});
    }
    return 応答;
  } catch(e) {
    // 電波が無いときは、しまってある版で開く。
    const キャッシュ済み = await caches.match(request);
    if(キャッシュ済み) return キャッシュ済み;
    const 代わり = await caches.match("./index.html");
    if(代わり) return 代わり;
    throw e;
  }
}

// 変わらないもの（アイコンなど）は、キャッシュを優先しつつ裏で更新する。
async function キャッシュを優先する(request){
  const キャッシュ済み = await caches.match(request);
  const 取り直し = fetch(request).then((応答) => {
    if(応答 && 応答.ok){
      const 控え = 応答.clone();
      caches.open(キャッシュ名).then((cache) => cache.put(request, 控え)).catch(() => {});
    }
    return 応答;
  }).catch(() => キャッシュ済み);
  return キャッシュ済み || 取り直し;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if(request.method !== "GET") return;

  const url = new URL(request.url);

  // torumamo.jp のAPIなど、よそへの通信には一切手を出さない。
  if(url.origin !== self.location.origin) return;

  const 本体である =
    request.mode === "navigate" ||
    url.pathname.endsWith("/") ||
    url.pathname.endsWith(".html") ||
    url.pathname.endsWith(".js") ||
    url.pathname.endsWith(".json");

  event.respondWith(本体である ? ネットを優先する(request) : キャッシュを優先する(request));
});
