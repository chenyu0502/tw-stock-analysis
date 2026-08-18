import { useEffect, useState } from 'react';
import { RefreshCw, X } from 'lucide-react';

/** 定時檢查的間隔。太短沒有意義，部署本身就要一兩分鐘。 */
const POLL_INTERVAL_MS = 5 * 60 * 1000;

/**
 * 新版本提示列。
 *
 * 比對編譯進 bundle 的 __BUILD_ID__ 與伺服器上的 version.json，
 * 不同就代表使用者手上這份是舊的。
 *
 * 不自動重新載入，因為使用者可能正在輸入交易紀錄，突然重整會讓輸入到一半的內容消失。
 * 改為顯示提示，由使用者決定何時更新。
 */
export default function UpdateBanner() {
  const [hasUpdate, setHasUpdate] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // 開發模式沒有 version.json，SPA 轉址會讓請求拿到 index.html，不需要檢查。
    if (!import.meta.env.PROD) return undefined;

    let cancelled = false;

    async function check() {
      try {
        // 查詢字串加上時間戳並停用快取，否則檢查本身可能拿到快取的舊版本號。
        const res = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled && data?.buildId && data.buildId !== __BUILD_ID__) {
          setHasUpdate(true);
        }
      } catch {
        // 離線或暫時取不到都不影響使用，靜默略過。
      }
    }

    check();
    const timer = setInterval(check, POLL_INTERVAL_MS);

    // 分頁重新回到前景時立刻檢查一次。使用者放著分頁好幾天再回來看是最常見的情境，
    // 只靠定時檢查會讓他先看到舊畫面。
    const onVisible = () => {
      if (document.visibilityState === 'visible') check();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  if (!hasUpdate || dismissed) return null;

  return (
    <div className="border-b border-sky-800/60 bg-sky-950/60">
      <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-2">
        <span className="flex-1 text-xs text-sky-300">有新版本可用，重新載入後才會套用最新修改。</span>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="flex items-center gap-1.5 rounded bg-sky-600 px-2.5 py-1 text-xs font-medium text-white transition hover:bg-sky-500"
        >
          <RefreshCw size={13} /> 立即更新
        </button>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="rounded p-1 text-sky-500 transition hover:text-sky-300"
          title="稍後再說"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
