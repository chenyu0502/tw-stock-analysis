import { useEffect, useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { Sparkles, AlertTriangle, RefreshCw } from 'lucide-react';
import {
  loadHistory,
  loadQuotes,
  loadDailyStats,
  loadInstitutionalHistory,
} from '../../store/marketSlice.js';
import { buildAnalysisInput } from '../../lib/analysisInput.js';
import { fetchAnalysis } from '../../services/stockApi.js';
import { DEFAULT_MA } from '../../store/portfolioSlice.js';
import LevelLadder from '../LevelLadder.jsx';

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
  }, [allCodesKey, dispatch]);

  // 歷史 K 線與法人序列的資料量大，只對目前選中的標的載入。
  // 中線判斷需要籌碼面，長線判斷需要估值，缺一模型就無法完成三個週期的判讀。
  useEffect(() => {
    if (!code) return;
    if (!history[code]) dispatch(loadHistory({ code, range: '1y' }));
    if (!chipHistoryMap[code]) dispatch(loadInstitutionalHistory({ code, days: 30 }));
  }, [code, history, chipHistoryMap, dispatch]);

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
    });
  }, [selected, candles, code, nameOf, valuationMap, institutionalMap, chipHistoryMap, marginMap]);

  async function handleAnalyze() {
    if (!input) return;
    setLoading(true);
    setError('');
    try {
      const data = await fetchAnalysis(input);
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
          disabled={!input || loading}
          className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-sky-500 disabled:opacity-40"
        >
          {loading ? <RefreshCw size={15} className="animate-spin" /> : <Sparkles size={15} />}
          {loading ? '分析中…' : result ? '重新分析' : '開始分析'}
        </button>

        {result?.generatedAt && (
          <span className="text-xs text-slate-600">
            產生於 {new Date(result.generatedAt).toLocaleString('zh-TW')}
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

      {analysis && (
        <>
          <Panel title="型態分析">
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded border border-sky-700/50 bg-sky-950/40 px-2 py-0.5 text-sm text-sky-300">
                  {analysis.pattern.name}
                </span>
                <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[11px] text-slate-400">
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

          <Panel title="風險與盲點">
            <ul className="space-y-1.5">
              {analysis.risks.map((risk) => (
                <li key={risk} className="flex gap-2 text-xs leading-relaxed text-slate-400">
                  <AlertTriangle size={13} className="mt-0.5 shrink-0 text-amber-600" />
                  {risk}
                </li>
              ))}
            </ul>
          </Panel>

          <p className="text-[11px] text-slate-600">
            以上為技術面判讀，非投資建議。AI 產出的敘述可能有誤，價位數字請以上方計算結果為準。
          </p>
        </>
      )}
    </div>
  );
}

function Panel({ title, note, children }) {
  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-3">
      <h3 className="text-sm font-medium text-slate-300">{title}</h3>
      {note && <p className="mb-3 mt-0.5 text-[11px] text-slate-600">{note}</p>}
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
        <span className="text-[11px] text-slate-600">{span}</span>
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
      <div className="text-[11px] text-slate-500">{label}</div>
      <p className="text-sm leading-relaxed text-slate-300">{value}</p>
    </div>
  );
}
