import { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { Plus } from 'lucide-react';
import MarketIndices from '../MarketIndices.jsx';
import { addWatch, removeWatch, updateWatch } from '../../store/portfolioSlice.js';
import { loadQuotes, loadDailyStats } from '../../store/marketSlice.js';
import StockCard from '../StockCard.jsx';

/** 報價自動更新間隔。台股盤中每 30 秒更新一次已足夠，過於頻繁只是浪費上游額度。 */
const QUOTE_REFRESH_MS = 30_000;

/**
 * 分析頁：管理感興趣標的清單。
 */
export default function AnalysisTab() {
  const dispatch = useDispatch();
  const watchlist = useSelector((s) => s.portfolio.watchlist);
  const [input, setInput] = useState('');
  const [message, setMessage] = useState('');

  const codes = watchlist.map((w) => w.code);
  const codesKey = codes.join(',');

  // 清單異動時重新取價，並在盤中定時更新。
  useEffect(() => {
    if (!codesKey) return undefined;
    const list = codesKey.split(',');
    dispatch(loadQuotes(list));
    dispatch(loadDailyStats(list));
    const timer = setInterval(() => dispatch(loadQuotes(list)), QUOTE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [codesKey, dispatch]);

  function handleAdd(e) {
    e.preventDefault();
    const code = input.trim();
    if (!/^\d{4,6}[A-Z]?$/.test(code)) {
      setMessage('代號格式不正確，請輸入 4 到 6 位數字（例如 2330）');
      return;
    }
    if (codes.includes(code)) {
      setMessage(`${code} 已在清單中`);
      return;
    }
    dispatch(addWatch({ code }));
    setInput('');
    setMessage('');
  }


  return (
    <div className="space-y-4">
      {/* 大盤放最上面：看自選股之前先知道今天整體是什麼行情。 */}
      <MarketIndices />

      {/* 匯出、匯入、下載範例都在持股頁。感興趣標的用打字新增就夠快，
          它沒有成本與股數這類需要備份的數字。 */}
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-medium text-slate-300">
          感興趣標的
          <span className="tabular ml-2 rounded bg-slate-800 px-1.5 py-0.5 text-xs text-slate-400">
            {watchlist.length}
          </span>
        </h2>
      </div>

      <form onSubmit={handleAdd} className="flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="輸入股票代號，例如 2330"
          inputMode="numeric"
          className="tabular flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm placeholder:text-slate-600 focus:border-sky-600 focus:outline-none"
        />
        <button
          type="submit"
          className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-sky-500"
        >
          <Plus size={15} /> 新增
        </button>
      </form>

      {message && <p className="text-xs text-amber-500">{message}</p>}

      {watchlist.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-800 py-12 text-center text-sm text-slate-500">
          尚未加入任何標的
        </div>
      ) : (
        <div className="space-y-2">
          {watchlist.map((item) => (
            <StockCard
              key={item.code}
              item={item}
              onRemove={(code) => dispatch(removeWatch(code))}
              onUpdate={(code, patch) => dispatch(updateWatch({ code, patch }))}
            />
          ))}
        </div>
      )}
    </div>
  );
}
