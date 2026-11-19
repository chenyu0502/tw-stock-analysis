/**
 * Firebase 初始化。
 *
 * 台股分析以 Claude Flow 的 /stock/ 路徑上線（Claude Flow 用 Vercel rewrite 轉送到這個專案），
 * 與 Claude Flow 同網域、同一個 Firebase 專案，登入狀態因此自動共用。
 * 這裡的設定必須和 Claude Flow 的 src/lib/firebase.ts 完全一致（同一組 VITE_FIREBASE_*、
 * 預設 app 名稱），兩邊才會讀到同一份登入狀態。
 */
import { initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth } from 'firebase/auth';
import { connectFirestoreEmulator, getFirestore } from 'firebase/firestore';

const env = import.meta.env;

/** true 時連線本機 Firebase Emulator（Auth :9099、Firestore :8080），不需要真實專案 */
export const useEmulator = env.VITE_USE_EMULATOR === 'true';

const firebaseConfig = {
  apiKey: env.VITE_FIREBASE_API_KEY || (useEmulator ? 'demo-api-key' : undefined),
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || (useEmulator ? 'demo-claude-flow.firebaseapp.com' : undefined),
  projectId: env.VITE_FIREBASE_PROJECT_ID || (useEmulator ? 'demo-claude-flow' : undefined),
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: env.VITE_FIREBASE_APP_ID,
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

if (useEmulator) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
}
