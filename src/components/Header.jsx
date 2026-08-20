import { useSelector, useDispatch } from 'react-redux';
import { LogIn, LogOut, RefreshCw } from 'lucide-react';
import { signInWithGoogle, signOut, isFirebaseConfigured } from '../lib/firebase.js';
import { setAuthError } from '../store/authSlice.js';
import { loadQuotes, loadDailyStats } from '../store/marketSlice.js';

/**
 * 頂部列：站名、資料重新整理、登入登出。
 */
export default function Header() {
  const dispatch = useDispatch();
  const { user, initializing } = useSelector((s) => s.auth);
  const { watchlist, holdings } = useSelector((s) => s.portfolio);
  const loading = useSelector((s) => s.market.loading);

  const allCodes = [...new Set([...watchlist, ...holdings].map((i) => i.code))];
  const isRefreshing = loading.quotes || loading.daily;

  async function handleLogin() {
    try {
      await signInWithGoogle();
    } catch (err) {
      dispatch(setAuthError(err.message));
    }
  }

  function handleRefresh() {
    if (allCodes.length === 0) return;
    dispatch(loadQuotes(allCodes));
    dispatch(loadDailyStats(allCodes));
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
          disabled={allCodes.length === 0 || isRefreshing}
          className="rounded-lg border border-slate-700 p-2 text-sky-400 transition hover:border-sky-600 hover:text-sky-300 disabled:opacity-40"
          title="重新整理報價"
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
