/**
 * Firebase 初始化與登入、雲端同步。
 *
 * 設定值來自 .env.local。這組值會打包進前端 bundle，本來就是公開資訊，
 * 實際的存取控制由 Firestore 安全規則負責（見 firestore.rules）。
 */

import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  signOut as fbSignOut,
  onAuthStateChanged,
} from 'firebase/auth';
import { getFirestore, doc, getDoc, setDoc } from 'firebase/firestore';

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

/** 環境變數未設定時不初始化，讓應用程式以純本機模式運作而不是整個崩潰。 */
export const isFirebaseConfigured = Boolean(config.apiKey && config.projectId);

const app = isFirebaseConfigured ? initializeApp(config) : null;
export const auth = app ? getAuth(app) : null;
export const db = app ? getFirestore(app) : null;

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
