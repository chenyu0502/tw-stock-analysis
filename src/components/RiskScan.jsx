import { useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { AlertTriangle, RefreshCw, ScanLine } from 'lucide-react';
import { loadFundamentals } from '../store/marketSlice.js';
import { detectRisks, SEVERITY } from '../lib/risks.js';
import { buildAnalysisInput } from '../lib/analysisInput.js';
import { today as todayDate, DEFAULT_MA } from '../store/portfolioSlice.js';

/** 嚴重度的顏色，與 AI 頁的風險清單一致。 */
const SEVERITY_COLOR = { high: 'text-rose-500', medium: 'text-amber-500', low: 'text-slate-500' };
const SEVERITY_BADGE = {
  high: 'bg-rose-950/60 text-rose-400',
  medium: 'bg-amber-950/60 text-amber-400',
  low: 'bg-slate-800 text-slate-400',
};

/**
 * 全部位掃描。
 *
 * 存在的理由：規則型偵測原本只在 AI 頁的單一標的上跑，
 * 持有二十幾檔時等於看不到——沒有人會為了看有沒有觸發規則而一檔一檔點開。
 * 這與「均線攻守狀態原本藏在展開區」是同一個問題。
 *
 * 預設只用**畫面上已經載入的資料**（報價、融資融券、法人當日、歷史 K 線），
 * 不額外發請求。估值分位與財報那幾條規則需要 /api/fundamentals，
 * 一檔要打五個 FinMind 資料集，因此改為按鈕觸發，並在按鈕上寫明會查幾檔。
 *
 * @param {{ holdings: object[] }} props
 */
export default function RiskScan({ holdings }) {
  const dispatch = useDispatch();
  const history = useSelector((s) => s.market.history);
  const quotes = useSelector((s) => s.market.quotes);
  const marginMap = useSelector((s) => s.market.margin);
  const institutionalMap = useSelector((s) => s.market.institutional);
  const valuationMap = useSelector((s) => s.market.valuation);
  const fundamentalsMap = useSelector((s) => s.market.fundamentals);
  const exDividend = useSelector((s) => s.market.exDividend);
  const loadingFundamentals = useSelector((s) => s.market.loading.fundamentals);

  const [expanded, setExpanded] = useState(true);

  const rows = useMemo(() => {
    const day = todayDate();
    return holdings
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
          // 沒有歷史股價時多數規則跑不了，要與「跑過了但沒事」區分開來。
          ready: candles.length >= 60,
          hasFundamentals: Boolean(fundamentals?.available),
        };
      })
      .filter((r) => r.risks.length > 0)
      .sort(
        (a, b) =>
          SEVERITY[b.risks[0].severity] - SEVERITY[a.risks[0].severity] ||
          b.risks.length - a.risks.length ||
          a.code.localeCompare(b.code)
      );
  }, [
    holdings,
    history,
    quotes,
    marginMap,
    institutionalMap,
    valuationMap,
    fundamentalsMap,
    exDividend,
  ]);

  if (holdings.length === 0) return null;

  const pending = holdings.filter((h) => !fundamentalsMap[h.code]).length;
  const notReady = holdings.filter((h) => (history[h.code]?.candles?.length ?? 0) < 60).length;
  const total = rows.reduce((acc, r) => acc + r.risks.length, 0);

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-3">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 text-left"
      >
        <ScanLine size={14} className="text-slate-400" />
        <h3 className="text-sm font-medium text-slate-300">全部位掃描</h3>
        <span className="text-xs text-slate-500">
          {rows.length === 0
            ? `${holdings.length} 檔皆未觸發`
            : `${rows.length} 檔觸發共 ${total} 項`}
        </span>
        <span className="ml-auto text-xs text-slate-600">{expanded ? '收合' : '展開'}</span>
      </button>

      {expanded && (
        <>
          {rows.length === 0 ? (
            <p className="py-4 text-center text-sm text-slate-500">
              目前沒有標的觸發任何規則。這不代表沒有風險，只代表這份清單涵蓋的項目都未達門檻。
            </p>
          ) : (
            <div className="mt-2 space-y-2">
              {rows.map((row) => (
                <div key={row.code} className="rounded-lg border border-slate-800 bg-slate-900/50 p-2">
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
                          <span className="text-[11px] leading-relaxed text-slate-300">
                            {item.message}
                          </span>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}

          <div className="mt-2 flex flex-wrap items-center gap-2">
            {pending > 0 && (
              <button
                type="button"
                onClick={() =>
                  holdings
                    .filter((h) => !fundamentalsMap[h.code])
                    .forEach((h) => dispatch(loadFundamentals({ code: h.code })))
                }
                disabled={loadingFundamentals}
                className="flex items-center gap-1.5 rounded border border-sky-700 bg-sky-600/20 px-2.5 py-1 text-[11px] text-sky-300 transition hover:bg-sky-600/30 disabled:opacity-40"
              >
                {loadingFundamentals ? <RefreshCw size={12} className="animate-spin" /> : null}
                {loadingFundamentals ? '載入中…' : `載入 ${pending} 檔的基本面`}
              </button>
            )}
          </div>

          <p className="mt-1.5 text-[10px] leading-relaxed text-slate-600">
            依固定門檻逐條檢查，不經過 AI，同樣的資料一定得到同樣的結果。每項都附觸發它的實際數值。
            {pending > 0 &&
              `估值分位與財報那幾條規則需要另外查基本面（一檔五個資料集），尚有 ${pending} 檔未載入。`}
            {notReady > 0 && `有 ${notReady} 檔的歷史股價尚未載入或不足 60 個交易日，技術面規則暫時跳過。`}
            ETF 與非信用交易個股沒有融資融券資料，那是「無資料」不是「無異常」。
          </p>
        </>
      )}
    </section>
  );
}
