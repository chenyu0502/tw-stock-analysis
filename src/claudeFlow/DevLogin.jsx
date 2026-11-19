import { useState } from 'react';
import {
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  updateProfile,
} from 'firebase/auth';
import { doc, getDoc, serverTimestamp, setDoc } from 'firebase/firestore';
import { auth, db, useEmulator } from './firebaseApp.js';

/** Emulator 上的開發帳號（不存在時自動建立） */
export const DEV_ACCOUNT = { email: 'dev@example.com', password: 'password123', displayName: '開發者' };

/**
 * 在 Emulator 上建立開發帳號與 Claude Flow 使用者資料，再登入。
 * 正式環境的使用者資料由 Claude Flow 登入時建立；單獨開發台股時沒有 Claude Flow，
 * 由這裡代為建立（Emulator 沒有載入安全規則，任何讀寫都允許）。
 */
async function signInEmulatorDevAccount() {
  const { email, password, displayName } = DEV_ACCOUNT;
  let cred;
  try {
    cred = await signInWithEmailAndPassword(auth, email, password);
  } catch {
    cred = await createUserWithEmailAndPassword(auth, email, password);
    await updateProfile(cred.user, { displayName });
    // 新帳號還沒驗證 Email，會被驗證那一關擋住。用 Emulator 的管理者權限標成已驗證，
    // 再重新登入一次，拿到 emailVerified = true 的登入狀態與 token。
    const projectId = auth.app.options.projectId;
    const res = await fetch(
      `http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/projects/${projectId}/accounts:update`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
        body: JSON.stringify({ localId: cred.user.uid, emailVerified: true }),
      },
    );
    if (!res.ok) throw new Error(`標記開發帳號為已驗證失敗（HTTP ${res.status}）`);
    await signOut(auth);
    cred = await signInWithEmailAndPassword(auth, email, password);
  }
  const ref = doc(db, 'users', cred.user.uid);
  if (!(await getDoc(ref)).exists()) {
    await setDoc(ref, {
      uid: cred.user.uid,
      email,
      displayName,
      photoURL: null,
      role: 'admin',
      disabled: false,
      providers: ['password'],
      createdAt: serverTimestamp(),
      lastLoginAt: serverTimestamp(),
    });
  }
}

/**
 * 本機單獨開發台股用的登入畫面（只在 vite dev 出現，正式環境一律導向 Claude Flow 的 /login）。
 * - Emulator：一鍵登入開發帳號（建立時自動標成已驗證 Email）。
 * - 真實 Firebase：Google 登入。帳號要先在 Claude Flow 登入過一次，才有使用者資料。
 */
export default function DevLogin() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function handleClick() {
    setBusy(true);
    setError(null);
    try {
      if (useEmulator) await signInEmulatorDevAccount();
      else await signInWithPopup(auth, new GoogleAuthProvider());
    } catch (err) {
      setError(err?.message ?? String(err));
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="max-w-sm rounded-xl border border-slate-800 bg-slate-900/80 p-6 text-center">
        <h1 className="mb-2 text-lg font-semibold text-slate-100">開發模式登入</h1>
        <p className="mb-5 text-sm text-slate-400">
          {useEmulator
            ? `以 Emulator 開發帳號 ${DEV_ACCOUNT.email} 登入（不存在會自動建立，角色為管理員）。`
            : '以 Google 登入真實的 Firebase 專案。帳號需先在 Claude Flow 登入過一次。'}
        </p>
        {error && <p className="mb-4 text-sm text-rose-400">{error}</p>}
        <button
          type="button"
          onClick={handleClick}
          disabled={busy}
          className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-sky-500 disabled:opacity-50"
        >
          {busy ? '登入中…' : useEmulator ? '登入開發帳號' : '以 Google 登入'}
        </button>
      </div>
    </div>
  );
}
