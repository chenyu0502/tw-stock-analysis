import { useCallback, useEffect, useState } from 'react';
import { useSelector, useDispatch, useStore } from 'react-redux';
import { LogIn, LogOut, RefreshCw } from 'lucide-react';
import { signInWithGoogle, signOut, isFirebaseConfigured } from '../lib/firebase.js';
import { setAuthError } from '../store/authSlice.js';
import { loadQuotes, loadDailyStats } from '../store/marketSlice.js';
import { syncFromCloud } from '../store/persistence.js';
import { isMarketDataWindow } from '../lib/marketHours.js';

/** 自動重新整理的間隔。 */
const AUTO_REFRESH_MS = 5 * 60 * 1000;

/**
 * 頂部列：站名、資料重新整理、登入登出。
 */
export default function Header() {
  const dispatch = useDispatch();
  const store = useStore();
  const { user, initializing } = useSelector((s) => s.auth);
  const { watchlist, holdings } = useSelector((s) => s.portfolio);
  const loading = useSelector((s) => s.market.loading);
  const lastQuoteAt = useSelector((s) => s.market.lastQuoteAt);
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
   * 重抓報價與每日資料。手動按鈕與自動更新共用同一條路徑。
   *
   * 代號一律從 store 當下讀取，不用 render 當時的閉包值：手動路徑會先同步雲端，
   * 而雲端可能帶回本機還沒有的持股，沿用同步前的清單會讓那幾檔沒有報價。
   */
  const refreshMarketData = useCallback(() => {
    const { watchlist: w, holdings: h } = store.getState().portfolio;
    const codes = [...new Set([...w, ...h].map((i) => i.code))];
    if (codes.length === 0) return;
    dispatch(loadQuotes(codes));
    dispatch(loadDailyStats(codes));
  }, [store, dispatch]);

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
    refreshMarketData();
  }

  /**
   * 每五分鐘自動重抓一次。
   *
   * 三個刻意的限制：
   *
   * 1. **不做雲端同步。** main.jsx 已經以 onSnapshot 訂閱雲端，變更本來就會即時推送，
   *    自動路徑再抓一次只是多付 Firestore 讀取，換不到任何新資料。
   *    手動按鈕保留同步，那是使用者明確要求「把所有東西弄到最新」的動作。
   * 2. **分頁在背景時跳過。** 手機把分頁放著不管是常態，背景分頁持續打上游
   *    既耗電也耗流量，而使用者根本看不到結果。
   * 3. **非交易時段跳過。** 收盤後數字不會再變，整晚每五分鐘一次就是上百次
   *    無謂請求。判定見 isMarketDataWindow。
   *
   * 回到前景時補一次，但要距上次更新超過一個間隔才做——否則在分頁之間來回切換
   * 會變成每切一次就打一次上游。
   */
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState !== 'visible') return;
      if (!isMarketDataWindow()) return;
      refreshMarketData();
    };

    const timer = setInterval(tick, AUTO_REFRESH_MS);

    const onVisible = () => {
      const last = store.getState().market.lastQuoteAt;
      if (last && Date.now() - last < AUTO_REFRESH_MS) return;
      tick();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refreshMarketData, store]);

  return (
    <header className="sticky top-0 z-20 border-b border-slate-800 bg-slate-950/90 backdrop-blur">
      <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-3">
        <div className="flex-1">
          <h1 className="text-base font-semibold tracking-tight">台股分析</h1>
          {/* 有了自動更新之後，「資料是什麼時候的」變成必須看得到的資訊：
              非交易時段會跳過更新，畫面上的數字停著不動是正常行為，
              但少了這個時間戳就分不出那是正常還是壞掉。
              標語只在還沒取過報價時顯示，兩者共用同一行，不動版面高度。 */}
          <p className="text-xs text-slate-500">
            {lastQuoteAt
              ? `報價更新於 ${new Date(lastQuoteAt).toLocaleTimeString('zh-TW', {
                  hour: '2-digit',
                  minute: '2-digit',
                })}`
              : '追蹤標的 · 檢視健康度 · 風險預警'}
          </p>
        </div>

        <button
          type="button"
          onClick={handleRefresh}
          // 登入時就算一檔都還沒有也要能按：這個按鈕同時負責把雲端資料拉下來。
          disabled={(allCodes.length === 0 && !user) || isRefreshing}
          className="rounded-lg border border-slate-700 p-2 text-sky-400 transition hover:border-sky-600 hover:text-sky-300 disabled:opacity-40"
          title={
            user
              ? '重新整理報價，並與雲端資料同步（交易時段每五分鐘自動更新報價）'
              : '重新整理報價（交易時段每五分鐘自動更新）'
          }
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
