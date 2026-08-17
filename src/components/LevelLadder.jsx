import { SOURCE_LABEL } from '../lib/levels.js';
import { num, pct } from '../lib/format.js';

/**
 * 支撐壓力階梯圖。
 *
 * 由高至低排列，現價插在中間，讓上下方的空間一眼可辨。
 * 每個價位標示來源與歷史觸及次數，因為使用者需要知道這個數字憑什麼成立，
 * 而不是只看到一個沒有依據的價格。
 *
 * @param {{ levels: { price: number, supports: object[], resistances: object[] }, notes?: object[] }} props
 *   notes 為 AI 對各價位的解讀，以 label 對應
 */
export default function LevelLadder({ levels, notes = [] }) {
  const noteMap = new Map(notes.map((n) => [n.label, n.significance]));

  const rows = [
    ...levels.resistances
      .slice()
      .reverse()
      .map((l) => ({ ...l, label: `壓力${l.rank}` })),
    { isCurrent: true, price: levels.price, label: '現價' },
    ...levels.supports.map((l) => ({ ...l, label: `支撐${l.rank}` })),
  ];

  return (
    <div className="space-y-1.5">
      {rows.map((row) => {
        if (row.isCurrent) {
          return (
            <div
              key="current"
              className="flex items-center gap-3 rounded-lg border border-sky-700/60 bg-sky-950/40 px-3 py-2"
            >
              <span className="w-12 shrink-0 text-xs text-sky-400">現價</span>
              <span className="tabular flex-1 text-base font-semibold text-sky-300">
                {num(row.price)}
              </span>
            </div>
          );
        }

        const isResistance = row.type === 'resistance';
        return (
          <div
            key={row.label}
            className={`rounded-lg border px-3 py-2 ${
              isResistance
                ? 'border-emerald-800/50 bg-emerald-950/20'
                : 'border-rose-800/50 bg-rose-950/20'
            }`}
          >
            <div className="flex items-center gap-3">
              <span
                className={`w-12 shrink-0 text-xs ${
                  isResistance ? 'text-emerald-400' : 'text-rose-400'
                }`}
              >
                {row.label}
              </span>
              <span className="tabular flex-1 text-sm font-medium text-slate-100">
                {num(row.price)}
              </span>
              <span className="tabular text-xs text-slate-500">
                {pct(row.distancePercent, 2, true)}
              </span>
            </div>

            <div className="mt-1 flex flex-wrap items-center gap-1.5 pl-15">
              {row.sources.map((s) => (
                <span
                  key={s}
                  className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400"
                >
                  {SOURCE_LABEL[s] ?? s}
                </span>
              ))}
              <span className="text-[10px] text-slate-600">
                歷史觸及 {row.touches} 次
                {row.lastTouchDate && `，最近 ${row.lastTouchDate}`}
              </span>
            </div>

            {noteMap.get(row.label) && (
              <p className="mt-1.5 text-xs leading-relaxed text-slate-400">
                {noteMap.get(row.label)}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
