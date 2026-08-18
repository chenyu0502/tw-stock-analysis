import { CalendarClock } from 'lucide-react';
import { daysBetween, THRESHOLDS } from '../lib/risks.js';
import { money, num, int } from '../lib/format.js';

/**
 * 持股的除權息提醒。
 *
 * 放在持股頁而不是只放在個股分析裡，是因為除息影響的是整個帳戶：
 * 持有十幾檔月配 ETF 時，光看單一檔看不出「這個月會有幾次、總共領多少」。
 *
 * 除息當天股價必然扣除配息金額，帳面市值同步下降。不知情的人會以為是下跌，
 * 但錢只是還沒入帳——實際撥付約在除息後一個多月。這個提醒就是為了避免那個誤解。
 *
 * @param {{ holdings: object[], exDividend: Record<string, object>, today?: string }} props
 */
export default function ExDividendNotice({ holdings, exDividend, today = null }) {
  const base = today ?? new Date().toISOString().slice(0, 10);

  const items = holdings
    .map((h) => {
      const schedule = exDividend[h.code];
      if (!schedule?.date) return null;
      const days = daysBetween(base, schedule.date);
      if (days === null || days < 0 || days > THRESHOLDS.exDividendWithinDays) return null;
      return {
        ...schedule,
        shares: h.shares,
        days,
        // 金額尚未公告時不估算，寧可留白也不要給一個會被當真的數字。
        amount: Number.isFinite(schedule.cash) ? schedule.cash * h.shares : null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.days - b.days || a.code.localeCompare(b.code));

  if (items.length === 0) return null;

  const known = items.filter((i) => i.amount !== null);
  const total = known.reduce((acc, i) => acc + i.amount, 0);
  const pending = items.length - known.length;

  return (
    <section className="rounded-xl border border-sky-900/60 bg-sky-950/20 p-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <CalendarClock size={14} className="text-sky-400" />
        <h3 className="text-sm font-medium text-sky-300">
          未來 {THRESHOLDS.exDividendWithinDays} 天內有 {items.length} 檔持股除權息
        </h3>
        {known.length > 0 && (
          <span className="tabular text-xs text-sky-400/80">
            預計可領 {money(total)}
            {pending > 0 && `（另有 ${pending} 檔金額待公告）`}
          </span>
        )}
      </div>

      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-slate-500">
              <th className="pb-1 text-left font-normal">除息日</th>
              <th className="pb-1 text-left font-normal">標的</th>
              <th className="pb-1 text-right font-normal">股數</th>
              <th className="pb-1 text-right font-normal">每股配息</th>
              <th className="pb-1 text-right font-normal">預計金額</th>
            </tr>
          </thead>
          <tbody className="tabular">
            {items.map((item) => (
              <tr key={`${item.code}-${item.date}`} className="border-t border-slate-800/60">
                <td className="py-1 text-slate-400">
                  {item.date.slice(5)}
                  <span className="ml-1.5 text-[10px] text-slate-600">
                    {item.days === 0 ? '今日' : `${item.days} 天後`}
                  </span>
                </td>
                <td className="py-1 text-slate-300">
                  {item.code}
                  {item.name && <span className="ml-1.5 text-slate-500">{item.name}</span>}
                </td>
                <td className="py-1 text-right text-slate-400">{int(item.shares)}</td>
                <td className="py-1 text-right text-slate-400">
                  {Number.isFinite(item.cash) ? num(item.cash, 2) : '待公告'}
                </td>
                <td className="py-1 text-right text-slate-300">
                  {item.amount === null ? '—' : money(item.amount)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
        除息當日股價會直接扣除配息金額，帳面市值同步下降，那不是下跌。
        現金約在除息後一個多月撥付。績效頁的每日損益已在除息日把這筆金額計入，不會出現假性虧損。
        金額為預估值，實際以發放通知為準；含股票股利者股數也會變動，需自行補記。
      </p>
    </section>
  );
}
