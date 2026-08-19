import { useMemo } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { RefreshCw } from 'lucide-react';
import { loadFundamentals } from '../store/marketSlice.js';
import { num, pct } from '../lib/format.js';
import { THRESHOLDS } from '../lib/risks.js';

/**
 * 全部位估值檢視。
 *
 * 個股卡片與 AI 頁已經有單檔的分位帶，這裡回答的是不同的問題：
 * **手上哪幾檔相對自己的歷史偏貴。** 二十幾檔逐一點開比較不現實。
 *
 * 一律用分位而非絕對值。本益比 27 倍與 16 倍不能直接比——不同產業的合理區間
 * 天差地遠；但「高於自己過去五年的 77%」與「45%」則是同一個尺度，排得出高低。
 *
 * **ETF 沒有本益比、股價淨值比與殖利率資料**，兩個上游都沒有。
 * 這一點必須在畫面上講明，否則持股以 ETF 為主的人會以為資料掉了。
 */
export default function ValuationOverview({ holdings }) {
  const dispatch = useDispatch();
  const fundamentalsMap = useSelector((s) => s.market.fundamentals);
  const quotes = useSelector((s) => s.market.quotes);
  const valuationMap = useSelector((s) => s.market.valuation);
  const loading = useSelector((s) => s.market.loading.fundamentals);

  const { rows, noData, pending } = useMemo(() => {
    const list = [];
    const without = [];
    let notLoaded = 0;

    for (const h of holdings) {
      const f = fundamentalsMap[h.code];
      if (!f) {
        notLoaded += 1;
        continue;
      }
      const pe = f.bands?.pe;
      const pb = f.bands?.pb;
      const dy = f.bands?.dividendYield;
      if (!pe && !pb && !dy) {
        without.push(h.code);
        continue;
      }
      list.push({
        code: h.code,
        name: quotes[h.code]?.name || valuationMap[h.code]?.name || '',
        pe,
        pb,
        dy,
        // 以本益比分位排序；沒有本益比的用股價淨值比遞補，兩者皆無則排最後。
        sortKey: pe?.percentile ?? pb?.percentile ?? -1,
      });
    }

    list.sort((a, b) => b.sortKey - a.sortKey);
    return { rows: list, noData: without, pending: notLoaded };
  }, [holdings, fundamentalsMap, quotes, valuationMap]);

  return (
    <div>
      {rows.length > 0 && (
        <div className="space-y-2">
          {rows.map((row) => (
            <div key={row.code} className="rounded-lg border border-slate-800 bg-slate-900/50 p-2">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="tabular text-sm font-medium text-slate-200">{row.code}</span>
                {row.name && <span className="text-xs text-slate-500">{row.name}</span>}
              </div>
              <div className="mt-1.5 space-y-1">
                <PercentileRow label="本益比" band={row.pe} digits={1} suffix=" 倍" higherIsExpensive />
                <PercentileRow label="股價淨值比" band={row.pb} digits={2} suffix=" 倍" higherIsExpensive />
                <PercentileRow label="現金殖利率" band={row.dy} digits={2} suffix="%" />
              </div>
            </div>
          ))}
        </div>
      )}

      {rows.length === 0 && pending === 0 && (
        <p className="py-4 text-center text-sm text-slate-500">
          持股中沒有具估值歷史的標的。
        </p>
      )}

      {pending > 0 && (
        <button
          type="button"
          onClick={() =>
            holdings
              .filter((h) => !fundamentalsMap[h.code])
              .forEach((h) => dispatch(loadFundamentals({ code: h.code })))
          }
          disabled={loading}
          className="mt-2 flex items-center gap-1.5 rounded border border-sky-700 bg-sky-600/20 px-2.5 py-1 text-[11px] text-sky-300 transition hover:bg-sky-600/30 disabled:opacity-40"
        >
          {loading ? <RefreshCw size={12} className="animate-spin" /> : null}
          {loading ? '載入中…' : `載入 ${pending} 檔的估值資料`}
        </button>
      )}

      <p className="mt-2 text-[10px] leading-relaxed text-slate-600">
        分位為「目前值高於過去多少比例的交易日」，以各標的自己近五年的區間為基準，不與其他標的比較。
        本益比與股價淨值比的分位越高代表越貴；殖利率相反，分位越高代表相對便宜。
        分位超過 {THRESHOLDS.pePercentileHigh}% 的以琥珀色標出。
        介面只陳述位置，不下「偏貴」「便宜」的結論——那是投資判斷。
        {noData.length > 0 &&
          `　另有 ${noData.length} 檔無估值資料（ETF 沒有本益比、股價淨值比與殖利率，兩個上游都沒有）：${noData.join('、')}。`}
      </p>
    </div>
  );
}

/**
 * 單一指標的分位條。
 *
 * 用實際區間的最小到最大值當軌道，標出目前值的位置與中位數。
 * 只給一個百分比數字看不出「離中位數多遠」，而那正是判斷的重點。
 */
function PercentileRow({ label, band, digits, suffix, higherIsExpensive = false }) {
  if (!band) {
    return (
      <div className="flex items-center gap-2">
        <span className="w-16 shrink-0 text-[11px] text-slate-600">{label}</span>
        <span className="text-[11px] text-slate-600">無資料</span>
      </div>
    );
  }

  const { current, min, max, median, percentile } = band;
  const posOf = (v) => (max > min ? ((v - min) / (max - min)) * 100 : 50);
  // 偏貴的那一端用琥珀色。殖利率的方向相反，高分位反而是便宜。
  const hot = higherIsExpensive
    ? percentile >= THRESHOLDS.pePercentileHigh
    : percentile <= 100 - THRESHOLDS.pePercentileHigh;

  return (
    <div className="flex items-center gap-2">
      <span className="w-16 shrink-0 text-[11px] text-slate-500">{label}</span>
      <span className="tabular w-16 shrink-0 text-right text-[11px] text-slate-300">
        {num(current, digits)}
        {suffix}
      </span>
      <div className="relative h-3 flex-1">
        <div className="absolute inset-x-0 top-1 h-1 rounded bg-slate-800" />
        <div
          className="absolute top-0.5 h-2 w-px bg-slate-500"
          style={{ left: `${posOf(median)}%` }}
          title={`中位數 ${num(median, digits)}${suffix}`}
        />
        <div
          className={`absolute top-0 h-3 w-0.5 rounded ${hot ? 'bg-amber-400' : 'bg-sky-400'}`}
          style={{ left: `${posOf(current)}%` }}
          title={`目前 ${num(current, digits)}${suffix}`}
        />
      </div>
      <span
        className={`tabular w-14 shrink-0 text-right text-[11px] ${hot ? 'text-amber-400' : 'text-slate-400'}`}
      >
        {pct(percentile, 1)}
      </span>
    </div>
  );
}
