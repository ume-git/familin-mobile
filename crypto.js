// -*- coding: utf-8 -*-
// ============================================================
// 暗号化・保存まわり（ブラウザ標準の SubtleCrypto / IndexedDB のみを使用。
// 追加ライブラリ・外部通信は一切なし）
//
// 仕組み（1Password の緊急キット・BitLocker の回復キーと同じ考え方）:
//   ・データ本体は「データ暗号化鍵（DEK）」で AES-256-GCM 暗号化する
//   ・DEK 自体は、暗証番号（PIN）から作った鍵と、回復キーから作った鍵の
//     それぞれで別々に暗号化（封筒暗号化）して保存する
//   ・PIN や回復キーそのものは、どこにも保存しない
//   ・鍵の元になる文字列から実際の鍵を作る計算には PBKDF2-SHA256 を
//     60万回繰り返す（2023年頃のOWASP推奨水準）。Argon2id が理想だが、
//     ブラウザ標準の SubtleCrypto では使えないため、追加のライブラリを
//     読み込まずに済む PBKDF2 を採用している。
// ============================================================

const PBKDF2反復回数 = 600000;
const DB名 = "familin_vault_db";
const ストア名 = "vault";

// ---- バイト列 <-> base64（保存用の文字列表現）----
function base64化(buf){
  const bytes = new Uint8Array(buf);
  let 文字列 = "";
  for(let i = 0; i < bytes.length; i++) 文字列 += String.fromCharCode(bytes[i]);
  return btoa(文字列);
}
function base64を戻す(str){
  const 文字列 = atob(str);
  const bytes = new Uint8Array(文字列.length);
  for(let i = 0; i < 文字列.length; i++) bytes[i] = 文字列.charCodeAt(i);
  return bytes;
}

// ---- 鍵の導出（PIN や回復キーの文字列 → 実際に使える鍵）----
async function 鍵を導出する(合言葉, salt){
  const 素材 = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(合言葉), "PBKDF2", false, ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: PBKDF2反復回数, hash: "SHA-256" },
    素材,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

// ---- AES-256-GCM による暗号化・復号（バイト列を直接扱う）----
async function 暗号化する(鍵, 平文バイト){
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const 暗号文 = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, 鍵, 平文バイト);
  return { iv: base64化(iv), data: base64化(暗号文) };
}
async function 復号する(鍵, iv_b64, data_b64){
  const iv = base64を戻す(iv_b64);
  const 平文 = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, 鍵, base64を戻す(data_b64));
  return 平文; // ArrayBuffer
}

// ---- 回復キーの生成（本物のデスクトップ版と同じ書式: XXXX-XXXX-... の24文字）----
function 回復キーを生成する(){
  const 文字 = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 紛らわしい 0/O・1/I・l は除く
  const バイト = crypto.getRandomValues(new Uint8Array(24));
  let 文字列 = "";
  for(let i = 0; i < バイト.length; i++) 文字列 += 文字[バイト[i] % 文字.length];
  return 文字列.match(/.{1,4}/g).join("-");
}

// ============================================================
// IndexedDB（暗号化済みのデータだけを保存する。平文は一切書き込まない）
// ============================================================
function DBを開く(){
  return new Promise((resolve, reject) => {
    const 要求 = indexedDB.open(DB名, 1);
    要求.onupgradeneeded = () => {
      if(!要求.result.objectStoreNames.contains(ストア名)){
        要求.result.createObjectStore(ストア名, { keyPath: "key" });
      }
    };
    要求.onsuccess = () => resolve(要求.result);
    要求.onerror = () => reject(要求.error);
  });
}
async function レコードを読む(key){
  const db = await DBを開く();
  return new Promise((resolve, reject) => {
    const 取引 = db.transaction(ストア名, "readonly");
    const 要求 = 取引.objectStore(ストア名).get(key);
    要求.onsuccess = () => resolve(要求.result || null);
    要求.onerror = () => reject(要求.error);
  });
}
async function レコードを書く(key, 値){
  const db = await DBを開く();
  return new Promise((resolve, reject) => {
    const 取引 = db.transaction(ストア名, "readwrite");
    取引.objectStore(ストア名).put(Object.assign({ key }, 値));
    取引.oncomplete = () => resolve();
    取引.onerror = () => reject(取引.error);
  });
}
async function レコードを削除する(key){
  const db = await DBを開く();
  return new Promise((resolve, reject) => {
    const 取引 = db.transaction(ストア名, "readwrite");
    取引.objectStore(ストア名).delete(key);
    取引.oncomplete = () => resolve();
    取引.onerror = () => reject(取引.error);
  });
}

