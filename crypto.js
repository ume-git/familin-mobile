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

// 完全初期化（暗証番号・回復キー・登録データすべてを消す）
async function 金庫を初期化する(){
  await レコードを削除する("auth");
  await レコードを削除する("data");
}
