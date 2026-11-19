/**
 * Firebase 登入與雲端同步。
 *
 * Firebase 實例在 src/claudeFlow/firebaseApp.js 初始化，設定與 Claude Flow 一致，
 * 兩邊在同一個網域下共用登入狀態。實際的存取控制由 Firestore 安全規則負責。
 */

import {
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  signOut as fbSignOut,
  onAuthStateChanged,
} from 'firebase/auth';
import { doc, getDoc, setDoc, onSnapshot } from 'firebase/firestore';
import { auth, db } from '../claudeFlow/firebaseApp.js';

export { auth, db };

/** Claude Flow 一定會初始化 Firebase（正式專案或 Emulator），保留此旗標供既有程式判斷。 */
export const isFirebaseConfigured = true;

/**
 * Google 登入。優先使用彈窗，被瀏覽器攔截時退回轉址模式。
 * @returns {Promise<import('firebase/auth').User|null>}
 */
export async function signInWithGoogle() {
  if (!auth) throw new Error('Firebase 未設定，無法登入');
  const provider = new GoogleAuthProvider();
  try {
    const result = await signInWithPopup(auth, provider);
    return result.user;
  } catch (err) {
    // Safari 與部分行動瀏覽器會攔截彈窗，這時轉址是唯一可行路徑。
    if (
      err.code === 'auth/popup-blocked' ||
      err.code === 'auth/operation-not-supported-in-this-environment'
    ) {
      await signInWithRedirect(auth, provider);
      return null;
    }
    throw err;
  }
}

/** 登出。 */
export function signOut() {
  if (!auth) return Promise.resolve();
  return fbSignOut(auth);
}

/**
 * 訂閱登入狀態變化。
 * @param {(user: object|null) => void} callback
 * @returns {() => void} 取消訂閱函式
 */
export function watchAuth(callback) {
  if (!auth) {
    callback(null);
    return () => {};
  }
  return onAuthStateChanged(auth, callback);
}

/* ------------------------------------------------------------------ */
/* 雲端資料同步                                                         */
/* ------------------------------------------------------------------ */

/**
 * 讀取使用者的雲端投資組合資料。
 * @param {string} uid
 * @returns {Promise<object|null>}
 */
export async function loadPortfolio(uid) {
  if (!db || !uid) return null;
  const snapshot = await getDoc(doc(db, 'portfolios', uid));
  return snapshot.exists() ? snapshot.data() : null;
}

/**
 * 寫入使用者的雲端投資組合資料。
 * @param {string} uid
 * @param {object} data
 */
export async function savePortfolio(uid, data) {
  if (!db || !uid) return;
  await setDoc(doc(db, 'portfolios', uid), { ...data, updatedAt: Date.now() }, { merge: true });
}

/**
 * 訂閱雲端資料的變更。
 *
 * 這是「另一台裝置改了什麼，這台馬上知道」的來源。沒有它，雲端只在開啟
 * App 的那一刻讀一次，已經開著的分頁會一直停在舊資料，而且畫面上沒有跡象。
 *
 * 回呼的第二個參數為 true 代表這份快照是本機自己剛寫出去、尚未送達伺服器的
 * 樂觀更新。那份內容本來就等於本機現況，套用它沒有意義。
 *
 * @param {string} uid
 * @param {(data: object|null, fromLocalWrite: boolean) => void} onChange
 * @returns {() => void} 取消訂閱
 */
export function watchPortfolio(uid, onChange) {
  if (!db || !uid) return () => {};
  return onSnapshot(
    doc(db, 'portfolios', uid),
    (snapshot) =>
      onChange(snapshot.exists() ? snapshot.data() : null, snapshot.metadata.hasPendingWrites),
    () => {
      // 監聽失敗（離線、權限、額度）不應讓應用程式停擺，本機資料仍然完整可用。
    }
  );
}
