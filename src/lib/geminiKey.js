/**
 * 使用者自己的 Gemini API 金鑰。
 *
 * 台股的 AI 解讀開放給所有登入的使用者後，每個人要用自己的金鑰（費用與額度算在各自帳上）。
 * 金鑰只存在這台瀏覽器的 localStorage，並按帳號分開（鍵名帶 uid），同一台電腦換人登入不會互用。
 * 送出 AI 分析時以 X-Gemini-Key 標頭交給自家 /api/analyze，由伺服器轉給 Google，不會被儲存。
 */

import { auth } from './firebase.js';

const KEY_PREFIX = 'tw-stock-gemini-key';

/** 與伺服器端（api/_lib/auth.js 的 readGeminiKey）相同的格式檢查 */
export const GEMINI_KEY_PATTERN = /^[A-Za-z0-9_-]{20,200}$/;

function storageKey(uid) {
  return `${KEY_PREFIX}:${uid}`;
}

function currentUid() {
  return auth?.currentUser?.uid ?? null;
}

/** 目前登入者的金鑰；沒有設定、未登入或 localStorage 無法使用時回傳空字串。 */
export function getGeminiKey(uid = currentUid()) {
  if (!uid) return '';
  try {
    return localStorage.getItem(storageKey(uid)) || '';
  } catch {
    return '';
  }
}

/**
 * 儲存目前登入者的金鑰（空字串代表移除）。
 * @returns {boolean} 是否成功寫入（無痕模式等情況可能失敗）
 */
export function setGeminiKey(value, uid = currentUid()) {
  if (!uid) return false;
  try {
    const trimmed = value.trim();
    if (trimmed) localStorage.setItem(storageKey(uid), trimmed);
    else localStorage.removeItem(storageKey(uid));
    return true;
  } catch {
    return false;
  }
}

/** 顯示用：只露出末四碼 */
export function maskGeminiKey(key) {
  return key ? `••••••••${key.slice(-4)}` : '';
}
