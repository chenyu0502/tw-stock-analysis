import { useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { AlertTriangle, RefreshCw, ScanLine, Layers, Activity, Scale } from 'lucide-react';
import { loadFundamentals } from '../store/marketSlice.js';
import { isEtf } from '../lib/fees.js';
import { detectRisks, SEVERITY } from '../lib/risks.js';
import { buildAnalysisInput } from '../lib/analysisInput.js';
import { today as todayDate, DEFAULT_MA } from '../store/portfolioSlice.js';
import ScanPanel from './ScanPanel.jsx';
import MarginTable from './MarginTable.jsx';
import StanceOverview from './StanceOverview.jsx';
import ValuationOverview from './ValuationOverview.jsx';

/** 嚴重度的顏色，與 AI 頁的風險清單一致。 */
const SEVERITY_COLOR = { high: 'text-rose-500', medium: 'text-amber-500', low: 'text-slate-500' };
const SEVERITY_BADGE = {
  high: 'bg-rose-950/60 text-rose-400',
  medium: 'bg-amber-950/60 text-amber-400',
  low: 'bg-slate-800 text-slate-400',
};

/** 融資融券相關的規則 id，用來把觸發項目分派到對應的面板。 */
const MARGIN_RULE_IDS = new Set([
  'margin-surge',
  'short-surge',
  'margin-short-both-up',
  'margin-up-short-down',
  'short-cover',
  'short-margin',
]);

/** 估值分位相關的規則，改由估值檢視面板呈現，不再混進其餘規則。 */
const VALUATION_RULE_IDS = new Set(['pe-high', 'pb-high']);

/**
 * 掃描範圍。
 *
 * **預設是股票。** 估值檢視與其餘規則裡的財報條目對 ETF 不適用——
 * ETF 沒有本益比、股價淨值比與財報。混在一起掃，估值面板會出現一整排
 * 「無資料」，真正該看的個股被稀釋掉，還會白白多打好幾次基本面查詢。
 *
 * **不適用的只有估值與財報那一塊。** 台股 ETF 一樣可以信用交易，
 * 融資融券面板對 ETF 有效；型態與攻守、技術面與除息規則也都適用。
 * 選 ETF 或全部因此是有意義的，不是聊備一格。
 */
const SCOPES = [
  { id: 'all', label: '全部' },
  { id: 'stock', label: '股票' },
  { id: 'etf', label: 'ETF' },
];

/**
 * 持股頁的批次掃描區。
 *
 * 拆成三個主題面板而不是一張大清單。混在一起時「本益比分位過高」與「融券暴增」
 * 會並排出現，但那是兩件性質完全不同的事，看的時機也不同。
 *
 * 規則型偵測原本只在 AI 頁的單一標的上跑，持有二十幾檔時等於看不到——
 * 沒有人會為了確認有沒有觸發規則而一檔一檔點開。
 *
 * 每個面板都在標題列就給結論，內容預設收合，只有真的有觸發時才自動展開。
 *
 * 掃描範圍可切換股票／ETF／全部，四個面板一起套用。這不只是顯示上的篩選——
 * 基本面要一檔一檔查（一檔五個資料集），限縮範圍等於少打好幾次上游。
 *
 * @param {{ holdings: object[] }} props
 */
export default function RiskScan({ holdings }) {
  const dispatch = useDispatch();
  const [scope, setScope] = useState('stock');
  const history = useSelector((s) => s.market.history);
  const quotes = useSelector((s) => s.market.quotes);
  const marginMap = useSelector((s) => s.market.margin);
  const institutionalMap = useSelector((s) => s.market.institutional);
  const valuationMap = useSelector((s) => s.market.valuation);
  const fundamentalsMap = useSelector((s) => s.market.fundamentals);
  const exDividend = useSelector((s) => s.market.exDividend);
  const loadingFundamentals = useSelector((s) => s.market.loading.fundamentals);

  /** 各範圍的檔數，直接標在按鈕上，切換前就知道會掃到幾檔。 */
  const counts = useMemo(() => {
    const etf = holdings.filter((h) => isEtf(h.code)).length;
    return { all: holdings.length, etf, stock: holdings.length - etf };
  }, [holdings]);

  const scoped = useMemo(() => {
    if (scope === 'all') return holdings;
    const wantEtf = scope === 'etf';
    return holdings.filter((h) => isEtf(h.code) === wantEtf);
  }, [holdings, scope]);

  const rows = useMemo(() => {
    const day = todayDate();
    return scoped
      .map((h) => {
        const candles = history[h.code]?.candles ?? [];
        // buildAnalysisInput 需要六十根以上才算得出價位結構，不足就只跑不依賴它的規則。
        const input =
          candles.length >= 60
            ? buildAnalysisInput({
                code: h.code,
                candles,
                maShort: h.maShort ?? DEFAULT_MA.short,
                maLong: h.maLong ?? DEFAULT_MA.long,
                valuation: valuationMap[h.code],
                institutional: institutionalMap[h.code],
                margin: marginMap[h.code],
              })
            : null;

        const fundamentals = fundamentalsMap[h.code];
        const risks = detectRisks({
          fundamentals: fundamentals?.available ? fundamentals : null,
          indicators: input?.indicators,
          recent: input?.recent,
          margin: marginMap[h.code],
          dividendSchedule: exDividend[h.code] ?? null,
          today: day,
        });

        return {
          code: h.code,
          name: quotes[h.code]?.name || marginMap[h.code]?.name || '',
          risks,
        };
      })
      .filter((r) => r.risks.length > 0);
  }, [
    scoped,
    history,
    quotes,
    marginMap,
    institutionalMap,
    valuationMap,
    fundamentalsMap,
    exDividend,
  ]);

  /** 依規則類別分派到面板。同一檔可能同時出現在兩個面板，那是正常的。 */
  const split = useMemo(() => {
    const pick = (keep) =>
      rows
        .map((r) => ({ ...r, risks: r.risks.filter(keep) }))
        .filter((r) => r.risks.length > 0)
        .sort(
          (a, b) =>
            SEVERITY[b.risks[0].severity] - SEVERITY[a.risks[0].severity] ||
            b.risks.length - a.risks.length ||
            a.code.localeCompare(b.code)
        );
    return {
      margin: pick((x) => MARGIN_RULE_IDS.has(x.id)),
      valuation: pick((x) => VALUATION_RULE_IDS.has(x.id)),
      others: pick((x) => !MARGIN_RULE_IDS.has(x.id) && !VALUATION_RULE_IDS.has(x.id)),
    };
  }, [rows]);

  if (holdings.length === 0) return null;

  const pending = scoped.filter((h) => !fundamentalsMap[h.code]).length;
  const notReady = scoped.filter((h) => (history[h.code]?.candles?.length ?? 0) < 60).length;
  const withMargin = scoped.filter((h) =>
    Number.isFinite(marginMap[h.code]?.marginChangePercent)
  ).length;
  const withValuation = scoped.filter((h) => fundamentalsMap[h.code]?.bands?.pe).length;
  const count = (list) => list.reduce((acc, r) => acc + r.risks.length, 0);

  return (
    <div className="space-y-2">
      <ScopePicker scope={scope} counts={counts} onChange={setScope} />

      {scoped.length === 0 ? (
        <p className="rounded-xl border border-slate-800 bg-slate-900/40 px-3 py-4 text-center text-sm text-slate-500">
          持股中沒有{scope === 'etf' ? ' ETF' : '個股'}，切換上方的範圍即可掃描其餘持股。
        </p>
      ) : (
        <>
          <ScanPanel
            icon={<Activity size={14} className="shrink-0 text-violet-400" />}
            title="融資融券籌碼"
            summary={
              withMargin === 0
                ? '所選範圍皆無信用交易資料'
                : split.margin.length === 0
                  ? `${withMargin} 檔有資料，皆未觸發`
                  : `${split.margin.length} 檔觸發共 ${count(split.margin)} 項`
            }
            defaultOpen={split.margin.length > 0}
          >
            <MarginTable holdings={scoped} marginMap={marginMap} quotes={quotes} />
            {split.margin.length > 0 && (
              <div className="mt-3 space-y-2">
                {split.margin.map((row) => (
                  <RiskRow key={row.code} row={row} />
                ))}
              </div>
            )}
          </ScanPanel>

          <ScanPanel
            icon={<Layers size={14} className="shrink-0 text-sky-400" />}
            title="型態與攻守"
            summary={`${scoped.length} 檔的狀態分布`}
            note={
              '二日法則：收盤穿越均線當天只算警戒，隔日最低（或最高）價再突破前一日才算確認。' +
              '型態由擺盪轉折點推得，判不出來就回「型態未明」，不硬湊。' +
              '兩者都是常見的交易慣例、非經證實的方法，此處只描述狀態，不建議任何動作。'
            }
          >
            <StanceOverview holdings={scoped} />
          </ScanPanel>

          <ScanPanel
            icon={<Scale size={14} className="shrink-0 text-indigo-400" />}
            title="估值檢視"
            summary={
              withValuation === 0
                ? '所選範圍皆無估值資料'
                : split.valuation.length === 0
                  ? `${withValuation} 檔有資料，皆未達高分位`
                  : `${split.valuation.length} 檔位於高分位`
            }
            defaultOpen={split.valuation.length > 0}
          >
            <ValuationOverview holdings={scoped} />
            {/* 與融資融券面板一致：表上看得到數字，觸發的項目仍要有文字說明。 */}
            {split.valuation.length > 0 && (
              <div className="mt-3 space-y-2">
                {split.valuation.map((row) => (
                  <RiskRow key={row.code} row={row} />
                ))}
              </div>
            )}
          </ScanPanel>

          <ScanPanel
            icon={<ScanLine size={14} className="shrink-0 text-cyan-400" />}
            title="其餘規則掃描"
            summary={
              split.others.length === 0
                ? `${scoped.length} 檔皆未觸發`
                : `${split.others.length} 檔觸發共 ${count(split.others)} 項`
            }
            defaultOpen={split.others.length > 0}
          >
            {split.others.length === 0 ? (
              <p className="py-4 text-center text-sm text-slate-500">
                目前沒有標的觸發基本面、技術面或事件類的規則。這不代表沒有風險，
                只代表這份清單涵蓋的項目都未達門檻。估值分位另見上方的估值檢視。
              </p>
            ) : (
              <div className="space-y-2">
                {split.others.map((row) => (
                  <RiskRow key={row.code} row={row} />
                ))}
              </div>
            )}

            {pending > 0 && (
              <button
                type="button"
                onClick={() =>
                  scoped
                    .filter((h) => !fundamentalsMap[h.code])
                    .forEach((h) => dispatch(loadFundamentals({ code: h.code })))
                }
                disabled={loadingFundamentals}
                className="mt-2 flex items-center gap-1.5 rounded-lg bg-sky-600 px-2.5 py-1.5 text-[11px] font-medium text-white transition hover:bg-sky-500 disabled:opacity-40"
              >
                {loadingFundamentals ? <RefreshCw size={12} className="animate-spin" /> : null}
                {loadingFundamentals ? '載入中…' : `載入 ${pending} 檔的基本面`}
              </button>
            )}

            <p className="mt-1.5 text-[10px] leading-relaxed text-slate-600">
              依固定門檻逐條檢查，不經過 AI，同樣的資料一定得到同樣的結果。每項都附觸發它的實際數值。
              {pending > 0 &&
                `財報那幾條規則需要另外查基本面（一檔五個資料集），尚有 ${pending} 檔未載入。`}
              {notReady > 0 &&
                `有 ${notReady} 檔的歷史股價尚未載入或不足 60 個交易日，技術面規則暫時跳過。`}
            </p>
          </ScanPanel>
        </>
      )}
    </div>
  );
}

/**
 * 掃描範圍切換。
 *
 * 檔數直接標在按鈕上，切換前就知道範圍多大——「股票 5」與「ETF 17」
 * 這兩個數字本身就說明了為什麼預設要分開掃。
 */
function ScopePicker({ scope, counts, onChange }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="text-[11px] text-slate-500">掃描範圍</span>
      <div className="flex overflow-hidden rounded-lg border border-slate-800">
        {SCOPES.map((s) => {
          const active = scope === s.id;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => onChange(s.id)}
              className={`px-2.5 py-1 text-[11px] transition ${
                active
                  ? 'bg-sky-600/25 text-sky-300'
                  : 'text-slate-500 hover:bg-slate-800/60 hover:text-slate-300'
              }`}
            >
              {s.label}
              <span className={`tabular ml-1 ${active ? 'text-sky-400/70' : 'text-slate-600'}`}>
                {counts[s.id]}
              </span>
            </button>
          );
        })}
      </div>
      <span className="text-[10px] text-slate-600">
        預設只掃股票：ETF 沒有估值與財報資料，混進來會讓估值面板整排「無資料」。
        融資融券與型態對 ETF 一樣適用，切過去照樣有東西看。
      </span>
    </div>
  );
}

/** 單一標的的觸發項目。 */
function RiskRow({ row }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-2">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="tabular text-sm font-medium text-slate-200">{row.code}</span>
        {row.name && <span className="text-xs text-slate-500">{row.name}</span>}
        <span className="text-[10px] text-slate-600">{row.risks.length} 項</span>
      </div>
      <ul className="mt-1 space-y-1">
        {row.risks.map((item) => (
          <li key={item.id} className="flex gap-1.5">
            <AlertTriangle
              size={12}
              className={`mt-0.5 shrink-0 ${SEVERITY_COLOR[item.severity]}`}
            />
            <div className="min-w-0">
              <span
                className={`mr-1 rounded px-1 py-0.5 text-[10px] ${SEVERITY_BADGE[item.severity]}`}
              >
                {item.category}
              </span>
              <span className="text-[11px] leading-relaxed text-slate-300">{item.message}</span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
