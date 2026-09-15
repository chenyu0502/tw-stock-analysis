import { CalendarClock } from 'lucide-react';
import { daysBetween, THRESHOLDS } from '../lib/risks.js';
import { money, dividend, int } from '../lib/format.js';

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
              <th className="pb-1 text-left font-normal">標的</th>
              <th className="pb-1 text-left font-normal">除息日</th>
              <th className="pb-1 text-left font-normal">發放日</th>
              <th className="pb-1 text-right font-normal">股數</th>
              <th className="pb-1 text-right font-normal">每股配息</th>
              <th className="pb-1 text-right font-normal">預計金額</th>
            </tr>
          </thead>
          <tbody className="tabular">
            {items.map((item) => (
              <tr key={`${item.code}-${item.date}`} className="border-t border-slate-800/60">
                <td className="py-1 text-slate-300">
                  {item.code}
                  {item.name && <span className="ml-1.5 text-slate-500">{item.name}</span>}
                </td>
                <td className="py-1 text-slate-400">
                  {item.date.slice(5)}
                  <span className="ml-1.5 text-[11px] text-slate-600">
                    {item.days === 0 ? '今日' : `${item.days} 天後`}
                  </span>
                </td>
                <td className="py-1 text-slate-400">
                  {item.payDate ? (
                    <>
                      {shortDate(item.payDate, item.date)}
                      <span className="ml-1.5 text-[11px] text-slate-600">
                        {waitDays(item.date, item.payDate)}
                      </span>
                    </>
                  ) : (
                    <span className="text-slate-600">待公告</span>
                  )}
                </td>
                <td className="py-1 text-right text-slate-400">{int(item.shares)}</td>
                <td className="py-1 text-right text-slate-400">
                  {Number.isFinite(item.cash) ? dividend(item.cash) : '待公告'}
                </td>
                <td className="py-1 text-right text-slate-300">
                  {item.amount === null ? '—' : money(item.amount)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-2 text-[12px] leading-relaxed text-slate-500">
        除息當日股價會直接扣除配息金額，帳面市值同步下降，那不是下跌，錢只是還沒入帳。
        績效頁的每日損益已在除息日把這筆金額計入，不會出現假性虧損。
        發放日為公司或投信公告的現金股利撥付日，尚未公告時顯示「待公告」；
        金額為預估值，實際以發放通知為準；含股票股利者股數也會變動，需自行補記。
      </p>
    </section>
  );
}

/**
 * 發放日的顯示格式。
 *
 * 同一年只顯示月日，與除息日的格式一致；跨年時顯示完整日期——
 * 十二月除息、隔年二月發放是常見情形，只顯示「02-10」會被讀成兩個月前。
 *
 * @param {string} payDate
 * @param {string} exDate
 * @returns {string}
 */
function shortDate(payDate, exDate) {
  return payDate.slice(0, 4) === exDate.slice(0, 4) ? payDate.slice(5) : payDate;
}

/**
 * 除息到撥付要等幾天。
 *
 * 顯示等待天數而不是「距今幾天」，因為這一欄要回答的是「錢什麼時候到」，
 * 而使用者心裡的參照點是除息日那一天。
 *
 * @param {string} exDate
 * @param {string} payDate
 * @returns {string}
 */
function waitDays(exDate, payDate) {
  const days = daysBetween(exDate, payDate);
  return days === null || days < 0 ? '' : `除息後 ${days} 天`;
}
