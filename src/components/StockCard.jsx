import { Fragment, useEffect, useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { ChevronDown, ChevronUp, Trash2, Wand2 } from 'lucide-react';
import { loadHistory, loadInstitutionalHistory, isHistoryStale } from '../store/marketSlice.js';
import { today } from '../store/portfolioSlice.js';
import { crossState, kd, macd, rsi, bias, atr, optimizeMaPeriods } from '../lib/indicators.js';
import {
  num,
  pct,
  int,
  changeColor,
  stateColor,
  limitState,
  limitBlockClass,
} from '../lib/format.js';
import { maStances, STANCE_LABEL, compareStanceStrategies } from '../lib/stance.js';
import { detectPattern } from '../lib/patterns.js';
import PriceChart from './PriceChart.jsx';
import InstitutionalChart from './InstitutionalChart.jsx';
import HealthBadge from './HealthBadge.jsx';

/** 法人買賣超歷史的預設查詢天數。 */
const CHIP_DAYS = 30;

/**
 * 單一標的的卡片。收合時顯示報價與訊號摘要，展開後顯示走勢圖與完整指標。
 *
 * @param {{
 *   item: object,
 *   onRemove: (code: string) => void,
 *   onUpdate: (code: string, patch: object) => void,
 *   extra?: import('react').ReactNode,
 *   health?: object|null
 * }} props
 *
 * health 由呼叫端傳入而不是卡片自己算：它需要財報，而財報一檔要打五個 FinMind
 * 資料集。每張卡各自去抓，二十幾張就是上百個上游請求同時送出。
 * 由頁面層的 useHealthScores 統一排隊，卡片只負責顯示。
 */
export default function StockCard({ item, onRemove, onUpdate, extra, health = null }) {
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

  // 歷史 K 線一律載入，因為收合狀態的標題列也要顯示均線攻守狀態。
  //
  // 原本只在展開時才抓，但那讓狀態必須逐張點開才看得到——
  // 持有二十幾檔時等於看不到。整批載入的成本可以接受：
  // 上游是 Yahoo 與證交所，沒有額度限制，伺服器端也有快取。
  //
  // 法人歷史則維持延後載入：那個走 FinMind，免費方案每小時 600 次，
  // 一次替所有卡片抓會很快把額度用掉，而它只有展開時才顯示。
  // 日期放進相依，換日後重新繪製這張卡片時才會補抓，不會一直用昨天的 K 線。
  const day = today();

  useEffect(() => {
    if (isHistoryStale(history)) dispatch(loadHistory({ code: item.code, range: '1y' }));
  }, [history, item.code, day, dispatch]);

  useEffect(() => {
    if (!expanded) return;
    if (!chipHistory) dispatch(loadInstitutionalHistory({ code: item.code, days: CHIP_DAYS }));
  }, [expanded, chipHistory, item.code, dispatch]);

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
      // 二日法則狀態。與 cross 的差別是時序：cross 說「兩條均線誰在上」，
      // 這個說「跌破第幾天、確認了沒有」。
      stances: maStances(candles, item.maShort, item.maLong),
      // 價格型態。由擺盪轉折點推得，與均線狀態互不相干：
      // 一檔可以同時是「跌破確認」與「收斂三角」。
      pattern: detectPattern(candles),
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
  // 漲跌停狀態。漲跌停價由 MIS 直接提供，不自己用前一日收盤推算。
  const limit = limitState(quote);

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
              {/* 漲停紅底、跌停綠底。沒有觸及漲跌停時就是原本的灰色文字，沒有方塊。 */}
              <span
                className={`truncate text-sm ${limitBlockClass(limit)}`}
                title={limit === 'up' ? '漲停' : limit === 'down' ? '跌停' : undefined}
              >
                {name}
              </span>
              {/* 體質燈號緊接名稱。分數與六個面向的拆解在 AI 頁，這裡只給結論。 */}
              <HealthBadge health={health} showScore />
            </div>
            {analysis && (
              <div className="mt-1 flex flex-wrap items-center gap-1">
                <span
                  className={`rounded border px-1.5 py-0.5 text-[12px] ${stateColor(
                    analysis.cross.state
                  )}`}
                >
                  {analysis.cross.label} · {item.maShort}/{item.maLong}MA
                </span>
                <StanceBadge tag="短" data={analysis.stances?.short} />
                <StanceBadge tag="長" data={analysis.stances?.long} />
                {analysis.pattern && analysis.pattern.name !== '型態未明' && (
                  <span
                    className="rounded border border-sky-700/50 bg-sky-950/40 px-1.5 py-0.5 text-[12px] text-sky-300"
                    title={analysis.pattern.evidence}
                  >
                    {analysis.pattern.name}
                  </span>
                )}
              </div>
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
                  className="flex items-center gap-1.5 rounded border border-violet-700 bg-violet-600/20 px-2.5 py-1 text-violet-300 transition hover:bg-violet-600/30 disabled:opacity-40"
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
                  <p className="mt-1.5 text-[12px] text-slate-500">
                    回測期間一年，含手續費與交易稅估算。歷史績效不保證未來結果。
                  </p>
                </div>
              )}

              {/* 二日法則狀態 */}
              {analysis?.stances && (analysis.stances.short || analysis.stances.long) && (
                <div className="mb-3">
                  <h4 className="mb-1.5 text-xs font-medium text-slate-400">型態與攻守</h4>
                  <div className="space-y-1.5">
                    <PatternRow data={analysis.pattern} />
                    <StanceRow tag="短期波動" data={analysis.stances.short} />
                    <StanceRow tag="長期波段" data={analysis.stances.long} />
                  </div>
                  <StanceBacktest candles={candles} periods={[item.maShort, item.maLong]} />
                  <p className="mt-1.5 text-[11px] leading-relaxed text-slate-600">
                    型態由擺盪轉折點的相對位置推得，條件不明確時一律回報「型態未明」，不硬湊。
                    二日法則：收盤穿越均線當天只算警戒，隔日最低（或最高）價再突破前一日，
                    才視為確認，只認收盤價的穿越。
                    兩者都是常見的交易慣例、非經證實的方法；此處只描述狀態，不建議任何動作。
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

              <p className="text-[12px] text-slate-600">
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
/**
 * 二日法則狀態的顏色。
 *
 * 沿用台股紅漲綠跌：站上／突破為紅、跌破為綠。
 * 「跌破未確認」歸為偏多側——那代表跌破沒有成立。
 */
const STANCE_STYLE = {
  up: 'border-rose-500/40 bg-rose-500/10 text-rose-400',
  down: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400',
  flat: 'border-slate-600/50 bg-slate-700/20 text-slate-400',
};

/**
 * 收合狀態的簡短標籤，供整份清單掃視。
 *
 * 持續狀態（均線上／均線下）調暗，剛跌破或剛確認的才用顏色跳出來。
 * 二十幾檔裡多數會停在持續狀態，全部上色等於沒有重點。
 */
/**
 * 價格型態。
 *
 * 與均線狀態互不相干，因此獨立一列：一檔可以同時是「跌破確認」與「收斂三角」，
 * 前者講的是與均線的關係，後者講的是高低點的結構。
 */
function PatternRow({ data }) {
  if (!data) return null;
  const unknown = data.name === '型態未明';
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[12px] text-slate-500">價格型態</span>
        <span
          className={`rounded border px-1.5 py-0.5 text-[12px] ${
            unknown
              ? 'border-slate-700/60 bg-slate-800/40 text-slate-500'
              : 'border-sky-700/50 bg-sky-950/40 text-sky-300'
          }`}
        >
          {data.name}
        </span>
      </div>
      <p className="tabular mt-1 text-[12px] leading-relaxed text-slate-400">{data.evidence}</p>
      {data.note && <p className="mt-0.5 text-[12px] leading-relaxed text-sky-400/70">{data.note}</p>}
    </div>
  );
}

function StanceBadge({ tag, data }) {
  if (!data) return null;
  const meta = STANCE_LABEL[data.state] ?? STANCE_LABEL.UNKNOWN;
  const style = meta.steady ? 'border-slate-700/60 bg-slate-800/40 text-slate-500' : STANCE_STYLE[meta.side];
  return (
    <span className={`rounded border px-1.5 py-0.5 text-[12px] ${style}`} title={data.description}>
      {tag}·{meta.short}
    </span>
  );
}

/**
 * 二日法則的回測對照。
 *
 * **對照組是「單純均線」，不只是買進持有。** 二日法則本質上是在均線訊號上
 * 多加一道確認，要回答的問題是「那道確認有沒有讓結果變好」；
 * 只跟買進持有比，會把均線本身的效果誤算成二日法則的功勞。
 *
 * 回測是同步運算，但資料量只有兩三百根 K 棒、兩個均線週期，
 * 耗時遠低於一次重繪，不需要另外做非同步處理。
 */
function StanceBacktest({ candles, periods }) {
  const results = useMemo(
    () =>
      [...new Set(periods)]
        .map((p) => compareStanceStrategies(candles, p))
        .filter(Boolean),
    [candles, periods]
  );

  if (results.length === 0) return null;

  return (
    <div className="mt-2">
      <div className="text-[12px] text-slate-500">
        回測對照（{results[0].from} 起）
      </div>
      <div className="mt-1 overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="text-slate-600">
              <th className="pb-1 text-left font-normal">均線／做法</th>
              <th className="pb-1 text-right font-normal">報酬率</th>
              <th className="pb-1 text-right font-normal">交易</th>
              <th className="pb-1 text-right font-normal">勝率</th>
              <th className="pb-1 text-right font-normal">最大回檔</th>
              <th className="pb-1 text-right font-normal">持倉比例</th>
            </tr>
          </thead>
          <tbody className="tabular">
            {results.map((r) => (
              <Fragment key={r.period}>
                <tr className="border-t border-slate-800/60">
                  <td className="py-1 text-slate-300">{r.period} 日 · 二日法則</td>
                  <BacktestCells data={r.twoDay} />
                </tr>
                <tr>
                  <td className="py-1 text-slate-500">{r.period} 日 · 單純均線</td>
                  <BacktestCells data={r.plain} />
                </tr>
              </Fragment>
            ))}
            <tr className="border-t border-slate-700">
              <td className="py-1 text-slate-400">買進持有</td>
              <td className={`py-1 text-right ${changeColor(results[0].buyHold)}`}>
                {pct(results[0].buyHold, 1, true)}
              </td>
              <td className="py-1 text-right text-slate-600" colSpan={4}>
                同期間對照
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-slate-600">
        隔日開盤成交，含手續費與證交稅，最大回檔逐日結算。
        關鍵是與「單純均線」相比——那才看得出二日法則的那道確認有沒有加分；
        只跟買進持有比會把均線本身的效果算進來。
        回測僅為歷史統計，不保證未來結果。
      </p>
    </div>
  );
}

function BacktestCells({ data }) {
  return (
    <>
      <td className={`py-1 text-right ${changeColor(data.totalReturn)}`}>
        {pct(data.totalReturn, 1, true)}
      </td>
      <td className="py-1 text-right text-slate-400">{int(data.trades)}</td>
      <td className="py-1 text-right text-slate-400">{pct(data.winRate, 0)}</td>
      <td className="py-1 text-right text-slate-400">{pct(-data.maxDrawdown, 1)}</td>
      <td className="py-1 text-right text-slate-400">{pct(data.exposure, 0)}</td>
    </>
  );
}

function StanceRow({ tag, data }) {
  if (!data) return null;
  const meta = STANCE_LABEL[data.state] ?? STANCE_LABEL.UNKNOWN;
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[12px] text-slate-500">
          {tag}　{data.period} 日均線
        </span>
        <span className={`rounded border px-1.5 py-0.5 text-[12px] ${STANCE_STYLE[meta.side]}`}>
          {meta.label}
        </span>
      </div>
      <p className="tabular mt-1 text-[12px] leading-relaxed text-slate-400">{data.description}</p>
    </div>
  );
}

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
      <div className="text-[12px] text-slate-500">{label}</div>
      <div className={`tabular text-sm ${tone === undefined ? 'text-slate-200' : changeColor(tone)}`}>
        {value}
      </div>
    </div>
  );
}
