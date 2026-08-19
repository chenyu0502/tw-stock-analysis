import { useMemo } from 'react';
import { int, pct } from '../lib/format.js';
import { THRESHOLDS } from '../lib/risks.js';

/**
 * 全部位的融資融券明細表。
 *
 * 一列一檔，把餘額、增減張數、增幅、券資比並排列出。表格的好處是**數字本身可讀**——
 * 散佈圖看得出誰是離群值，卻要滑到點上才知道實際增減幾張，而那才是要判斷的依據。
 *
 * 依「融資增幅絕對值加融券增幅絕對值」由大到小排序，變動最劇烈的排最前面，
 * 二十幾檔不必逐列掃描。
 *
 * 刻意不用紅綠：紅漲綠跌在台股是價格方向的慣例，套在資金流向上會被讀成
 * 「紅色＝看多」。融資融券的多空解讀本來就沒有共識。
 * 只有越過規則門檻的數字才用琥珀色標出，那是「這格觸發了規則」的意思，不是方向。
 */
export default function MarginTable({ holdings, marginMap, quotes }) {
  const rows = useMemo(
    () =>
      holdings
        .map((h) => {
          const m = marginMap[h.code];
          if (!m || !Number.isFinite(m.marginChangePercent)) return null;
          return {
            code: h.code,
            name: quotes[h.code]?.name || m.name || '',
            date: m.date,
            marginBalance: m.marginBalance,
            marginChange: m.marginChange,
            marginChangePercent: m.marginChangePercent,
            shortBalance: m.shortBalance,
            shortChange: m.shortChange,
            shortChangePercent: m.shortChangePercent,
            shortMarginRatio: m.shortMarginRatio,
            magnitude:
              Math.abs(m.marginChangePercent) + Math.abs(m.shortChangePercent ?? 0),
          };
        })
        .filter(Boolean)
        .sort((a, b) => b.magnitude - a.magnitude),
    [holdings, marginMap, quotes]
  );

  const missing = holdings.length - rows.length;

  if (rows.length === 0) {
    return (
      <p className="py-4 text-center text-sm text-slate-500">
        持股中沒有具融資融券資料的標的。ETF 與非信用交易個股本來就沒有這項資料，屬正常情形。
      </p>
    );
  }

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-slate-500">
              <th className="pb-2 text-left font-normal">標的</th>
              <th className="pb-2 text-right font-normal">融資餘額</th>
              <th className="pb-2 text-right font-normal">融資增減</th>
              <th className="pb-2 text-right font-normal">融資增幅</th>
              <th className="pb-2 text-right font-normal">融券餘額</th>
              <th className="pb-2 text-right font-normal">融券增減</th>
              <th className="pb-2 text-right font-normal">融券增幅</th>
              <th className="pb-2 text-right font-normal">券資比</th>
            </tr>
          </thead>
          <tbody className="tabular">
            {rows.map((r) => {
              // 兩條「暴增」規則都要求張數與增幅同時達標，只達一項不算觸發。
              const marginHot =
                r.marginChange >= THRESHOLDS.marginSurgeLots &&
                r.marginChangePercent >= THRESHOLDS.marginSurgePercent;
              const shortHot =
                r.shortChange >= THRESHOLDS.shortSurgeLots &&
                r.shortChangePercent >= THRESHOLDS.shortSurgePercent;
              const ratioHot = r.shortMarginRatio >= THRESHOLDS.shortMarginRatioHigh;

              return (
                <tr key={r.code} className="border-t border-slate-800/60">
                  <td className="whitespace-nowrap py-1.5">
                    <span className="text-slate-300">{r.code}</span>
                    {r.name && <span className="ml-1.5 text-slate-500">{r.name}</span>}
                  </td>
                  <td className="py-1.5 text-right text-slate-400">{int(r.marginBalance)}</td>
                  <td className="py-1.5 text-right text-slate-300">{signed(r.marginChange)}</td>
                  <td className={`py-1.5 text-right ${marginHot ? 'text-amber-400' : 'text-slate-300'}`}>
                    {pct(r.marginChangePercent, 1, true)}
                  </td>
                  <td className="py-1.5 text-right text-slate-400">{int(r.shortBalance)}</td>
                  <td className="py-1.5 text-right text-slate-300">{signed(r.shortChange)}</td>
                  <td className={`py-1.5 text-right ${shortHot ? 'text-amber-400' : 'text-slate-300'}`}>
                    {pct(r.shortChangePercent, 1, true)}
                  </td>
                  <td className={`py-1.5 text-right ${ratioHot ? 'text-amber-400' : 'text-slate-400'}`}>
                    {pct(r.shortMarginRatio, 1)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="mt-1.5 text-[10px] leading-relaxed text-slate-600">
        餘額與增減的單位是張，依變動幅度由大到小排列。琥珀色代表該格已達規則門檻
        （融資 {THRESHOLDS.marginSurgeLots} 張且 {THRESHOLDS.marginSurgePercent}%、
        融券 {THRESHOLDS.shortSurgeLots} 張且 {THRESHOLDS.shortSurgePercent}%、
        券資比 {THRESHOLDS.shortMarginRatioHigh}%）。
        {/* JSX 不解析 markdown，要強調得用元素，寫星號只會原樣顯示出來。 */}
        數字只描述資金流向，
        <span className="text-slate-500">不代表多空</span>
        ——融資增加有人讀成散戶追高、有人讀成資金流入，沒有共識。
        {missing > 0 && `另有 ${missing} 檔無融資融券資料（ETF 或非信用交易個股），未列入表中。`}
      </p>
    </div>
  );
}

/** 增減張數一律補正負號，零與缺值分別顯示。 */
function signed(value) {
  if (!Number.isFinite(value)) return '—';
  return `${value > 0 ? '+' : ''}${int(value)}`;
}