// ============================================================
// Vault（金庫）としての高レベル操作
// ============================================================

// 初めての暗証番号設定。DEKを新規に作り、PIN・回復キーそれぞれで封をする。
async function 金庫を新規作成する(pin){
  const dek = crypto.getRandomValues(new Uint8Array(32));
  const recoveryKey = 回復キーを生成する();

  const salt_pin = crypto.getRandomValues(new Uint8Array(16));
  const 鍵_pin = await 鍵を導出する(pin, salt_pin);
  const 封_pin = await 暗号化する(鍵_pin, dek);

  const salt_recovery = crypto.getRandomValues(new Uint8Array(16));
  const 鍵_recovery = await 鍵を導出する(recoveryKey, salt_recovery);
  const 封_recovery = await 暗号化する(鍵_recovery, dek);

  await レコードを書く("auth", {
    salt_pin: base64化(salt_pin), 封_pin_iv: 封_pin.iv, 封_pin_data: 封_pin.data,
    salt_recovery: base64化(salt_recovery), 封_recovery_iv: 封_recovery.iv, 封_recovery_data: 封_recovery.data,
  });

  return { dek, recoveryKey };
}

async function 設定済みか(){
  return (await レコードを読む("auth")) !== null;
}

// PINで開く。成功すれば DEK（生バイト）を返す。失敗すれば null。
async function PINで開く(pin){
  const auth = await レコードを読む("auth");
  if(!auth) return null;
  try {
    const salt = base64を戻す(auth.salt_pin);
    const 鍵 = await 鍵を導出する(pin, salt);
    const dek = await 復号する(鍵, auth.封_pin_iv, auth.封_pin_data);
    return new Uint8Array(dek);
  } catch(e) { return null; } // GCMの認証タグ不一致＝暗証番号が違う
}

// 回復キーで開く。成功すれば DEK を返す。
async function 回復キーで開く(recoveryKey){
  const auth = await レコードを読む("auth");
  if(!auth) return null;
  try {
    const salt = base64を戻す(auth.salt_recovery);
    const 鍵 = await 鍵を導出する(recoveryKey, salt);
    const dek = await 復号する(鍵, auth.封_recovery_iv, auth.封_recovery_data);
    return new Uint8Array(dek);
  } catch(e) { return null; }
}

// 回復キーで開いたあと、新しい暗証番号を設定し直す（DEKは変えず、PIN側の封だけ作り直す）
async function PINを再設定する(dek, 新しいpin){
  const auth = await レコードを読む("auth");
  const salt_pin = crypto.getRandomValues(new Uint8Array(16));
  const 鍵_pin = await 鍵を導出する(新しいpin, salt_pin);
  const 封_pin = await 暗号化する(鍵_pin, dek);
  await レコードを書く("auth", Object.assign({}, auth, {
    salt_pin: base64化(salt_pin), 封_pin_iv: 封_pin.iv, 封_pin_data: 封_pin.data,
  }));
}

// 登録データ（項目一覧・家族一覧など）を暗号化して保存する
async function データを保存する(dek, データオブジェクト){
  const 鍵 = await crypto.subtle.importKey("raw", dek, "AES-GCM", false, ["encrypt"]);
  const バイト列 = new TextEncoder().encode(JSON.stringify(データオブジェクト));
  const 暗号 = await 暗号化する(鍵, バイト列);
  await レコードを書く("data", { iv: 暗号.iv, data: 暗号.data });
}

// 登録データを復号して読み出す（未登録なら既定の空データを返す）
async function データを読み込む(dek){
  const レコード = await レコードを読む("data");
  if(!レコード) return { items: [], people: null };
  const 鍵 = await crypto.subtle.importKey("raw", dek, "AES-GCM", false, ["decrypt"]);
  const バイト列 = await 復号する(鍵, レコード.iv, レコード.data);
  return JSON.parse(new TextDecoder().decode(バイト列));
}

