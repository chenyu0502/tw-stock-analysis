import { Fragment, useMemo, useState } from 'react';
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

  // 被點選的格子。手機沒有 hover，title 看不到，改由下方那一行顯示完整金額。
  const [selected, setSelected] = useState(null);

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

  /** 依偏移量切換月份。換月後原本選的格子已不存在，一併清掉。 */
  function shiftMonth(offset) {
    const [year, mon] = activeMonth.split('-').map(Number);
    const d = new Date(year, mon - 1 + offset, 1);
    setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    setSelected(null);
  }

  /** 點選一格；再點同一格取消，才不會有選了就取消不掉的死角。 */
  function pick(key, label, amount) {
    setSelected((prev) => (prev?.key === key ? null : { key, label, amount }));
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

      {/*
        日期與週損益放在同一個格線裡：七欄日期加一欄週損益。

        先前是兩個並排的獨立格線，各自依內容算列高——日期格有日期與金額兩行，
        週欄只有一行，於是週欄從第一列就往下偏了 20px，之後逐列縮小。
        兩邊只有在列高剛好相同時才會對齊，沒有任何機制保證這件事。
        同一個格線裡，同一列的所有格子共用同一個上下緣，不可能錯開。
      */}
      <div className="grid grid-cols-[repeat(7,minmax(0,1fr))_3.5rem] gap-1">
        {WEEKDAYS.map((w) => (
          <div key={w} className="pb-1 text-center text-[11px] text-slate-600">
            {w}
          </div>
        ))}
        <div className="pb-1 text-center text-[11px] text-slate-600">週</div>

        {weekTotals.map((week, row) => (
          <Fragment key={`row-${row}`}>
            {cells.slice(row * 7, row * 7 + 7).map((cell, col) => {
              if (!cell) return <div key={`blank-${row}-${col}`} />;
              const hasData = cell.pnl !== null;
              const key = `day-${cell.date}`;
              return (
                <button
                  key={cell.date}
                  type="button"
                  disabled={!hasData}
                  onClick={() => pick(key, cell.date, cell.pnl)}
                  // 格子只顯示到千位，對帳時需要完整金額。
                  // 桌機滑鼠停留看 title，手機沒有 hover，改點一下顯示在下方那一行。
                  title={hasData ? `${cell.date}　${money(cell.pnl)}` : undefined}
                  // 左右內距收窄：字級放大一級之後，375px 寬的手機上「+114k」這種
                  // 五個字元的金額會擠出格子。上下維持原本的間距。
                  className={`rounded border px-0.5 py-1 text-center ${
                    hasData ? 'border-slate-800 bg-slate-900/60' : 'border-transparent'
                  } ${selected?.key === key ? 'ring-1 ring-sky-500' : ''}`}
                >
                  <div className="tabular text-[11px] text-slate-500">{cell.day}</div>
                  {hasData && (
                    <div className={`tabular text-[11px] leading-tight ${changeColor(cell.pnl)}`}>
                      {Math.abs(cell.pnl) >= 1000
                        ? `${cell.pnl > 0 ? '+' : '-'}${Math.round(Math.abs(cell.pnl) / 1000)}k`
                        : Math.round(cell.pnl)}
                    </div>
                  )}
                </button>
              );
            })}

            {/* 這一週的損益，與左邊七格同一列 */}
            <button
              type="button"
              disabled={!week}
              onClick={() =>
                pick(
                  `week-${row}`,
                  `${week.from} ～ ${week.to}（${week.days} 個交易日）`,
                  week.total
                )
              }
              // 與日期格一致：格子只顯示到千位，對帳時需要完整金額。
              title={
                week
                  ? `${week.from} ～ ${week.to}　${money(week.total)}（${week.days} 個交易日）`
                  : undefined
              }
              className={`tabular flex items-center justify-center rounded border border-slate-800/60 text-[11px] ${changeColor(
                week?.total ?? null
              )} ${selected?.key === `week-${row}` ? 'ring-1 ring-sky-500' : ''}`}
            >
              {week === null
                ? ''
                : Math.abs(week.total) >= 1000
                  ? `${week.total > 0 ? '+' : '-'}${Math.round(Math.abs(week.total) / 1000)}k`
                  : Math.round(week.total)}
            </button>
          </Fragment>
        ))}
      </div>

      {/*
        點選後的完整金額。
        手機沒有 hover，title 永遠看不到，格子本身又只顯示到千位。
        固定佔一行高度，選與不選之間不會讓下方內容跳動。
      */}
      <div className="mt-2 min-h-5 text-center text-[11px]">
        {selected ? (
          <span className="tabular">
            <span className="text-slate-400">{selected.label}</span>
            <span className={`ml-2 font-medium ${changeColor(selected.amount)}`}>
              {money(selected.amount)}
            </span>
          </span>
        ) : (
          <span className="text-slate-600">點一下日期或右側週欄，顯示完整金額</span>
        )}
      </div>
    </div>
  );
}
