import { useEffect, useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { ChevronDown, ChevronUp, Trash2, Wand2 } from 'lucide-react';
import { loadHistory, loadInstitutionalHistory } from '../store/marketSlice.js';
import { crossState, kd, macd, rsi, bias, atr, optimizeMaPeriods } from '../lib/indicators.js';
import { num, pct, int, changeColor, stateColor } from '../lib/format.js';
import PriceChart from './PriceChart.jsx';
import InstitutionalChart from './InstitutionalChart.jsx';

/** 法人買賣超歷史的預設查詢天數。 */
const CHIP_DAYS = 30;

/**
 * 單一標的的卡片。收合時顯示報價與訊號摘要，展開後顯示走勢圖與完整指標。
 *
 * @param {{
 *   item: object,
 *   onRemove: (code: string) => void,
 *   onUpdate: (code: string, patch: object) => void,
 *   extra?: import('react').ReactNode
 * }} props
 */
export default function StockCard({ item, onRemove, onUpdate, extra }) {
  const dispatch = useDispatch();
  const [expanded, setExpanded] = useState(false);
  const [optimizing, setOptimizing] = useState(false);
  const [optimizeResult, setOptimizeResult] = useState(null);

  const quote = useSelector((s) => s.market.quotes[item.code]);
  const history = useSelector((s) => s.market.history[item.code]);
  const valuation = useSelector((s) => s.market.valuation[item.code]);
  const margin = useSelector((s) => s.market.margin[item.code]);
  const institutional = useSelector((s) => s.market.institutional[item.code]);
  const chipHistory = useSelector((s) => s.market.institutionalHistory[item.code]);

  // 展開時才抓歷史資料，避免清單一次載入數十檔造成不必要的流量。
  // 法人歷史走 FinMind，免費方案每小時 600 次，逐檔延後載入才不會浪費額度。
  useEffect(() => {
    if (!expanded) return;
    if (!history) dispatch(loadHistory({ code: item.code, range: '1y' }));
    if (!chipHistory) dispatch(loadInstitutionalHistory({ code: item.code, days: CHIP_DAYS }));
  }, [expanded, history, chipHistory, item.code, dispatch]);

  const candles = history?.candles ?? [];

  const analysis = useMemo(() => {
    if (candles.length < 30) return null;
    const closes = candles.map((c) => c.close);
    const last = candles.length - 1;

    const { k, d } = kd(candles);
    const { dif, signal, histogram } = macd(closes);
    const rsiSeries = rsi(closes);
    const bias5 = bias(closes, 5);
    const bias20 = bias(closes, 20);
    const atrSeries = atr(candles);

    return {
      cross: crossState(closes, item.maShort, item.maLong),
      k: k[last],
      d: d[last],
      dif: dif[last],
      signal: signal[last],
      histogram: histogram[last],
      rsi: rsiSeries[last],
      bias5: bias5[last],
      bias20: bias20[last],
      atr: atrSeries[last],
    };
  }, [candles, item.maShort, item.maLong]);

  /** 執行均線參數回測最佳化並套用結果。 */
  function handleOptimize() {
    if (candles.length < 60) return;
    setOptimizing(true);
    // 回測是同步的密集運算，先讓瀏覽器畫出載入狀態再開始跑。
    setTimeout(() => {
      const { best } = optimizeMaPeriods(candles);
      if (best) {
        onUpdate(item.code, { maShort: best.shortPeriod, maLong: best.longPeriod });
        setOptimizeResult(best);
      }
      setOptimizing(false);
    }, 16);
  }

  const name = quote?.name || valuation?.name || margin?.name || item.code;

  return (
    <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/50">
      {/* 摘要列 */}
      <div className="flex items-center gap-3 p-3">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex flex-1 items-center gap-3 text-left"
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="tabular font-semibold">{item.code}</span>
              <span className="truncate text-sm text-slate-400">{name}</span>
            </div>
            {analysis && (
              <span
                className={`mt-1 inline-block rounded border px-1.5 py-0.5 text-[11px] ${stateColor(
                  analysis.cross.state
                )}`}
              >
                {analysis.cross.label} · {item.maShort}/{item.maLong}MA
              </span>
            )}
          </div>

          <div className="text-right">
            <div className={`tabular text-lg font-semibold ${changeColor(quote?.change)}`}>
              {num(quote?.price)}
            </div>
            <div className={`tabular text-xs ${changeColor(quote?.change)}`}>
              {num(quote?.change)} ({pct(quote?.changePercent, 2, true)})
            </div>
          </div>

          {expanded ? <ChevronUp size={16} className="text-slate-500" /> : <ChevronDown size={16} className="text-slate-500" />}
        </button>

        <button
          type="button"
          onClick={() => onRemove(item.code)}
          className="rounded p-1.5 text-slate-600 transition hover:bg-rose-500/10 hover:text-rose-500"
          title="移除"
        >
          <Trash2 size={15} />
        </button>
      </div>

      {extra}

      {/* 展開區 */}
      {expanded && (
        <div className="space-y-4 border-t border-slate-800 p-3">
          {candles.length === 0 ? (
            <div className="py-8 text-center text-sm text-slate-500">載入歷史資料中…</div>
          ) : (
            <>
              <PriceChart candles={candles} shortPeriod={item.maShort} longPeriod={item.maLong} />

              {/* 均線參數 */}
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <label className="flex items-center gap-1.5 text-slate-400">
                  短均線
                  <input
                    type="number"
                    min="2"
                    max="120"
                    value={item.maShort}
                    onChange={(e) => onUpdate(item.code, { maShort: Number(e.target.value) || 5 })}
                    className="tabular w-16 rounded border border-slate-700 bg-slate-800 px-2 py-1 text-slate-100"
                  />
                </label>
                <label className="flex items-center gap-1.5 text-slate-400">
                  長均線
                  <input
                    type="number"
                    min="5"
                    max="240"
                    value={item.maLong}
                    onChange={(e) => onUpdate(item.code, { maLong: Number(e.target.value) || 60 })}
                    className="tabular w-16 rounded border border-slate-700 bg-slate-800 px-2 py-1 text-slate-100"
                  />
                </label>
                <button
                  type="button"
                  onClick={handleOptimize}
                  disabled={optimizing || candles.length < 60}
                  className="flex items-center gap-1.5 rounded border border-sky-700 bg-sky-600/20 px-2.5 py-1 text-sky-300 transition hover:bg-sky-600/30 disabled:opacity-40"
                >
                  <Wand2 size={13} />
                  {optimizing ? '回測中…' : '回測最佳化'}
                </button>
              </div>

              {optimizeResult && (
                <div className="rounded-lg border border-sky-800/60 bg-sky-950/30 p-2.5 text-xs text-slate-300">
                  <div className="mb-1 font-medium text-sky-300">
                    最佳組合 {optimizeResult.shortPeriod}/{optimizeResult.longPeriod} MA
                  </div>
                  <div className="tabular grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
                    <Stat label="策略報酬" value={pct(optimizeResult.totalReturn, 2, true)} tone={optimizeResult.totalReturn} />
                    <Stat label="買進持有" value={pct(optimizeResult.buyHoldReturn, 2, true)} tone={optimizeResult.buyHoldReturn} />
                    <Stat label="勝率" value={pct(optimizeResult.winRate, 1)} />
                    <Stat label="最大回檔" value={pct(-optimizeResult.maxDrawdown, 2)} />
                  </div>
                  <p className="mt-1.5 text-[11px] text-slate-500">
                    回測期間一年，含手續費與交易稅估算。歷史績效不保證未來結果。
                  </p>
                </div>
              )}

              {/* 技術指標 */}
              {analysis && (
                <Section title="技術指標">
                  <Stat label="KD (9,3,3)" value={`${num(analysis.k, 1)} / ${num(analysis.d, 1)}`} />
                  <Stat label="RSI (14)" value={num(analysis.rsi, 1)} />
                  <Stat label="MACD 柱" value={num(analysis.histogram, 3)} />
                  <Stat label="DIF" value={num(analysis.dif, 3)} />
                  <Stat label="5 日乖離" value={pct(analysis.bias5, 2, true)} tone={analysis.bias5} />
                  <Stat label="20 日乖離" value={pct(analysis.bias20, 2, true)} tone={analysis.bias20} />
                  <Stat label={`${item.maShort}MA`} value={num(analysis.cross.shortMa)} />
                  <Stat label={`${item.maLong}MA`} value={num(analysis.cross.longMa)} />
                  <Stat label="ATR (14)" value={num(analysis.atr)} />
                  <Stat
                    label="ATR 停損參考"
                    value={num(quote?.price && analysis.atr ? quote.price - 2 * analysis.atr : null)}
                  />
                </Section>
              )}

              {/* 基本面 */}
              {valuation && (
                <Section title="估值">
                  <Stat label="本益比" value={num(valuation.peRatio)} />
                  <Stat label="股價淨值比" value={num(valuation.pbRatio)} />
                  <Stat label="現金殖利率" value={pct(valuation.dividendYield)} />
                </Section>
              )}

              {/* 籌碼面 */}
              {(margin || institutional) && (
                <Section title="籌碼面">
                  {institutional && (
                    <>
                      <Stat label="外資 (張)" value={int(institutional.foreign)} tone={institutional.foreign} />
                      <Stat label="投信 (張)" value={int(institutional.trust)} tone={institutional.trust} />
                      <Stat label="自營商 (張)" value={int(institutional.dealer)} tone={institutional.dealer} />
                    </>
                  )}
                  {margin && (
                    <>
                      <Stat label="融資增減 (張)" value={int(margin.marginChange)} tone={margin.marginChange} />
                      <Stat label="融券增減 (張)" value={int(margin.shortChange)} tone={margin.shortChange} />
                      <Stat label="券資比" value={pct(margin.shortMarginRatio)} />
                    </>
                  )}
                </Section>
              )}

              {/* 法人買賣超走勢 */}
              <div>
                <h4 className="mb-2 text-xs font-medium text-slate-400">三大法人買賣超走勢</h4>
                {!chipHistory ? (
                  <div className="py-6 text-center text-sm text-slate-500">載入法人資料中…</div>
                ) : chipHistory.available === false ? (
                  <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-3 text-xs text-slate-500">
                    {chipHistory.reason ?? '無法取得法人歷史資料'}
                  </div>
                ) : (
                  <InstitutionalChart series={chipHistory.series} />
                )}
              </div>

              <p className="text-[11px] text-slate-600">
                以上為技術面與公開資訊整理，非投資建議。
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** 指標分組容器。 */
function Section({ title, children }) {
  return (
    <div>
      <h4 className="mb-2 text-xs font-medium text-slate-400">{title}</h4>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3 lg:grid-cols-5">{children}</div>
    </div>
  );
}

/**
 * 單一數值格。tone 有值時依正負套用漲跌色。
 */
function Stat({ label, value, tone }) {
  return (
    <div>
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className={`tabular text-sm ${tone === undefined ? 'text-slate-200' : changeColor(tone)}`}>
        {value}
      </div>
    </div>
  );
}
