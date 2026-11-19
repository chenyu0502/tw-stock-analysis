import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { onAuthStateChanged } from 'firebase/auth';
import { auth } from './claudeFlow/firebaseApp.js';
import { subscribeUserProfile } from './claudeFlow/userProfile.js';
import { needsEmailVerification } from './claudeFlow/emailVerification.js';
import { store } from './store/index.js';
import { setUser } from './store/authSlice.js';
import { hydrate } from './store/portfolioSlice.js';
import {
  readLocal,
  syncFromCloud,
  subscribeToCloud,
  takeLegacyLocal,
  writeLocal,
} from './store/persistence.js';
import App from './App.jsx';
import DevLogin from './claudeFlow/DevLogin.jsx';
import { claudeFlowRedirectUrl, isStandaloneDev } from './claudeFlow/entry.js';
import './index.css';

/*
 * 台股分析併入 Claude Flow 後的入口（獨立頁面 /stock/）。
 *
 * 登入狀態與 Claude Flow 共用（同網域、同一個 Firebase 實例），
 * 所有登入且未停用的 Claude Flow 使用者都可以使用。每個人的持股存在
 * portfolios/{自己的 uid}，Firestore 規則保證彼此讀不到。
 *
 * 本機資料也按帳號分開存（persistence.js）：同一台電腦換人登入時，
 * 前一個人的持股不會被合併進下一個人的雲端文件。
 *
 * 換帳號的順序很重要（startSync）：先在 auth.user 為 null 的狀態下 hydrate 該帳號的
 * 本機資料（persistence middleware 不寫任何地方），再 setUser，最後 syncFromCloud。
 * 先 setUser 再 hydrate 的話，空的 hydrate 會排進 2 秒後的雲端寫入，可能覆寫雲端持股。
 *
 * 同步的順序沿用原本的設計：先同步再訂閱。初次同步會把本機獨有的資料回寫
 * 雲端，兩者同時進行會讓合併在兩條路徑上交錯，難以推理。
 */

/** @typedef {'checking' | 'signed-out' | 'unverified' | 'denied' | 'disabled' | 'granted'} Access */

let unsubscribeCloud = null;
let unsubscribeProfile = null;
/** 目前已啟動同步的 uid；null 代表沒有同步在跑。 */
let syncingUid = null;

/** @type {Access} */
let access = 'checking';
const accessListeners = new Set();

/** @param {Access} next */
function setAccess(next) {
  access = next;
  accessListeners.forEach((listener) => listener(next));
}

function stopSync() {
  // 登出、換人或被停用時一定要收掉，否則舊帳號的快照會繼續灌進 state。
  unsubscribeCloud?.();
  unsubscribeCloud = null;
  if (syncingUid !== null) {
    syncingUid = null;
    // 先清掉 uid 再清空持股：順序反過來，清空的動作會被當成「這個帳號把持股刪光」寫回去。
    store.dispatch(setUser(null));
    store.dispatch(hydrate({}));
  }
}

/**
 * @param {import('firebase/auth').User} user
 * @param {boolean} isAdmin 只有管理員能接收舊版未分帳號的本機資料
 */
function startSync(user, isAdmin) {
  if (syncingUid === user.uid) return;
  stopSync();
  const { uid } = user;
  syncingUid = uid;

  // 1. 還原這個帳號自己的本機資料（此時 auth.user 是 null，middleware 不會寫任何地方）。
  let local = readLocal(uid);
  if (!local && isAdmin) {
    // 開放前只有管理員能進台股頁，舊版未分帳號的資料一定是管理員的，搬到他的鍵名下。
    local = takeLegacyLocal();
    if (local) writeLocal(uid, local);
  }
  store.dispatch(hydrate(local ?? {}));

  // 2. 標記登入。只傳顯示所需的欄位：整個 Firebase User 物件含方法，會觸發 Redux 的序列化檢查警告。
  store.dispatch(
    setUser({ uid, displayName: user.displayName, email: user.email, photoURL: user.photoURL }),
  );

  // 3. 與雲端合併，完成後再訂閱。
  syncFromCloud(store, uid).then(() => {
    // 同步期間可能又登出、換了帳號或被降級，確認還是同一個人才訂閱。
    if (syncingUid !== uid) return;
    unsubscribeCloud = subscribeToCloud(store, uid);
  });
}

onAuthStateChanged(auth, (user) => {
  unsubscribeProfile?.();
  unsubscribeProfile = null;

  if (!user) {
    stopSync();
    setAccess('signed-out');
    return;
  }

  // Email/密碼註冊但還沒驗證信箱：不啟動同步（Firestore 規則也會拒絕讀寫 portfolios）。
  if (needsEmailVerification(user)) {
    stopSync();
    setAccess('unverified');
    return;
  }

  setAccess('checking');
  unsubscribeProfile = subscribeUserProfile(
    user.uid,
    (profile) => {
      if (profile && !profile.disabled) {
        startSync(user, profile.role === 'admin');
        setAccess('granted');
      } else {
        stopSync();
        // 沒有 Claude Flow 使用者資料（從沒在 Claude Flow 登入過）與被停用，給不同提示。
        setAccess(profile?.disabled ? 'disabled' : 'denied');
      }
    },
    () => {
      stopSync();
      setAccess('denied');
    },
  );
});

function Notice({ title, children }) {
  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="max-w-sm rounded-xl border border-slate-800 bg-slate-900/80 p-6 text-center">
        <h1 className="mb-2 text-lg font-semibold text-slate-100">{title}</h1>
        <p className="mb-5 text-sm text-slate-400">{children}</p>
        <a
          href="/"
          className="inline-block rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-sky-500"
        >
          回 Claude Flow 首頁
        </a>
      </div>
    </div>
  );
}

function Gate() {
  const [current, setCurrent] = useState(access);

  useEffect(() => {
    accessListeners.add(setCurrent);
    setCurrent(access);
    return () => {
      accessListeners.delete(setCurrent);
    };
  }, []);

  const standalone = isStandaloneDev(window.location, import.meta.env.DEV, __STOCK_DEV_PORT__);

  useEffect(() => {
    // 登入頁屬於 Claude Flow，登入後從導覽列的「台股分析」回到這裡。
    // 本機單獨開發台股時沒有 Claude Flow，改顯示開發用登入（見下方）。
    if (current === 'signed-out' && !standalone) window.location.replace('/login');
  }, [current, standalone]);

  if (current === 'signed-out' && standalone) return <DevLogin />;

  if (current === 'granted') {
    return (
      <Provider store={store}>
        <App />
      </Provider>
    );
  }
  if (current === 'disabled') {
    return <Notice title="帳號已停用">你的帳號已被停用，請聯絡管理員。</Notice>;
  }
  if (current === 'unverified') {
    return <Notice title="請先驗證 Email">請到信箱點驗證信中的連結，完成後回 Claude Flow 首頁再開啟台股分析。</Notice>;
  }
  if (current === 'denied') {
    return <Notice title="請先登入 Claude Flow">請從 Claude Flow 首頁登入後，再開啟台股分析。</Notice>;
  }
  return <div className="flex min-h-full items-center justify-center text-sm text-slate-400">載入中…</div>;
}

// 直接打開本專案自己的網址時，轉回 Claude Flow 的同一個路徑（網域不同，登入狀態不共用）。
const redirectTo = claudeFlowRedirectUrl(window.location, import.meta.env.VITE_CLAUDE_FLOW_URL, import.meta.env.PROD);
if (redirectTo) window.location.replace(redirectTo);
else createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Gate />
  </StrictMode>,
);
