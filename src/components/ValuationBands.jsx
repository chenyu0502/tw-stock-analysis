import { num, pct } from '../lib/format.js';

/**
 * 估值分位帶。
 *
 * 呈現的是「目前值在這檔自己的歷史區間裡落在哪裡」，不是跟其他股票比。
 * 本益比 30 倍對不同產業意義天差地遠，但「高於自己過去五年八成的時間」
 * 對任何一檔都成立。
 *
 * 刻意只陳述位置，不下「偏貴」「便宜」的結論——那是投資判斷，由使用者自己做。
 */
export default function ValuationBands({ bands }) {
  const rows = [
    { key: 'pe', label: '本益比', data: bands?.pe, digits: 1, suffix: ' 倍' },
    { key: 'pb', label: '股價淨值比', data: bands?.pb, digits: 2, suffix: ' 倍' },
    // 殖利率的高分位代表股價相對便宜，方向與前兩項相反，介面上另外註明。
    { key: 'dividendYield', label: '現金殖利率', data: bands?.dividendYield, digits: 2, suffix: '%' },
  ].filter((r) => r.data);

  if (rows.length === 0) {
    return (
      <div className="py-6 text-center text-sm text-slate-500">
        無估值歷史資料。ETF 與部分新上市標的沒有本益比資料，屬正常情形。
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {rows.map(({ key, ...row }) => (
        <BandRow key={key} {...row} />
      ))}
      <p className="text-[12px] leading-relaxed text-slate-600">
        分位為「目前值高於過去多少比例的交易日」，0% 為歷史最低、100% 為歷史最高。
        本益比與股價淨值比的分位越高代表越貴；殖利率相反，分位越高代表相對便宜。
        取樣區間 {rows[0].data.from} 起共 {rows[0].data.samples} 個交易日。
      </p>
    </div>
  );
}

function BandRow({ label, data, digits, suffix }) {
  const { current, min, p25, median, p75, max, percentile } = data;
  // 以最小值到最大值線性定位。分母為零（歷史值完全沒變動）時退回中點。
  const posOf = (v) => (max > min ? ((v - min) / (max - min)) * 100 : 50);

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-2">
        <span className="text-xs text-slate-400">{label}</span>
        <span className="tabular text-sm text-slate-100">
          {num(current, digits)}
          {suffix}
          {/* 顯示到小數一位。四捨五入到整數會讓 84.7% 顯示成 85%，
              而風險門檻正是 85，畫面上會出現「已達 85% 卻沒有提示」的矛盾。 */}
          <span className="ml-2 text-[12px] text-slate-500">
            歷史 {pct(percentile, 1)} 分位
          </span>
        </span>
      </div>

      {/* 分位帶。深色段為第一與第三四分位之間，也就是過半數時間所在的區間。 */}
      <div className="relative mt-1.5 h-5">
        <div className="absolute inset-x-0 top-2 h-1 rounded bg-slate-800" />
        <div
          className="absolute top-2 h-1 rounded bg-slate-600"
          style={{ left: `${posOf(p25)}%`, width: `${Math.max(0, posOf(p75) - posOf(p25))}%` }}
        />
        {/* 中位數 */}
        <div
          className="absolute top-1 h-3 w-px bg-slate-400"
          style={{ left: `${posOf(median)}%` }}
          title={`中位數 ${num(median, digits)}`}
        />
        {/* 目前值 */}
        <div
          className="absolute top-0.5 h-4 w-0.5 rounded bg-sky-400"
          style={{ left: `${posOf(current)}%` }}
          title={`目前 ${num(current, digits)}`}
        />
      </div>

      <div className="tabular flex justify-between text-[11px] text-slate-600">
        <span>{num(min, digits)}</span>
        <span>中位 {num(median, digits)}</span>
        <span>{num(max, digits)}</span>
      </div>
    </div>
  );
}
