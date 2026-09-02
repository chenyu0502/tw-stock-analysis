import { useEffect, useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { Sparkles, AlertTriangle, RefreshCw } from 'lucide-react';
import {
  loadHistory,
  loadQuotes,
  loadDailyStats,
  loadInstitutionalHistory,
  loadFundamentals,
  loadExDividend,
  isHistoryStale,
} from '../../store/marketSlice.js';
import { buildAnalysisInput } from '../../lib/analysisInput.js';
import { detectRisks } from '../../lib/risks.js';
import { fetchAnalysis } from '../../services/stockApi.js';
import { DEFAULT_MA } from '../../store/portfolioSlice.js';
import { num, pct, int } from '../../lib/format.js';
import LevelLadder from '../LevelLadder.jsx';
import ValuationBands from '../ValuationBands.jsx';

/**
 * AI 頁：型態分析與支撐壓力區間推估。
 *
 * 價位由 src/lib/levels.js 從歷史資料計算，模型只負責解讀，不產生任何價格數字。
 */
export default function AiTab() {
  const dispatch = useDispatch();
  const { watchlist, holdings } = useSelector((s) => s.portfolio);
  const history = useSelector((s) => s.market.history);
  const quotes = useSelector((s) => s.market.quotes);
  const valuationMap = useSelector((s) => s.market.valuation);
  const institutionalMap = useSelector((s) => s.market.institutional);
  const marginMap = useSelector((s) => s.market.margin);
  const chipHistoryMap = useSelector((s) => s.market.institutionalHistory);
  const fundamentalsMap = useSelector((s) => s.market.fundamentals);
  const loadingFundamentals = useSelector((s) => s.market.loading.fundamentals);
  const exDividendMap = useSelector((s) => s.market.exDividend);

  // 分析頁與持股頁的標的合併成一份清單，同一檔只出現一次。
  const targets = useMemo(() => {
    const map = new Map();
    for (const item of [...holdings, ...watchlist]) {
      if (!map.has(item.code)) map.set(item.code, item);
    }
    return [...map.values()];
  }, [watchlist, holdings]);

  const [code, setCode] = useState('');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // 清單變動時自動選第一檔，使用者不必每次手動挑。
  useEffect(() => {
    if (targets.length > 0 && !targets.some((t) => t.code === code)) {
      setCode(targets[0].code);
    }
  }, [targets, code]);

  const selected = targets.find((t) => t.code === code);

  /**
   * 取得個股中文名稱。
   *
   * 報價、估值、融資融券、法人四個來源都帶有名稱，依序取用。
   * 只靠報價的話，遇到報價尚未載入或該檔當日無報價時就只剩代號，難以辨識。
   */
  const nameOf = useMemo(() => {
    return (target) =>
      quotes[target]?.name ||
      valuationMap[target]?.name ||
      marginMap[target]?.name ||
      institutionalMap[target]?.name ||
      '';
  }, [quotes, valuationMap, marginMap, institutionalMap]);

  // 選單要顯示全部標的的名稱，因此報價與每日資料都對整份清單載入，
  // 而不是只載入目前選中的那一檔。兩者都是單次批次請求，成本很低。
  const allCodesKey = targets.map((t) => t.code).join(',');
  useEffect(() => {
    if (!allCodesKey) return;
    const list = allCodesKey.split(',');
    dispatch(loadQuotes(list));
    dispatch(loadDailyStats(list));
    // 除權息預告是全市場一次取回，不分代號，因此放在這裡只會呼叫一次。
    dispatch(loadExDividend());
  }, [allCodesKey, dispatch]);

  // 歷史 K 線與法人序列的資料量大，只對目前選中的標的載入。
  // 中線判斷需要籌碼面，長線判斷需要估值，缺一模型就無法完成三個週期的判讀。
  useEffect(() => {
    if (!code) return;
    if (isHistoryStale(history[code])) dispatch(loadHistory({ code, range: '1y' }));
    if (!chipHistoryMap[code]) dispatch(loadInstitutionalHistory({ code, days: 30 }));
    // 基本面一檔要打五個 FinMind 資料集，伺服器快取一天，前端也只在未載入時取用。
    if (!fundamentalsMap[code]) dispatch(loadFundamentals({ code }));
  }, [code, history, chipHistoryMap, fundamentalsMap, dispatch]);

  // 切換標的時清掉上一檔的結果，避免看到別檔的分析卻以為是這檔的。
  useEffect(() => {
    setResult(null);
    setError('');
  }, [code]);

  const candles = history[code]?.candles ?? [];

  const input = useMemo(() => {
    if (!selected || candles.length === 0) return null;
    return buildAnalysisInput({
      code,
      name: nameOf(code),
      candles,
      maShort: selected.maShort ?? DEFAULT_MA.short,
      maLong: selected.maLong ?? DEFAULT_MA.long,
      valuation: valuationMap[code],
      institutional: institutionalMap[code],
      chipSeries: chipHistoryMap[code]?.series,
      margin: marginMap[code],
      // 基本面在這裡就壓縮成模型需要的欄位，不把整包回應（含四分位、
      // 十二個月營收序列、六年股利明細）送進提示詞。
      fundamentals: fundamentalsMap[code],
    });
  }, [
    selected,
    candles,
    code,
    nameOf,
    valuationMap,
    institutionalMap,
    chipHistoryMap,
    marginMap,
    fundamentalsMap,
  ]);

  const fundamentals = fundamentalsMap[code] ?? null;

  // 規則型風險清單。純計算，不呼叫 AI，因此不需要按任何按鈕就能顯示。
  const risks = useMemo(
    () =>
      detectRisks({
        fundamentals: fundamentals?.available ? fundamentals : null,
        indicators: input?.indicators,
        recent: input?.recent,
        chips: input?.chips,
        chipSeries: chipHistoryMap[code]?.series ?? [],
        dividendSchedule: exDividendMap[code] ?? null,
      }),
    [fundamentals, input, chipHistoryMap, code, exDividendMap]
  );

  // 送給模型的完整內容。模型只負責敘述，數字在這裡就已經全部定案。
  //
  // 風險清單另外合併進來，因為它要用到 input 的指標，
  // 沒辦法在產生 input 的同一個 useMemo 內自我相依。
  const payload = useMemo(() => (input ? { ...input, risks } : null), [input, risks]);

  async function handleAnalyze() {
    if (!payload) return;
    setLoading(true);
    setError('');
    try {
      const data = await fetchAnalysis(payload);
      setResult(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  if (targets.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-800 py-12 text-center text-sm text-slate-500">
        請先到分析頁或持股頁加入標的
      </div>
    );
  }

  const analysis = result?.analysis;

  return (
    <div className="space-y-4">
      {/* 標的選擇 */}
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={code}
          onChange={(e) => setCode(e.target.value)}
          className="tabular rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm focus:border-sky-600 focus:outline-none"
        >
          {targets.map((t) => (
            <option key={t.code} value={t.code}>
              {nameOf(t.code) ? `${t.code} ${nameOf(t.code)}` : t.code}
            </option>
          ))}
        </select>

        <button
          type="button"
          onClick={handleAnalyze}
          disabled={!payload || loading}
          className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-sky-500 disabled:opacity-40"
        >
          {loading ? <RefreshCw size={15} className="animate-spin" /> : <Sparkles size={15} />}
          {loading ? '分析中…' : result ? '重新分析' : '開始分析'}
        </button>

        {result?.generatedAt && (
          <span className="text-xs text-slate-600">
            產生於 {new Date(result.generatedAt).toLocaleString('zh-TW')}
            {/* 配額用盡或模型退役時會自動改用備援模型，敘述的風格與品質可能不同，
                因此把實際使用的模型顯示出來，而不是讓它默默換掉。 */}
            {result.model && <span className="ml-1.5">· {result.model}</span>}
          </span>
        )}
      </div>

      {!input && candles.length === 0 && (
        <div className="py-8 text-center text-sm text-slate-500">載入歷史資料中…</div>
      )}
      {!input && candles.length > 0 && (
        <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-3 text-xs text-slate-500">
          歷史資料不足 60 個交易日，無法計算價位結構。
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-rose-800/60 bg-rose-950/40 p-3 text-xs text-rose-300">
          {error}
        </div>
      )}

      {result?.available === false && (
        <div className="rounded-lg border border-amber-800/60 bg-amber-950/30 p-3 text-xs text-amber-300">
          {result.reason}
        </div>
      )}

      {/* 價位結構。即使還沒呼叫 AI 也先顯示，這部分是程式算的，不依賴模型。 */}
      {input && (
        <Panel
          title="支撐壓力區間"
          note="價位由歷史資料計算：擺盪轉折點、成交量密集區、均線、區間極值。模型不產生任何價格數字。"
        >
          <LevelLadder levels={input.levels ? { ...input.levels, price: input.price } : null} notes={analysis?.levelNotes} />
        </Panel>
      )}

      {/* 估值與基本面。純計算，不依賴模型，因此不必按「開始分析」就會出現。 */}
      <Panel
        title="估值分位"
        note="以這檔自己近五年的區間為基準，不與其他標的比較。全部由程式計算，不經過 AI。"
      >
        {loadingFundamentals && !fundamentals ? (
          <div className="py-6 text-center text-sm text-slate-500">載入基本面資料中…</div>
        ) : fundamentals?.available === false ? (
          <div className="py-6 text-center text-sm text-slate-500">{fundamentals.reason}</div>
        ) : (
          <ValuationBands bands={fundamentals?.bands} />
        )}
      </Panel>

      {fundamentals?.available && <FundamentalStats data={fundamentals} />}

      <Panel
        title="風險提示"
        note="依固定門檻逐條檢查，每一項都附上觸發的實際數值。不經過 AI，同樣的資料一定得到同樣的結果。"
      >
        {risks.length === 0 ? (
          <div className="py-6 text-center text-sm text-slate-500">
            目前沒有觸發任何風險條件。這不代表沒有風險，只代表這份清單涵蓋的項目都未達門檻。
          </div>
        ) : (
          <ul className="space-y-2">
            {risks.map((item) => (
              <li key={item.id} className="flex gap-2">
                <AlertTriangle
                  size={13}
                  className={`mt-0.5 shrink-0 ${SEVERITY_COLOR[item.severity]}`}
                />
                <div className="min-w-0">
                  <span
                    className={`mr-1.5 rounded px-1 py-0.5 text-[11px] ${SEVERITY_BADGE[item.severity]}`}
                  >
                    {item.category}
                  </span>
                  <span className="text-xs leading-relaxed text-slate-300">{item.message}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {analysis && (
        <>
          <Panel title="型態分析">
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded border border-sky-700/50 bg-sky-950/40 px-2 py-0.5 text-sm text-sky-300">
                  {analysis.pattern.name}
                </span>
                <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[12px] text-slate-400">
                  信心度 {analysis.pattern.confidence}
                </span>
              </div>
              <Field label="目前階段" value={analysis.pattern.stage} />
              <Field label="判定依據" value={analysis.pattern.evidence} />
            </div>
          </Panel>

          {analysis.timeframes && (
            <Panel
              title="短中長線立場"
              note="僅描述各週期的技術面狀態，不含買賣指令、目標價或停損價"
            >
              <div className="space-y-2">
                <TimeframeRow label="短線" span="數日至兩週" data={analysis.timeframes.short} />
                <TimeframeRow label="中線" span="數週至數月" data={analysis.timeframes.medium} />
                <TimeframeRow label="長線" span="數月以上" data={analysis.timeframes.long} />
              </div>
            </Panel>
          )}

          {analysis.valuation && (
            <Panel
              title="估值解讀"
              note="等級描述的是相對於這檔自己歷史區間的水位，不是買賣建議。數字全部取自上方的估值分位，模型不產生任何數值。"
            >
              <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-3">
                <span
                  className={`rounded border px-2 py-0.5 text-xs ${
                    VALUATION_STYLE[analysis.valuation.level] ?? VALUATION_STYLE['資料不足']
                  }`}
                >
                  {analysis.valuation.level}
                </span>
                <p className="mt-1.5 text-xs leading-relaxed text-slate-400">
                  {analysis.valuation.basis}
                </p>
                <p className="mt-1 text-xs leading-relaxed text-sky-400/80">
                  觀察：{analysis.valuation.watch}
                </p>
              </div>
            </Panel>
          )}

          {analysis.riskSummary && (
            <Panel
              title="風險綜述"
              note="把上方依門檻偵測到的風險串成一段，只引用已列出的項目，不新增"
            >
              <p className="text-sm leading-relaxed text-slate-300">{analysis.riskSummary}</p>
            </Panel>
          )}

          <Panel title="關鍵價位">
            <p className="text-sm leading-relaxed text-slate-300">{analysis.keyLevel}</p>
          </Panel>

          <Panel title="情境推演">
            <div className="space-y-2">
              <Field label="突破上方壓力" value={analysis.scenarios.upside} />
              <Field label="跌破下方支撐" value={analysis.scenarios.downside} />
            </div>
          </Panel>

          <Panel title="整體結論">
            <p className="text-sm leading-relaxed text-slate-300">{analysis.summary}</p>
          </Panel>

          <Panel title="AI 判讀的盲點" note="模型自行提出的疑慮，與上方依門檻計算的風險提示不同">
            <ul className="space-y-1.5">
              {analysis.risks.map((risk) => (
                <li key={risk} className="flex gap-2 text-xs leading-relaxed text-slate-400">
                  <AlertTriangle size={13} className="mt-0.5 shrink-0 text-amber-600" />
                  {risk}
                </li>
              ))}
            </ul>
          </Panel>

          <p className="text-[12px] text-slate-600">
            以上為技術面判讀，非投資建議。AI 產出的敘述可能有誤，價位數字請以上方計算結果為準。
          </p>
        </>
      )}
    </div>
  );
}

/**
 * 估值等級的顏色。
 *
 * 刻意不用紅綠：紅漲綠跌在台股是價格方向的慣例，套在估值上會被讀成
 * 「紅色＝好」。估值高低不等於好壞，因此改用中性的琥珀與天藍。
 */
const VALUATION_STYLE = {
  偏高: 'border-amber-500/40 bg-amber-500/10 text-amber-400',
  中性: 'border-slate-600/50 bg-slate-700/20 text-slate-300',
  偏低: 'border-sky-500/40 bg-sky-500/10 text-sky-400',
  資料不足: 'border-slate-700/50 bg-slate-800/40 text-slate-500',
};

/** 風險嚴重度的顏色。沿用警示慣例，與台股漲跌色無關。 */
const SEVERITY_COLOR = {
  high: 'text-rose-500',
  medium: 'text-amber-500',
  low: 'text-slate-500',
};
const SEVERITY_BADGE = {
  high: 'bg-rose-950/60 text-rose-400',
  medium: 'bg-amber-950/60 text-amber-400',
  low: 'bg-slate-800 text-slate-400',
};

/**
 * 獲利能力與財務結構。
 *
 * 每一項都附上「去年同期」作為對照。單一個孤立的毛利率數字看不出好壞，
 * 有了同期比較才知道是在改善還是在惡化。
 */
function FundamentalStats({ data }) {
  const { income, balance, roe, revenue, dividend } = data;
  const margins = income?.margins;
  const marginsAgo = income?.marginsYearAgo;

  // 只列出真的有資料的項目。ETF 沒有財報，把整排「—」擺出來只是佔版面，
  // 還會讓人以為是載入失敗；配息紀錄則是 ETF 唯一也最該看的一項，必須保留。
  const stats = [
    Number.isFinite(income?.epsTtm) && {
      key: 'eps',
      label: '每股盈餘 TTM',
      value: num(income.epsTtm, 2),
    },
    roe && {
      key: 'roe',
      label: '股東權益報酬率',
      value: pct(roe.value, 1),
      sub: roe.averaged ? '期初期末平均' : '期末權益',
    },
    Number.isFinite(margins?.gross) && {
      key: 'gross',
      label: '毛利率',
      value: pct(margins.gross, 1),
      sub: compare(margins.gross, marginsAgo?.gross),
    },
    Number.isFinite(margins?.operating) && {
      key: 'op',
      label: '營業利益率',
      value: pct(margins.operating, 1),
      sub: compare(margins.operating, marginsAgo?.operating),
    },
    Number.isFinite(margins?.net) && {
      key: 'net',
      label: '淨利率',
      value: pct(margins.net, 1),
      sub: compare(margins.net, marginsAgo?.net),
    },
    Number.isFinite(balance?.debtRatio) && {
      key: 'debt',
      label: '負債比',
      value: pct(balance.debtRatio, 1),
      sub: balance.period,
    },
    Number.isFinite(revenue?.yoy) && {
      key: 'revenue',
      label: '月營收年增',
      value: pct(revenue.yoy, 1, true),
      sub: `${revenue.latestMonth}　近三月 ${pct(revenue.yoy3m, 1, true)}`,
    },
    dividend && {
      key: 'dividend',
      label: '現金股利',
      value: num(dividend.latestCash, 2),
      sub:
        `${dividend.latestYear} 年　連續配發 ${int(dividend.consecutiveCashYears)} 年` +
        (Number.isFinite(dividend.payoutRatio) ? `　配發率 ${pct(dividend.payoutRatio, 0)}` : ''),
    },
  ].filter(Boolean);

  if (stats.length === 0) return null;

  return (
    <Panel
      title="獲利與財務結構"
      note={
        income?.latestQuarter
          ? `財報為單季數，最新一期 ${income.latestQuarter}。每股盈餘取近四季合計（TTM）。`
          : '此標的無財報資料，僅顯示可取得的項目'
      }
    >
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {stats.map((s) => (
          <Stat key={s.key} label={s.label} value={s.value} sub={s.sub} />
        ))}
      </div>
    </Panel>
  );
}

/** 與去年同期的差距，用於利潤率的對照文字。 */
function compare(now, before) {
  if (!Number.isFinite(now) || !Number.isFinite(before)) return undefined;
  const diff = now - before;
  const sign = diff > 0 ? '+' : '';
  return `去年同期 ${before.toFixed(1)}%（${sign}${diff.toFixed(1)}）`;
}

function Stat({ label, value, sub }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-2.5">
      <div className="text-[12px] text-slate-500">{label}</div>
      <div className="tabular mt-0.5 text-sm font-semibold text-slate-100">{value}</div>
      {sub && <div className="text-[11px] leading-tight text-slate-600">{sub}</div>}
    </div>
  );
}

function Panel({ title, note, children }) {
  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-3">
      <h3 className="text-sm font-medium text-slate-300">{title}</h3>
      {note && <p className="mb-3 mt-0.5 text-[12px] text-slate-600">{note}</p>}
      <div className={note ? '' : 'mt-3'}>{children}</div>
    </section>
  );
}

/**
 * 各週期立場的顏色。沿用台股紅漲綠跌的慣例，
 * 偏多為紅、偏空為綠，避免與圖表的漲跌色衝突造成誤讀。
 */
const STANCE_STYLE = {
  偏多: 'border-rose-500/40 bg-rose-500/10 text-rose-400',
  偏空: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400',
  中性: 'border-slate-600/50 bg-slate-700/20 text-slate-300',
  觀望: 'border-amber-500/40 bg-amber-500/10 text-amber-400',
};

function TimeframeRow({ label, span, data }) {
  if (!data) return null;
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-slate-200">{label}</span>
        <span className="text-[12px] text-slate-600">{span}</span>
        <span
          className={`rounded border px-2 py-0.5 text-xs ${
            STANCE_STYLE[data.stance] ?? STANCE_STYLE['中性']
          }`}
        >
          {data.stance}
        </span>
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-slate-400">{data.basis}</p>
      <p className="mt-1 text-xs leading-relaxed text-sky-400/80">觀察：{data.watch}</p>
    </div>
  );
}

function Field({ label, value }) {
  return (
    <div>
      <div className="text-[12px] text-slate-500">{label}</div>
      <p className="text-sm leading-relaxed text-slate-300">{value}</p>
    </div>
  );
}
