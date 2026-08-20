import { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { Plus, Download, Upload, FileSpreadsheet } from 'lucide-react';
import { addWatch, removeWatch, updateWatch } from '../../store/portfolioSlice.js';
import { loadQuotes, loadDailyStats } from '../../store/marketSlice.js';
import { exportExcel, exportJson, importExcel, importJson, watchlistTemplate } from '../../lib/excel.js';
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

  async function handleImport(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      if (file.name.endsWith('.json')) {
        const data = await importJson(file);
        const items = Array.isArray(data) ? data : (data.watchlist ?? []);
        items.forEach((item) => dispatch(addWatch(item)));
        setMessage(`已匯入 ${items.length} 筆`);
      } else {
        const rows = await importExcel(file);
        let count = 0;
        for (const row of rows) {
          // 欄位名稱容許中英文兩種寫法，降低使用者自製檔案的失敗率。
          const code = String(row['股票代號'] ?? row.code ?? row.Code ?? '').trim();
          if (!/^\d{4,6}[A-Z]?$/.test(code)) continue;
          dispatch(
            addWatch({
              code,
              maShort: Number(row['短均線'] ?? row.maShort) || undefined,
              maLong: Number(row['長均線'] ?? row.maLong) || undefined,
              note: String(row['備註'] ?? row.note ?? ''),
            })
          );
          count += 1;
        }
        setMessage(`已匯入 ${count} 筆`);
      }
    } catch (err) {
      setMessage(`匯入失敗：${err.message}`);
    } finally {
      // 清空 value 才能重複選同一個檔案。
      e.target.value = '';
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-slate-300">
          感興趣標的
          <span className="tabular ml-2 rounded bg-slate-800 px-1.5 py-0.5 text-xs text-slate-400">
            {watchlist.length}
          </span>
        </h2>

        <div className="flex flex-wrap gap-2 text-xs">
          <button
            type="button"
            onClick={() => exportJson({ watchlist }, '感興趣標的.json')}
            className="flex items-center gap-1.5 rounded border border-slate-700 px-2.5 py-1.5 text-slate-300 transition hover:border-slate-500"
          >
            <Download size={13} className="text-sky-400" /> 匯出 JSON
          </button>

          <label className="flex cursor-pointer items-center gap-1.5 rounded border border-slate-700 px-2.5 py-1.5 text-slate-300 transition hover:border-slate-500">
            <Upload size={13} className="text-violet-400" /> 匯入
            <input type="file" accept=".json,.xlsx,.xls,.csv" onChange={handleImport} className="hidden" />
          </label>

          <button
            type="button"
            onClick={() => exportExcel(watchlistTemplate(), '感興趣標的匯入範例.xlsx', '標的清單')}
            className="flex items-center gap-1.5 rounded border border-slate-700 px-2.5 py-1.5 text-slate-300 transition hover:border-slate-500"
          >
            <FileSpreadsheet size={13} className="text-indigo-400" /> 下載範例
          </button>
        </div>
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
