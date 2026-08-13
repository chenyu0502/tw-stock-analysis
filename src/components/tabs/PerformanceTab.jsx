import { useEffect, useMemo } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import {
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts';
import { loadHistory, loadQuotes } from '../../store/marketSlice.js';
import {
  normalizeTransactions,
  buildEquityCurve,
  aggregateByMonth,
  aggregateByYear,
  realizedSummary,
  todayPnl,
} from '../../lib/performance.js';
import { money, pct, num, int, changeColor } from '../../lib/format.js';
import PnlCalendar from '../PnlCalendar.jsx';

/** 月損益走勢顯示的月份數。 */
const MONTHS_SHOWN = 18;

/**
 * 績效頁：損益追蹤與歷年報酬。
 */
export default function PerformanceTab() {
  const dispatch = useDispatch();
  const { holdings, transactions, cashFlows, cash } = useSelector((s) => s.portfolio);
  const history = useSelector((s) => s.market.history);
  const quotes = useSelector((s) => s.market.quotes);
  const loadingHistory = useSelector((s) => s.market.loading.history);

  // 權益曲線需要歷史股價，範圍是目前持股「加上」曾經交易過但已出清的標的。
  // 只抓目前持股會讓已平倉部位在持有期間的市值被算成零，整條曲線都會失真。
  const historyCodes = useMemo(
    () => [...new Set([...holdings.map((h) => h.code), ...transactions.map((t) => t.code)])],
    [holdings, transactions]
  );
  const codesKey = historyCodes.join(',');
  const quoteCodesKey = holdings.map((h) => h.code).join(',');

  useEffect(() => {
    if (!codesKey) return;
    if (quoteCodesKey) dispatch(loadQuotes(quoteCodesKey.split(',')));
    codesKey.split(',').forEach((code) => {
      if (!history[code]) dispatch(loadHistory({ code, range: '2y' }));
    });
    // history 刻意不列入相依，否則每次寫入快取都會重新觸發整批載入。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [codesKey, quoteCodesKey, dispatch]);

  const allTransactions = useMemo(
    () => normalizeTransactions(holdings, transactions),
    [holdings, transactions]
  );

  const curve = useMemo(
    () =>
      buildEquityCurve({
        transactions: allTransactions,
        cashFlows,
        currentCash: cash,
        historyByCode: history,
      }),
    [allTransactions, cashFlows, cash, history]
  );

  const monthly = useMemo(() => aggregateByMonth(curve).slice(-MONTHS_SHOWN), [curve]);
  const yearly = useMemo(() => aggregateByYear(curve), [curve]);
  const realized = useMemo(() => realizedSummary(transactions), [transactions]);
  const today = useMemo(() => todayPnl(holdings, quotes), [holdings, quotes]);

  const latest = curve[curve.length - 1] ?? null;
  const currentMonth = latest?.date.slice(0, 7);
  const monthPnl = monthly.find((m) => m.month === currentMonth)?.pnl ?? 0;

  if (holdings.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-800 py-12 text-center text-sm text-slate-500">
        尚無持股部位，無法計算績效
      </div>
    );
  }

  const missingHistory = historyCodes.filter((code) => !history[code]).length;
  // 歷史現金由目前餘額往回推算，出現負值代表「帳上現金」與交易紀錄對不起來，
  // 通常是漏記了入金。這會讓淨值與報酬率失真，必須讓使用者知道。
  const hasNegativeCash = curve.some((r) => r.cash < 0);

  return (
    <div className="space-y-4">
      {hasNegativeCash && (
        <div className="rounded-lg border border-amber-800/60 bg-amber-950/30 p-3 text-xs text-amber-300">
          推算出的歷史現金曾為負值，代表「帳上現金」與交易紀錄不一致，通常是漏記了入金。
          請到持股頁補記資金進出，否則淨值與年度報酬率會失真。
        </div>
      )}

      {missingHistory > 0 && (
        <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-3 text-xs text-slate-400">
          {loadingHistory
            ? `正在抓取歷史股價（尚有 ${missingHistory} 檔）…`
            : `有 ${missingHistory} 檔缺少歷史股價，該部分未計入下方數字。`}
        </div>
      )}

      {/* 摘要 */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Summary label="今日損益" value={money(today.total)} tone={today.total} sub="即時試算" />
        <Summary label="當月損益" value={money(monthPnl)} tone={monthPnl} sub={currentMonth ?? ''} />
        <Summary
          label="累積損益"
          value={money(latest?.cumulativePnl ?? 0)}
          tone={latest?.cumulativePnl}
          sub="統計區間內"
        />
        <Summary label="總淨值" value={money(latest?.netWorth ?? cash)} sub={`含現金 ${money(cash)}`} />
      </div>

      {/* 今日逐檔明細 */}
      <Panel title="今日各檔損益" note="盤中為即時試算，可與券商對照">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-slate-500">
                <th className="pb-2 text-left font-normal">標的</th>
                <th className="pb-2 text-right font-normal">股數</th>
                <th className="pb-2 text-right font-normal">漲跌</th>
                <th className="pb-2 text-right font-normal">幅度</th>
                <th className="pb-2 text-right font-normal">損益</th>
              </tr>
            </thead>
            <tbody className="tabular">
              {today.items.map((item) => (
                <tr key={item.code} className="border-t border-slate-800/60">
                  <td className="py-1.5">
                    <span className="text-slate-300">{item.code}</span>
                    <span className="ml-1.5 text-slate-500">{item.name}</span>
                  </td>
                  <td className="py-1.5 text-right text-slate-400">{int(item.shares)}</td>
                  <td className={`py-1.5 text-right ${changeColor(item.change)}`}>{num(item.change)}</td>
                  <td className={`py-1.5 text-right ${changeColor(item.change)}`}>
                    {pct(item.changePercent, 2, true)}
                  </td>
                  <td className={`py-1.5 text-right ${changeColor(item.pnl)}`}>{money(item.pnl)}</td>
                </tr>
              ))}
              <tr className="border-t border-slate-700">
                <td className="py-1.5 text-slate-400" colSpan={4}>
                  合計
                </td>
                <td className={`tabular py-1.5 text-right font-medium ${changeColor(today.total)}`}>
                  {money(today.total)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </Panel>

      {/* 每日損益月曆 */}
      <Panel title="每日損益月曆">
        <PnlCalendar curve={curve} />
      </Panel>

      {/* 每月損益走勢 */}
      <Panel title={`每月損益走勢（近 ${MONTHS_SHOWN} 個月）`}>
        {monthly.length === 0 ? (
          <div className="py-8 text-center text-sm text-slate-500">資料不足</div>
        ) : (
          <div className="h-48 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={monthly} margin={{ top: 8, right: 4, bottom: 0, left: 4 }}>
                <CartesianGrid stroke="#1e293b" vertical={false} />
                <XAxis
                  dataKey="month"
                  tick={{ fill: '#64748b', fontSize: 10 }}
                  tickFormatter={(m) => m.slice(2)}
                  minTickGap={24}
                />
                <YAxis
                  tick={{ fill: '#64748b', fontSize: 10 }}
                  width={48}
                  tickFormatter={(v) => `${Math.round(v / 1000)}k`}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#0f172a',
                    border: '1px solid #334155',
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  labelStyle={{ color: '#94a3b8' }}
                  formatter={(value) => [money(value), '損益']}
                />
                <Bar dataKey="pnl" name="損益">
                  {/* 台股慣例紅漲綠跌，正負月份分別上色。 */}
                  {monthly.map((m) => (
                    <Cell key={m.month} fill={m.pnl >= 0 ? '#f43f5e' : '#10b981'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </Panel>

      {/* 歷年績效 */}
      <Panel
        title="歷年績效總覽"
        note="年度報酬率的分母為年初淨值加該年淨入金，未做時間加權；年中有大額入金時報酬率會被低估"
      >
        {yearly.length === 0 ? (
          <div className="py-8 text-center text-sm text-slate-500">資料不足</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-slate-500">
                  <th className="pb-2 text-left font-normal">年度</th>
                  <th className="pb-2 text-right font-normal">年度損益</th>
                  <th className="pb-2 text-right font-normal">年末淨值</th>
                  <th className="pb-2 text-right font-normal">年度報酬</th>
                  <th className="pb-2 text-right font-normal">累積報酬</th>
                </tr>
              </thead>
              <tbody className="tabular">
                {yearly.map((y) => (
                  <tr key={y.year} className="border-t border-slate-800/60">
                    <td className="py-1.5 text-slate-300">{y.year}</td>
                    <td className={`py-1.5 text-right ${changeColor(y.pnl)}`}>{money(y.pnl)}</td>
                    <td className="py-1.5 text-right text-slate-400">{money(y.endNetWorth)}</td>
                    <td className={`py-1.5 text-right ${changeColor(y.returnPercent)}`}>
                      {pct(y.returnPercent, 2, true)}
                    </td>
                    <td className={`py-1.5 text-right ${changeColor(y.cumulativeReturnPercent)}`}>
                      {pct(y.cumulativeReturnPercent, 2, true)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {/* 已實現損益 */}
      <Panel title="已實現損益" note="採平均成本法，含手續費與證交稅">
        {realized.count === 0 ? (
          <div className="py-6 text-center text-sm text-slate-500">尚無平倉紀錄</div>
        ) : (
          <>
            <div className="mb-3 grid grid-cols-3 gap-2">
              <Summary label="合計" value={money(realized.total)} tone={realized.total} />
              <Summary label="平倉次數" value={int(realized.count)} />
              <Summary label="勝率" value={pct(realized.winRate, 1)} />
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-slate-500">
                    <th className="pb-2 text-left font-normal">日期</th>
                    <th className="pb-2 text-left font-normal">標的</th>
                    <th className="pb-2 text-right font-normal">股數</th>
                    <th className="pb-2 text-right font-normal">成交價</th>
                    <th className="pb-2 text-right font-normal">損益</th>
                  </tr>
                </thead>
                <tbody className="tabular">
                  {realized.items.slice(0, 30).map((t) => (
                    <tr key={t.id} className="border-t border-slate-800/60">
                      <td className="py-1.5 text-slate-400">{t.date}</td>
                      <td className="py-1.5 text-slate-300">{t.code}</td>
                      <td className="py-1.5 text-right text-slate-400">{int(Math.abs(t.shares))}</td>
                      <td className="py-1.5 text-right text-slate-400">{num(t.price)}</td>
                      <td className={`py-1.5 text-right ${changeColor(t.realized)}`}>{money(t.realized)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Panel>
    </div>
  );
}

function Panel({ title, note, children }) {
  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-3">
      <h3 className="text-sm font-medium text-slate-300">{title}</h3>
      {note && <p className="mb-3 mt-0.5 text-[11px] text-slate-600">{note}</p>}
      <div className={note ? '' : 'mt-3'}>{children}</div>
    </section>
  );
}

function Summary({ label, value, sub, tone }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-2.5">
      <div className="text-[11px] text-slate-500">{label}</div>
      <div
        className={`tabular mt-0.5 text-sm font-semibold ${
          tone === undefined ? 'text-slate-100' : changeColor(tone)
        }`}
      >
        {value}
      </div>
      {sub && <div className="text-[10px] text-slate-600">{sub}</div>}
    </div>
  );
}
