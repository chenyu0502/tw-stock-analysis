import { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { CandlestickChart } from 'lucide-react';
import { loadMarketIndices } from '../store/marketSlice.js';
import { num, pct, changeColor } from '../lib/format.js';
import IndexKChart from './IndexKChart.jsx';

/** 盤中每分鐘更新一次。指數不像個股需要秒級跳動，一分鐘足夠。 */
const REFRESH_MS = 60 * 1000;

/** 顯示順序固定，加權在前、櫃買在後。 */
const ORDER = ['TAIEX', 'TPEX'];

/**
 * 分析頁最上方的大盤列。
 *
 * 加權指數與櫃買指數並排，各自可用 K 按鈕展開日 K 線圖。
 * 預設收合是刻意的：這一列的作用是「先看一眼大盤」，展開兩張圖會把
 * 下面的自選股清單整個推出畫面外。
 */
export default function MarketIndices() {
  const dispatch = useDispatch();
  const indices = useSelector((s) => s.market.indices);
  const [openId, setOpenId] = useState(null);

  useEffect(() => {
    dispatch(loadMarketIndices({ withCandles: true }));
    // 之後只更新報價。日 K 一天只會多一根，每分鐘重抓一年份是白費頻寬。
    const timer = setInterval(() => dispatch(loadMarketIndices({ withCandles: false })), REFRESH_MS);
    return () => clearInterval(timer);
  }, [dispatch]);

  const list = ORDER.map((id) => indices[id]).filter(Boolean);
  if (list.length === 0) return null;

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-3">
      <div className="grid gap-2 sm:grid-cols-2">
        {list.map((index) => (
          <IndexCard
            key={index.id}
            index={index}
            open={openId === index.id}
            // 一次只開一張圖：兩張並排在手機上各自太窄，堆疊又太長。
            onToggle={() => setOpenId((v) => (v === index.id ? null : index.id))}
          />
        ))}
      </div>

      {list.map((index) =>
        openId === index.id ? (
          <div key={index.id} className="mt-3 border-t border-slate-800 pt-3">
            <div className="mb-1 flex items-baseline gap-2">
              <span className="text-xs text-slate-300">{index.name}日 K</span>
              <span className="text-[10px] text-slate-600">
                指數為證交所即時報價，日 K 收盤後由官方資料校正
              </span>
            </div>
            <IndexKChart candles={index.candles ?? []} />
          </div>
        ) : null
      )}
    </section>
  );
}

/** 單一指數的數字與 K 按鈕。 */
function IndexCard({ index, open, onToggle }) {
  const tone = changeColor(index.change);

  return (
    <div className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/50 px-2.5 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-xs text-slate-400">{index.name}</span>
          {index.time && <span className="text-[10px] text-slate-600">{index.time}</span>}
        </div>
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className={`tabular text-lg font-semibold ${tone}`}>
            {num(index.price, index.price >= 10000 ? 2 : 2)}
          </span>
          <span className={`tabular text-xs ${tone}`}>
            {index.change === null ? '—' : `${index.change > 0 ? '+' : ''}${num(index.change)}`}
          </span>
          <span className={`tabular text-xs ${tone}`}>{pct(index.changePercent, 2, true)}</span>
        </div>
      </div>

      <button
        type="button"
        onClick={onToggle}
        aria-pressed={open}
        title={`${index.name}日 K 線圖`}
        className={`flex shrink-0 items-center gap-1 rounded-lg border px-2 py-1.5 text-xs font-medium transition ${
          open
            ? 'border-sky-500 bg-sky-600 text-white'
            : 'border-slate-700 text-sky-400 hover:border-sky-600 hover:text-sky-300'
        }`}
      >
        <CandlestickChart size={14} />K
      </button>
    </div>
  );
}
