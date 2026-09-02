import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { dailyPnlOfMonth } from '../lib/performance.js';
import { money, changeColor } from '../lib/format.js';

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

/**
 * 每日損益月曆。
 *
 * 非交易日與無資料的日期留白而不是顯示零，
 * 顯示零會讓人誤以為當天有交易但打平。
 *
 * @param {{ curve: object[] }} props
 */
export default function PnlCalendar({ curve }) {
  const latestMonth = curve.length > 0 ? curve[curve.length - 1].date.slice(0, 7) : null;
  const [month, setMonth] = useState(latestMonth);

  const activeMonth = month ?? latestMonth;
  const pnlMap = useMemo(
    () => (activeMonth ? dailyPnlOfMonth(curve, activeMonth) : new Map()),
    [curve, activeMonth]
  );

  const { cells, monthTotal, weekTotals } = useMemo(() => {
    if (!activeMonth) return { cells: [], monthTotal: 0, weekTotals: [] };

    const [year, mon] = activeMonth.split('-').map(Number);
    const firstDay = new Date(year, mon - 1, 1);
    const daysInMonth = new Date(year, mon, 0).getDate();

    // 補上月初的空格，讓第一天對齊正確的星期欄位。
    const list = Array.from({ length: firstDay.getDay() }, () => null);
    for (let day = 1; day <= daysInMonth; day += 1) {
      const date = `${activeMonth}-${String(day).padStart(2, '0')}`;
      list.push({ day, date, pnl: pnlMap.get(date) ?? null });
    }
    // 補上月末空格，湊滿整週。
    while (list.length % 7 !== 0) list.push(null);

    // 每週除了合計金額，也留下涵蓋的日期範圍與交易日數，供停留時顯示。
    // 只有一個百分比或一個數字時，看不出這一格代表哪幾天——月初與月末那兩格
    // 常常只涵蓋兩三天，卻與整週的格子長得一樣。
    const weeks = [];
    for (let i = 0; i < list.length; i += 7) {
      const week = list.slice(i, i + 7).filter((c) => c?.pnl !== null && c?.pnl !== undefined);
      if (week.length === 0) {
        weeks.push(null);
        continue;
      }
      weeks.push({
        total: week.reduce((acc, c) => acc + c.pnl, 0),
        from: week[0].date,
        to: week[week.length - 1].date,
        days: week.length,
      });
    }

    return {
      cells: list,
      monthTotal: [...pnlMap.values()].reduce((acc, v) => acc + v, 0),
      weekTotals: weeks,
    };
  }, [activeMonth, pnlMap]);

  if (!activeMonth) {
    return <div className="py-8 text-center text-sm text-slate-500">無損益資料</div>;
  }

  /** 依偏移量切換月份。 */
  function shiftMonth(offset) {
    const [year, mon] = activeMonth.split('-').map(Number);
    const d = new Date(year, mon - 1 + offset, 1);
    setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <button
          type="button"
          onClick={() => shiftMonth(-1)}
          className="rounded p-1.5 text-slate-400 transition hover:bg-slate-800 hover:text-white"
        >
          <ChevronLeft size={16} />
        </button>
        <div className="text-center">
          <div className="tabular text-sm font-medium">{activeMonth}</div>
          <div className={`tabular text-xs ${changeColor(monthTotal)}`}>{money(monthTotal)}</div>
        </div>
        <button
          type="button"
          onClick={() => shiftMonth(1)}
          className="rounded p-1.5 text-slate-400 transition hover:bg-slate-800 hover:text-white"
        >
          <ChevronRight size={16} />
        </button>
      </div>

      <div className="flex gap-1">
        <div className="grid flex-1 grid-cols-7 gap-1">
          {WEEKDAYS.map((w) => (
            <div key={w} className="pb-1 text-center text-[11px] text-slate-600">
              {w}
            </div>
          ))}

          {cells.map((cell, i) => {
            if (!cell) return <div key={`blank-${i}`} />;
            const hasData = cell.pnl !== null;
            return (
              <div
                key={cell.date}
                // 格子只顯示到千位，對帳時需要完整金額，滑鼠停留即可看到。
                title={hasData ? `${cell.date}　${money(cell.pnl)}` : undefined}
                // 左右內距收窄：字級放大一級之後，375px 寬的手機上「+114k」這種
                // 五個字元的金額會擠出格子。上下維持原本的間距。
                className={`rounded border px-0.5 py-1 text-center ${
                  hasData ? 'border-slate-800 bg-slate-900/60' : 'border-transparent'
                }`}
              >
                <div className="tabular text-[11px] text-slate-500">{cell.day}</div>
                {hasData && (
                  <div className={`tabular text-[11px] leading-tight ${changeColor(cell.pnl)}`}>
                    {Math.abs(cell.pnl) >= 1000
                      ? `${cell.pnl > 0 ? '+' : '-'}${Math.round(Math.abs(cell.pnl) / 1000)}k`
                      : Math.round(cell.pnl)}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* 週損益欄，與月曆各列對齊 */}
        <div className="grid w-14 grid-rows-[auto] gap-1">
          <div className="pb-1 text-center text-[11px] text-slate-600">週</div>
          {weekTotals.map((week, i) => (
            <div
              key={`week-${i}`}
              // 與日期格一致：格子只顯示到千位，對帳時需要完整金額，滑鼠停留即可看到。
              title={
                week
                  ? `${week.from} ～ ${week.to}　${money(week.total)}（${week.days} 個交易日）`
                  : undefined
              }
              className={`tabular flex items-center justify-center rounded border border-slate-800/60 text-[11px] ${changeColor(
                week?.total ?? null
              )}`}
            >
              {week === null
                ? ''
                : Math.abs(week.total) >= 1000
                  ? `${week.total > 0 ? '+' : '-'}${Math.round(Math.abs(week.total) / 1000)}k`
                  : Math.round(week.total)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