// ============================================================
// Face ID・指紋で開く（パスキーの PRF 拡張）
//
// 暗証番号と同じ「本物の暗号」にするための作り：
//   1. 端末にパスキーを1つ作る（Face IDで守られる）
//   2. Face IDに成功したときだけ端末が返す秘密値（PRF）を鍵の材料にして、DEK を包んで保存する
//   3. 開くときは Face ID → 同じ秘密値 → 包みを解いて DEK を得る
// 秘密値はどこにも保存されない。包んだ DEK だけが端末の中にある。
// PRF が使えない機種（iOS 17 以前など）では、この機能は「対応していません」と出す。
// ============================================================
const 生体の合図 = new TextEncoder().encode("torumamo-unlock-v1");

function 生体認証が使えそうか(){
  return !!(window.PublicKeyCredential && navigator.credentials && navigator.credentials.create);
}
async function 生体認証を登録する(dek){
  const userId = crypto.getRandomValues(new Uint8Array(16));
  const 作成 = await navigator.credentials.create({ publicKey: {
    challenge: crypto.getRandomValues(new Uint8Array(32)),
    rp: { name: "トルマモ" },
    user: { id: userId, name: "torumamo", displayName: "トルマモ" },
    pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
    authenticatorSelection: { authenticatorAttachment: "platform", residentKey: "required", userVerification: "required" },
    timeout: 60000,
    extensions: { prf: {} },
  }});
  const 拡張 = 作成.getClientExtensionResults ? 作成.getClientExtensionResults() : {};
  if(!(拡張.prf && 拡張.prf.enabled)) throw new Error("PRF未対応");
  const credId = new Uint8Array(作成.rawId);
  // 作った直後に一度 Face ID を通し、秘密値を得て DEK を包む
  const 秘密 = await 生体の秘密値を取る(credId);
  const 鍵 = await 秘密から鍵を作る(秘密);
  const 封 = await 暗号化する(鍵, dek);
  const auth = await レコードを読む("auth");
  await レコードを書く("auth", Object.assign({}, auth, {
    生体_credId: base64化(credId), 生体_iv: 封.iv, 生体_data: 封.data,
  }));
}
async function 生体の秘密値を取る(credId){
  const 応答 = await navigator.credentials.get({ publicKey: {
    challenge: crypto.getRandomValues(new Uint8Array(32)),
    allowCredentials: [{ type: "public-key", id: credId, transports: ["internal"] }],
    userVerification: "required",
    timeout: 60000,
    extensions: { prf: { eval: { first: 生体の合図 } } },
  }});
  const 拡張 = 応答.getClientExtensionResults ? 応答.getClientExtensionResults() : {};
  const 秘密 = 拡張.prf && 拡張.prf.results && 拡張.prf.results.first;
  if(!秘密) throw new Error("PRF未対応");
  return new Uint8Array(秘密);
}
async function 秘密から鍵を作る(秘密){
  const 素材 = await crypto.subtle.importKey("raw", 秘密, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("torumamo-biometric"), info: new Uint8Array(0) },
    素材, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
  );
}
async function 生体認証が登録済みか(){
  const auth = await レコードを読む("auth");
  return !!(auth && auth.生体_credId);
}
// Face ID で開く。成功すれば DEK、キャンセルや失敗なら null。
async function 生体認証で開く(){
  const auth = await レコードを読む("auth");
  if(!auth || !auth.生体_credId) return null;
  try {
    const 秘密 = await 生体の秘密値を取る(base64を戻す(auth.生体_credId));
    const 鍵 = await 秘密から鍵を作る(秘密);
    const dek = await 復号する(鍵, auth.生体_iv, auth.生体_data);
    return new Uint8Array(dek);
  } catch(e) { return null; }
}
async function 生体認証を解除する(){
  const auth = await レコードを読む("auth");
  if(!auth) return;
  const 残り = Object.assign({}, auth);
  delete 残り.生体_credId; delete 残り.生体_iv; delete 残り.生体_data;
  await レコードを書く("auth", 残り);
}

// 完全初期化（暗証番号・回復キー・登録データすべてを消す）
async function 金庫を初期化する(){
  await レコードを削除する("auth");
  await レコードを削除する("data");
}
