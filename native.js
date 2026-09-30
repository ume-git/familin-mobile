// ============================================================
// ストア版（Capacitor で包んだ iPhone / Android アプリ）でだけ動く差し替え。
//
// ブラウザ版（GitHub Pages / PWA）で読み込まれても、最初の判定で抜けるので何もしない。
// index.html の関数は <script> の最上位で宣言されているので、ここで同名の
// グローバルに代入すれば、以降の呼び出しはこちらに切り替わる。
//
// 差し替えるもの
//   1. 通知      … Web Push → 端末の中で予約する通知（サーバー・Firebase を使わない）
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
  // 1. 通知（端末の中で予約する）
  // ------------------------------------------------------------
  // ストア版は、期限の日に合わせて「端末の中」で通知を予約する。サーバーも Firebase も使わない。
  //   ・電波がなくても、アプリを開かなくても届く（iPhone の「ホーム画面に追加」も要らない）
  //   ・登録の中身は端末から出ない。だから通知に名前（例：パスポート）を書ける
  // 予約は、開いたとき・登録を変えたときに毎回作り直す（index.html の 通知の予定を送り直す を差し替え）。
  if(P.LocalNotifications){
    const LN = P.LocalNotifications;
    const 通知の時刻 = 9;          // 朝9時
    const 最大件数 = 60;           // iPhone は予約が64件まで
    let 予約の予約 = null;

    async function 許可されているか(){
      try { const r = await LN.checkPermissions(); return r.display === "granted"; } catch(e){ return false; }
    }
    function 札(d){ return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
    // 日ごとに「何の、あと何日」をまとめる（通知の日々を作る と同じ決まり：警告開始日・前日・当日）
    function 日ごとの知らせ(){
      const 今日 = 札(new Date());
      const 日々 = {};
      (項目一覧を読む() || []).forEach(i => {
        if(!i.expire_date || !/^\d{4}-\d{2}-\d{2}$/.test(i.expire_date)) return;
        const 既定 = 種類の既定値[i.category];
        const 前 = 既定 && 既定.警告開始日数 ? 既定.警告開始日数 : 30;
        const 期限 = new Date(i.expire_date + "T00:00:00");
        [...new Set([前, 1, 0])].forEach(n => {
          const d = new Date(期限); d.setDate(d.getDate() - n);
          const k = 札(d);
          if(k < 今日) return;
          (日々[k] = 日々[k] || []).push({ 名: i.name || i.category || "登録", 残り: n });
        });
      });
      return 日々;
    }
    function 文にする(一覧){
      一覧.sort((a, b) => a.残り - b.残り);
      const 先 = 一覧[0];
      const いつ = 先.残り === 0 ? "今日まで" : 先.残り === 1 ? "明日まで" : "あと" + 先.残り + "日";
      const ほか = 一覧.length > 1 ? " ほか" + (一覧.length - 1) + "件" : "";
      return { title: 先.残り <= 1 ? "期限が迫っています" : "期限が近づいています", body: `${先.名}（${いつ}）${ほか}` };
    }
    async function 予約し直す(){
      if(localStorage.getItem("torumamo_push") !== "1" || !(await 許可されているか())) return;
      // 鍵がかかっている間は登録が読めない（空に見える）。そのまま作り直すと予約が全部消えるので、何もしない
      if(typeof 現在のDEK === "undefined" || !現在のDEK) return;
      try {
        const 今 = await LN.getPending();
        if(今 && 今.notifications && 今.notifications.length) await LN.cancel({ notifications: 今.notifications.map(n => ({ id: n.id })) });
      } catch(e) {}
      const 日々 = 日ごとの知らせ();
      const 今 = Date.now();
      const 予約 = Object.keys(日々).sort().map(k => {
        const [y, m, d] = k.split("-").map(Number);
        const at = new Date(y, m - 1, d, 通知の時刻, 0, 0);
        return { k, at };
      }).filter(x => x.at.getTime() > 今 + 60000).slice(0, 最大件数).map((x, 番) => {
        const 文 = 文にする(日々[x.k]);
        return { id: 1000 + 番, title: 文.title, body: 文.body, schedule: { at: x.at, allowWhileIdle: true } };
      });
      if(予約.length) await LN.schedule({ notifications: 予約 });
    }

    window.通知が使えそうか = function(){ return true; };
    window.今の購読 = async function(){
      return (await 許可されているか()) && localStorage.getItem("torumamo_push") === "1"
        ? { endpoint: "local", toJSON: () => ({ endpoint: "local" }), unsubscribe: async () => true } : null;
    };
    window.通知の予定を送り直す = function(少し待つ){
      clearTimeout(予約の予約);
      予約の予約 = setTimeout(() => { 予約し直す().catch(() => {}); }, 少し待つ ? 3000 : 500);
    };
    window.通知を登録する = async function(){
      let r = await LN.checkPermissions();
      if(r.display !== "granted") r = await LN.requestPermissions();
      if(r.display !== "granted") throw new Error(端末 === "ios"
        ? "通知が許可されませんでした。「設定 → トルマモ → 通知」で許可できます。"
        : "通知が許可されませんでした。端末の「設定 → アプリ → トルマモ → 通知」で許可できます。");
      localStorage.setItem("torumamo_push", "1");
      許可の状態 = "granted";
      await 予約し直す();
      // 動いていることが分かるように、その場で1通（数秒後）
      await LN.schedule({ notifications: [{ id: 999, title: "トルマモ", body: "通知はこのように届きます。期限が近づいたら、朝9時にお知らせします。", schedule: { at: new Date(Date.now() + 3000) } }] });
    };
    window.通知を解除する = async function(){
      try {
        const 今 = await LN.getPending();
        if(今 && 今.notifications && 今.notifications.length) await LN.cancel({ notifications: 今.notifications.map(n => ({ id: n.id })) });
      } catch(e) {}
      localStorage.removeItem("torumamo_push");
    };
    // 通知をタップして開いたときは一覧の先頭へ
    LN.addListener("localNotificationActionPerformed", () => { try { window.scrollTo(0, 0); } catch(e) {} });
    // 設定画面のスイッチは Notification.permission を見るので、端末の状態を写しておく
    window.Notification = window.Notification || {};
    let 許可の状態 = "default";
    Object.defineProperty(window.Notification, "permission", { configurable: true, get: () => 許可の状態 });
    const 状態を写す = async () => { try { const r = await LN.checkPermissions(); 許可の状態 = r.display === "granted" ? "granted" : r.display === "denied" ? "denied" : "default"; } catch(e) {} };
    状態を写す();
    if(P.App) P.App.addListener("resume", () => { 状態を写す(); window.通知の予定を送り直す(); });
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
