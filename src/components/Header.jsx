import { useState } from 'react';
import { useSelector, useDispatch, useStore } from 'react-redux';
import { LogIn, LogOut, RefreshCw } from 'lucide-react';
import { signInWithGoogle, signOut, isFirebaseConfigured } from '../lib/firebase.js';
import { setAuthError } from '../store/authSlice.js';
import { loadQuotes, loadDailyStats } from '../store/marketSlice.js';
import { syncFromCloud } from '../store/persistence.js';

/**
 * 頂部列：站名、資料重新整理、登入登出。
 */
export default function Header() {
  const dispatch = useDispatch();
  const store = useStore();
  const { user, initializing } = useSelector((s) => s.auth);
  const { watchlist, holdings } = useSelector((s) => s.portfolio);
  const loading = useSelector((s) => s.market.loading);
  const [syncing, setSyncing] = useState(false);

  const allCodes = [...new Set([...watchlist, ...holdings].map((i) => i.code))];
  const isRefreshing = loading.quotes || loading.daily || syncing;

  async function handleLogin() {
    try {
      await signInWithGoogle();
    } catch (err) {
      dispatch(setAuthError(err.message));
    }
  }

  /**
   * 重新整理報價，登入時一併把雲端資料拉下來合併。
   *
   * 雲端原本只在開啟 App 的那一刻同步一次（main.jsx 的 watchAuth → syncFromCloud）。
   * 於是在另一台裝置新增的交易，在已經開著的分頁上永遠不會出現，
   * 使用者唯一的辦法是整頁重新載入——而且沒有任何跡象告訴他該這麼做。
   *
   * 這個按鈕的語意本來就是「重新整理」，把雲端一起拉是一致的，也不必重載整頁。
   */
  async function handleRefresh() {
    if (user?.uid) {
      setSyncing(true);
      try {
        await syncFromCloud(store, user.uid);
      } finally {
        setSyncing(false);
      }
    }
    // 代號要在同步之後重新取得：雲端可能帶回本機還沒有的持股，
    // 沿用同步前的清單會讓那幾檔沒有報價。
    const { watchlist: w, holdings: h } = store.getState().portfolio;
    const codes = [...new Set([...w, ...h].map((i) => i.code))];
    if (codes.length === 0) return;
    dispatch(loadQuotes(codes));
    dispatch(loadDailyStats(codes));
  }

  return (
    <header className="sticky top-0 z-20 border-b border-slate-800 bg-slate-950/90 backdrop-blur">
      <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-3">
        <div className="flex-1">
          <h1 className="text-base font-semibold tracking-tight">台股分析</h1>
          <p className="text-xs text-slate-500">追蹤標的 · 檢視健康度 · 風險預警</p>
        </div>

        <button
          type="button"
          onClick={handleRefresh}
          // 登入時就算一檔都還沒有也要能按：這個按鈕同時負責把雲端資料拉下來。
          disabled={(allCodes.length === 0 && !user) || isRefreshing}
          className="rounded-lg border border-slate-700 p-2 text-sky-400 transition hover:border-sky-600 hover:text-sky-300 disabled:opacity-40"
          title={user ? '重新整理報價，並與雲端資料同步' : '重新整理報價'}
        >
          <RefreshCw size={16} className={isRefreshing ? 'animate-spin' : ''} />
        </button>

        {!isFirebaseConfigured ? (
          <span className="text-xs text-amber-500">本機模式</span>
        ) : initializing ? (
          <span className="text-xs text-slate-500">檢查登入中</span>
        ) : user ? (
          <button
            type="button"
            onClick={() => signOut()}
            className="flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-300 transition hover:border-slate-500 hover:text-white"
          >
            {user.photoURL && (
              <img src={user.photoURL} alt="" className="size-5 rounded-full" referrerPolicy="no-referrer" />
            )}
            <LogOut size={14} className="text-slate-400" />
            登出
          </button>
        ) : (
          <button
            type="button"
            onClick={handleLogin}
            className="flex items-center gap-2 rounded-lg bg-sky-600 px-3 py-2 text-xs font-medium text-white transition hover:bg-sky-500"
          >
            <LogIn size={14} />
            登入
          </button>
        )}
      </div>
    </header>
  );
}
