// ============================================================
// ストア版（Capacitor で包んだ iPhone / Android アプリ）でだけ動く差し替え。
//
// ブラウザ版（GitHub Pages / PWA）で読み込まれても、最初の判定で抜けるので何もしない。
// index.html の関数は <script> の最上位で宣言されているので、ここで同名の
// グローバルに代入すれば、以降の呼び出しはこちらに切り替わる。
//
// 差し替えるもの
//   1. 通知      … Web Push → ネイティブの通知（FCM / APNs）。窓口 push.php はそのまま
//   2. Face ID   … WebAuthn PRF → 端末の生体認証 + Keychain / Keystore
//   3. ファイル  … navigator.share({files}) → Filesystem に書いて Share で渡す
//   4. 届いた物  … リンク（…/#c=コード）で起動されたときにコードを拾う
// ============================================================
(function(){
  const Cap = window.Capacitor;
  if(!(Cap && Cap.isNativePlatform && Cap.isNativePlatform())) return;
  const P = Cap.Plugins || {};
  const 端末 = Cap.getPlatform ? Cap.getPlatform() : "";   // "ios" | "android"
  document.documentElement.classList.add("native", "native-" + 端末);

  // ------------------------------------------------------------
  // 1. 通知
  // ------------------------------------------------------------
  // 購読の形は Web Push と同じ入れ物に入れて push.php に渡す（窓口を増やさない）。
  //   endpoint … https://fcm.googleapis.com/native/<token>  （サーバー側でこの形を見て FCM に振り分ける）
  //   keys     … Web Push の検査を通すための印。中身は使わない
  const 通知の入口 = "https://fcm.googleapis.com/native/";
  function 通知トークンを購読の形に(token){
    return { endpoint: 通知の入口 + token, keys: { p256dh: "native", auth: 端末 || "native" }, platform: 端末 };
  }
  function 保存済みトークン(){ try { return localStorage.getItem("torumamo_native_push_token") || ""; } catch(e){ return ""; } }

  if(P.PushNotifications){
    const Push = P.PushNotifications;
    let 登録待ち = null;
    // 端末の通知トークンが（再）発行されたら覚えておく
    Push.addListener("registration", (t) => {
      try { localStorage.setItem("torumamo_native_push_token", t.value); } catch(e) {}
      if(登録待ち){ 登録待ち.resolve(t.value); 登録待ち = null; }
    });
    Push.addListener("registrationError", (e) => {
      if(登録待ち){ 登録待ち.reject(new Error("通知の登録ができませんでした。" + ((e && e.error) || ""))); 登録待ち = null; }
    });
    // 通知をタップして開いたときは一覧の先頭へ（登録の中身は通知に含まれていない）
    Push.addListener("pushNotificationActionPerformed", () => { try { window.scrollTo(0, 0); } catch(e) {} });

    function トークンを取る(){
      return new Promise((resolve, reject) => {
        登録待ち = { resolve, reject };
        Push.register().catch(reject);
        setTimeout(() => { if(登録待ち){ 登録待ち = null; reject(new Error("通知の登録に時間がかかりすぎました。電波の良いところでもう一度お試しください。")); } }, 20000);
      });
    }

    window.通知が使えそうか = function(){ return true; };
    window.今の購読 = async function(){
      const t = 保存済みトークン();
      if(!t) return null;
      const sub = 通知トークンを購読の形に(t);
      // Web Push の購読オブジェクトと同じ顔（toJSON / endpoint / unsubscribe）にしておく
      return { endpoint: sub.endpoint, toJSON: () => sub, unsubscribe: async () => { try { localStorage.removeItem("torumamo_native_push_token"); } catch(e) {} return true; } };
    };
    window.通知を登録する = async function(){
      let 状態 = await Push.checkPermissions();
      if(状態.receive === "prompt" || 状態.receive === "prompt-with-rationale") 状態 = await Push.requestPermissions();
      if(状態.receive !== "granted") throw new Error(端末 === "ios"
        ? "通知が許可されませんでした。「設定 → トルマモ → 通知」で許可できます。"
        : "通知が許可されませんでした。端末の「設定 → アプリ → トルマモ → 通知」で許可できます。");
      const token = 保存済みトークン() || await トークンを取る();
      const sub = 通知トークンを購読の形に(token);
      await 通知APIを呼ぶ({ action: "subscribe", sub, days: 通知の日々を作る() });
      localStorage.setItem("torumamo_push", "1");
      await 通知APIを呼ぶ({ action: "test", sub });
    };
    window.通知を解除する = async function(){
      const sub = await window.今の購読();
      if(sub){
        try { await 通知APIを呼ぶ({ action: "unsubscribe", endpoint: sub.endpoint }); } catch(e) {}
        try { await sub.unsubscribe(); } catch(e) {}
      }
      try { await Push.unregister(); } catch(e) {}
      localStorage.removeItem("torumamo_push");
    };
    // 設定画面のスイッチは Notification.permission を見るので、ネイティブの状態を写しておく
    window.Notification = window.Notification || {};
    (async () => {
      try {
        const 状態 = await Push.checkPermissions();
        Object.defineProperty(window.Notification, "permission", { configurable: true, get: () => 状態.receive === "granted" ? "granted" : (状態.receive === "denied" ? "denied" : "default") });
      } catch(e) {}
    })();
  }

  // ------------------------------------------------------------
  // 2. Face ID・指紋
  // ------------------------------------------------------------
  // WebAuthn の PRF は WebView では使えないので、端末の生体認証で本人を確かめてから
  // Keychain（iPhone）/ Keystore（Android）に置いた DEK を取り出す。
  // IndexedDB の auth レコードには「ネイティブで登録済み」の印だけを置く。
  if(P.NativeBiometric){
    const Bio = P.NativeBiometric;
    const 置き場 = "jp.torumamo.app.dek";
    const 理由 = { reason: "トルマモを開きます", title: "トルマモ", subtitle: "本人確認", description: "Face ID・指紋で開きます", useFallback: false, maxAttempts: 3 };
    async function 使える(){
      try { const r = await Bio.isAvailable({ useFallback: false }); return !!(r && r.isAvailable); } catch(e){ return false; }
    }
    function bytesを文字に(u8){ let s = ""; u8.forEach(b => s += String.fromCharCode(b)); return btoa(s); }
    function 文字をbytesに(b64){ return Uint8Array.from(atob(b64), c => c.charCodeAt(0)); }

    window.生体認証が使えそうか = function(){ return true; };
    // PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable の代わり
    window.PublicKeyCredential = window.PublicKeyCredential || {};
    window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = 使える;

    window.生体認証を登録する = async function(dek){
      if(!(await 使える())) throw new Error("この端末では Face ID・指紋が使えません。");
      await Bio.verifyIdentity(理由);
      await Bio.setCredentials({ server: 置き場, username: "dek", password: bytesを文字に(new Uint8Array(dek)) });
      const auth = await レコードを読む("auth");
      await レコードを書く("auth", Object.assign({}, auth, { 生体_native: 1 }));
    };
    window.生体認証が登録済みか = async function(){
      const auth = await レコードを読む("auth");
      return !!(auth && auth.生体_native);
    };
    window.生体認証で開く = async function(){
      const auth = await レコードを読む("auth");
      if(!auth || !auth.生体_native) return null;
      try {
        await Bio.verifyIdentity(理由);
        const c = await Bio.getCredentials({ server: 置き場 });
        if(!c || !c.password) return null;
        return 文字をbytesに(c.password);
      } catch(e){ return null; }
    };
    window.生体認証を解除する = async function(){
      try { await Bio.deleteCredentials({ server: 置き場 }); } catch(e) {}
      const auth = await レコードを読む("auth");
      if(!auth) return;
      const 残り = Object.assign({}, auth); delete 残り.生体_native;
      await レコードを書く("auth", 残り);
    };
  }

  // ------------------------------------------------------------
  // 3. ファイルを渡す（控え・.ics）
  // ------------------------------------------------------------
  // WebView では navigator.share({files}) が効かないので、いったんキャッシュ領域に書き、
  // 共有シート（ファイルに保存・AirDrop・メールなど）に渡す。
  if(P.Filesystem && P.Share){
    const FS = P.Filesystem, Share = P.Share;
    async function 文字列をファイルにして共有(名前, 中身, 題){
      const path = "share/" + 名前;
      try { await FS.mkdir({ path: "share", directory: "CACHE", recursive: true }); } catch(e) {}
      // 中身は文字列（JSON / ics）。文字化けしないよう UTF-8 で書く
      await FS.writeFile({ path, data: typeof 中身 === "string" ? 中身 : new TextDecoder().decode(中身), directory: "CACHE", encoding: "utf8", recursive: true });
      const { uri } = await FS.getUri({ path, directory: "CACHE" });
      await Share.share({ title: 題 || 名前, url: uri, dialogTitle: 題 || 名前 });
    }
    window.ファイルを渡す = async function(名前, 中身, 種類){
      try { await 文字列をファイルにして共有(名前, 中身, 名前); return "共有"; }
      catch(e){ if(e && /cancel/i.test(e.message || "")) return "やめた"; throw e; }
    };
    // .ics は index.html 側が navigator.canShare を見て分岐するので、同じ顔を用意する
    const 元のcanShare = navigator.canShare ? navigator.canShare.bind(navigator) : null;
    navigator.canShare = function(data){ return !!(data && data.files && data.files.length) || (元のcanShare ? 元のcanShare(data) : false); };
    navigator.share = async function(data){
      if(data && data.files && data.files.length){
        const f = data.files[0];
        const 中身 = await f.text();
        try { await 文字列をファイルにして共有(f.name, 中身, data.title || f.name); }
        catch(e){ const err = new Error("やめた"); err.name = "AbortError"; throw err; }
        return;
      }
      // 文章だけの共有（家族に送る）
      try { await Share.share({ title: data && data.title, text: data && data.text, url: data && data.url }); }
      catch(e){ const err = new Error("やめた"); err.name = "AbortError"; throw err; }
    };
  }

  // ------------------------------------------------------------
  // 4. リンクで起動されたとき（家族から送られた …/#c=コード）
  // ------------------------------------------------------------
  if(P.App){
    P.App.addListener("appUrlOpen", (ev) => {
      try {
        const m = String(ev.url || "").match(/[#&?]c=([A-Za-z0-9-]{6,20})/);
        if(m){
          localStorage.setItem("torumamo_incoming", m[1]);
          if(typeof 届いたものを受け取る === "function" && typeof 現在のDEK !== "undefined" && 現在のDEK) 届いたものを受け取る();
        }
      } catch(e) {}
    });
    // Android の戻るボタン：モーダルが開いていれば閉じる。最前面なら何もしない（アプリは終了しない）
    P.App.addListener("backButton", () => {
      const 開いている = document.querySelector(".modal-back.show");
      if(開いている){ 開いている.classList.remove("show"); if(開いている.close) 開いている.close(); }
    });
  }
})();
