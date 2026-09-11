import { num, pct, int } from '../lib/format.js';

/**
 * 同業估值比較。
 *
 * 與 ValuationBands 互補：那個回答「相對自己過去貴不貴」，這個回答
 * 「相對同業貴不貴」。兩者都需要，因為單看歷史分位有一個盲點——
 * 整個產業一起重評價時，個股的歷史分位會長期停在高檔，看起來永遠很貴。
 *
 * 同樣只陳述位置，不下「便宜」「昂貴」的結論。
 */
export default function PeerComparison({ data }) {
  if (!data) {
    return <div className="py-6 text-center text-sm text-slate-500">載入同業資料中…</div>;
  }
  if (!data.available) {
    return <div className="py-6 text-center text-sm text-slate-500">{data.reason}</div>;
  }

  const rows = [
    { key: 'pe', label: '本益比', data: data.metrics?.pe, digits: 1, suffix: ' 倍' },
    { key: 'pb', label: '股價淨值比', data: data.metrics?.pb, digits: 2, suffix: ' 倍' },
    {
      key: 'dividendYield',
      label: '現金殖利率',
      data: data.metrics?.dividendYield,
      digits: 2,
      suffix: '%',
    },
  ].filter((r) => r.data);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded border border-slate-700 bg-slate-800/60 px-2 py-0.5 text-xs text-slate-300">
          {data.industry}
        </span>
        <span className="text-[12px] text-slate-500">
          同產業取得估值者 {int(data.peerCount)} 家
        </span>
      </div>

      {/* 家數太少時中位數幾乎等於任一檔的值，「高於同業中位數」這句話沒有資訊量。
          數字照樣顯示供人工對照，但先把話講在前面。 */}
      {!data.sufficient && (
        <div className="rounded-lg border border-amber-800/60 bg-amber-950/30 p-2.5 text-xs leading-relaxed text-amber-300">
          同業家數過少，中位數與分位不具代表性，僅供人工對照，不宜據此判斷估值高低。
        </div>
      )}

      {rows.length === 0 ? (
        <div className="py-4 text-center text-sm text-slate-500">同業皆無可比較的估值數字。</div>
      ) : (
        rows.map(({ key, ...row }) => <MetricRow key={key} {...row} />)
      )}

      {Array.isArray(data.neighbors) && data.neighbors.length > 0 && (
        <NeighborTable rows={data.neighbors} />
      )}

      <p className="text-[12px] leading-relaxed text-slate-600">
        分位為「本檔數值高於同業中多少比例的家數」。本益比與股價淨值比的分位越高代表相對同業越貴；
        殖利率相反，分位越高代表相對便宜。名次一律由低至高排列，因此本益比第 1
        名是全產業最低，不代表最好。
        產業分類為粗分類，同一分類內的公司規模與產品結構可能差異極大，橫向比較僅供參考。
      </p>
    </div>
  );
}

/**
 * 單一指標：本檔數值、同業四分位區間與本檔在其中的位置。
 *
 * 條的兩端是同業的最低與最高，深色段為第一到第三四分位，
 * 也就是過半數同業所在的區間，與 ValuationBands 用同一套視覺語彙。
 */
function MetricRow({ label, data, digits, suffix }) {
  const { self, min, p25, median, p75, max, percentile, rank, samples } = data;
  const posOf = (v) => (max > min ? ((v - min) / (max - min)) * 100 : 50);

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-2">
        <span className="text-xs text-slate-400">{label}</span>
        <span className="tabular text-sm text-slate-100">
          {/* 虧損公司沒有本益比，明寫出來而不是顯示成 0 或空白——
              前者會被讀成「本益比極低」，後者看起來像載入失敗。 */}
          {Number.isFinite(self) ? (
            <>
              {num(self, digits)}
              {suffix}
              <span className="ml-2 text-[12px] text-slate-500">
                同業 {pct(percentile, 1)} 分位 · 第 {int(rank)}／{int(samples)} 名
              </span>
            </>
          ) : (
            <span className="text-[12px] text-slate-500">本檔無此數值</span>
          )}
        </span>
      </div>

      <div className="relative mt-1.5 h-5">
        <div className="absolute inset-x-0 top-2 h-1 rounded bg-slate-800" />
        <div
          className="absolute top-2 h-1 rounded bg-slate-600"
          style={{ left: `${posOf(p25)}%`, width: `${Math.max(0, posOf(p75) - posOf(p25))}%` }}
        />
        <div
          className="absolute top-1 h-3 w-px bg-slate-400"
          style={{ left: `${posOf(median)}%` }}
          title={`同業中位數 ${num(median, digits)}`}
        />
        {Number.isFinite(self) && (
          <div
            className="absolute top-0.5 h-4 w-0.5 rounded bg-sky-400"
            style={{ left: `${posOf(self)}%` }}
            title={`本檔 ${num(self, digits)}`}
          />
        )}
      </div>

      <div className="tabular flex justify-between text-[11px] text-slate-600">
        <span>{num(min, digits)}</span>
        <span>同業中位 {num(median, digits)}</span>
        <span>{num(max, digits)}</span>
      </div>
    </div>
  );
}

/**
 * 本益比相鄰的同業明細。
 *
 * 刻意不列「產業龍頭」：免費資料源沒有市值，用成交值代替會在冷門股身上失真。
 * 估值鄰居對「這檔落在同業的哪一段」這個問題更直接——看得到上面與下面各是誰。
 */
function NeighborTable({ rows }) {
  return (
    <div className="overflow-x-auto">
      <table className="tabular w-full min-w-[22rem] text-xs">
        <thead>
          <tr className="text-slate-500">
            <th className="py-1 text-left font-normal">同業（依本益比排序）</th>
            <th className="py-1 text-right font-normal">本益比</th>
            <th className="py-1 text-right font-normal">股價淨值比</th>
            <th className="py-1 text-right font-normal">殖利率</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.code}
              className={row.self ? 'bg-sky-950/40 text-sky-300' : 'text-slate-400'}
            >
              <td className="py-1 pr-2">
                {row.code} {row.name}
              </td>
              <td className="py-1 text-right">{num(row.pe, 1)}</td>
              <td className="py-1 text-right">{num(row.pb, 2)}</td>
              <td className="py-1 text-right">{pct(row.dividendYield, 2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
