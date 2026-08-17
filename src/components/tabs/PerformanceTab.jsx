import { useEffect, useMemo, useState } from 'react';
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
import { Upload, CalendarClock } from 'lucide-react';
import { loadHistory, loadQuotes } from '../../store/marketSlice.js';
import {
  today as todayDate,
  setStatsStartDate,
  setWeeklySnapshots,
} from '../../store/portfolioSlice.js';
import {
  normalizeTransactions,
  buildEquityCurve,
  aggregateByMonth,
  aggregateByYear,
  realizedSummary,
  positionSummary,
  todayPnl,
} from '../../lib/performance.js';
import {
  parseWeeklyWorkbook,
  monthlyFromSnapshots,
  yearlyFromSnapshots,
} from '../../lib/weeklyImport.js';
import { money, pct, num, int, changeColor } from '../../lib/format.js';
import PnlCalendar from '../PnlCalendar.jsx';

/** 月損益走勢顯示的月份數。 */
const MONTHS_SHOWN = 18;

/**
 * 績效頁：損益追蹤與歷年報酬。
 */
export default function PerformanceTab() {
  const dispatch = useDispatch();
  const { holdings, transactions, cashFlows, cash, statsStartDate, weeklySnapshots } = useSelector(
    (s) => s.portfolio
  );
  const history = useSelector((s) => s.market.history);
  const quotes = useSelector((s) => s.market.quotes);
  const loadingHistory = useSelector((s) => s.market.loading.history);

  const [importMsg, setImportMsg] = useState('');
  const [importOptions, setImportOptions] = useState(null);
  /** 月走勢與歷年績效的資料來源：curve 為權益曲線、snapshots 為匯入的週記帳。 */
  const [source, setSource] = useState('auto');

  // 權益曲線需要歷史股價，範圍是目前持股「加上」曾經交易過但已出清的標的。
  // 只抓目前持股會讓已平倉部位在持有期間的市值被算成零，整條曲線都會失真。
  const historyCodes = useMemo(
    () => [...new Set([...holdings.map((h) => h.code), ...transactions.map((t) => t.code)])],
    [holdings, transactions]
  );
  const codesKey = historyCodes.join(',');

  // 報價要涵蓋目前持股「加上」今日成交過的標的。
  // 今天全數賣出的標的已不在持股清單，若不抓它的報價就拿不到現價與昨收，
  // 當日損益會整筆被當成無資料而漏算。
  const quoteCodesKey = useMemo(() => {
    const day = todayDate();
    const codes = new Set(holdings.map((h) => h.code));
    for (const t of transactions) {
      if (t.date === day) codes.add(t.code);
    }
    return [...codes].join(',');
  }, [holdings, transactions]);

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
    () => normalizeTransactions(holdings, transactions, statsStartDate),
    [holdings, transactions, statsStartDate]
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

  const curveMonthly = useMemo(() => aggregateByMonth(curve), [curve]);
  const curveYearly = useMemo(() => aggregateByYear(curve), [curve]);
  const realized = useMemo(() => realizedSummary(transactions), [transactions]);

  // 試算表通常把整年的列都預先填好，未來日期的值與最後一筆相同、週損益為零。
  // 那些列進到圖表只會產生一堆空月份，先濾掉。
  const usableSnapshots = useMemo(() => {
    const day = todayDate();
    return (weeklySnapshots ?? []).filter((s) => s.date <= day);
  }, [weeklySnapshots]);

  const hasSnapshots = usableSnapshots.length > 0;
  // auto 表示有匯入資料就優先採用，因為它涵蓋的期間比權益曲線長。
  const activeSource = source === 'auto' ? (hasSnapshots ? 'snapshots' : 'curve') : source;
  const useSnapshots = activeSource === 'snapshots' && hasSnapshots;

  const monthly = useMemo(
    () =>
      (useSnapshots ? monthlyFromSnapshots(usableSnapshots) : curveMonthly).slice(-MONTHS_SHOWN),
    [useSnapshots, usableSnapshots, curveMonthly]
  );
  const yearly = useMemo(
    () => (useSnapshots ? yearlyFromSnapshots(usableSnapshots) : curveYearly),
    [useSnapshots, usableSnapshots, curveYearly]
  );

  /** 讀取試算表並存入週記帳。多帳戶時先讓使用者選擇。 */
  async function handleImport(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setImportMsg('讀取中…');
    setImportOptions(null);
    try {
      const result = await parseWeeklyWorkbook(file);
      const accounts = Object.keys(result.accounts);
      if (accounts.length === 0) {
        setImportMsg(result.warnings.join('；') || '檔案中沒有可用的週記帳資料');
        return;
      }
      if (accounts.length > 1) {
        // 一份檔案含多個帳戶時不能擅自合併，兩個帳戶的成本與庫存是各自獨立的。
        setImportOptions(result);
        setImportMsg(`檔案含 ${accounts.length} 個帳戶，請選擇要匯入哪一個`);
        return;
      }
      applyImport(result, accounts[0]);
    } catch (err) {
      setImportMsg(`匯入失敗：${err.message}`);
    }
  }

  /** 套用指定帳戶的週記帳。 */
  function applyImport(result, account) {
    const rows = result.accounts[account];
    dispatch(setWeeklySnapshots(rows));
    setImportOptions(null);
    setSource('snapshots');
    const warn = result.warnings.length ? `　注意：${result.warnings.join('；')}` : '';
    setImportMsg(
      `已匯入「${account}」共 ${rows.length} 筆週記帳，` +
        `期間 ${rows[0].date} 至 ${rows[rows.length - 1].date}${warn}`
    );
  }
  // 帶入交易紀錄與今日日期，當日損益才能把今天成交的部位按成交價計算，
  // 而不是把整日漲跌套用在成交後的股數上。
  const today = useMemo(
    () => todayPnl(holdings, quotes, transactions, todayDate()),
    [holdings, quotes, transactions]
  );

  // 成本法的部位彙總，與持股頁共用同一個函式，兩頁數字保證一致。
  const position = useMemo(() => positionSummary(holdings, quotes, cash), [holdings, quotes, cash]);

  const latest = curve[curve.length - 1] ?? null;
  const currentMonth = latest?.date.slice(0, 7);
  // 當月損益固定取權益曲線，與每日損益月曆同源。
  // 匯入的週記帳最新只到上一個記帳日，當月數字會落後。
  const monthPnl = curveMonthly.find((m) => m.month === currentMonth)?.pnl ?? 0;

  // 總損益採成本法：已實現加未實現。
  //
  // 不用權益曲線的累積損益，因為那等於「今日市值 − 建倉登記日市值」，完全不看成本。
  // 直接輸入既有部位時，登記日之前的獲利不存在於曲線中；若登記當天行情比現在高，
  // 累積損益還會變成負數，與實際帳面獲利完全相反。
  const totalPnl = realized.total + position.unrealized;

  // 曲線的起算日。若晚於本月一日，當月損益只涵蓋部分月份，必須明示，
  // 否則使用者會以為那是整個月的損益。
  const curveStart = curve[0]?.date ?? null;
  const monthStart = currentMonth ? `${currentMonth}-01` : null;
  const monthPartial = Boolean(curveStart && monthStart && curveStart > monthStart);

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
        <Summary
          label="當月損益"
          value={money(monthPnl)}
          tone={monthPnl}
          sub={monthPartial ? `僅涵蓋 ${curveStart} 起` : (currentMonth ?? '')}
        />
        <Summary
          label="總損益"
          value={money(totalPnl)}
          tone={totalPnl}
          sub={`已實現 ${money(realized.total)}　未實現 ${money(position.unrealized)}`}
        />
        <Summary
          label="總淨值"
          value={money(position.netWorth)}
          sub={`市值 ${money(position.totalValue)}　現金 ${money(cash)}`}
        />
      </div>

      {/* 統計區間與外部資料匯入 */}
      <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <label className="flex items-center gap-2 text-xs text-slate-400">
            <CalendarClock size={14} />
            統計起算日
            <input
              type="date"
              value={statsStartDate ?? ''}
              onChange={(e) => dispatch(setStatsStartDate(e.target.value))}
              className="tabular rounded border border-slate-700 bg-slate-800 px-2 py-1 text-slate-100"
            />
          </label>
          {statsStartDate && (
            <button
              type="button"
              onClick={() => dispatch(setStatsStartDate(null))}
              className="text-xs text-slate-500 underline hover:text-slate-300"
            >
              清除
            </button>
          )}

          <label className="flex cursor-pointer items-center gap-1.5 rounded border border-slate-700 px-2.5 py-1.5 text-xs text-slate-300 transition hover:border-slate-500">
            <Upload size={13} /> 匯入週記帳試算表
            <input type="file" accept=".xlsx,.xls" onChange={handleImport} className="hidden" />
          </label>
          {hasSnapshots && (
            <button
              type="button"
              onClick={() => {
                dispatch(setWeeklySnapshots([]));
                setSource('curve');
                setImportMsg('已清除匯入的週記帳');
              }}
              className="text-xs text-slate-500 underline hover:text-slate-300"
            >
              清除匯入資料
            </button>
          )}
        </div>

        <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
          持股若在某日之前就已買進且之後沒有異動，把起算日設為那天，每日損益月曆即可正確回推——
          持股數固定，缺的只是每日收盤價。留空則各持股用自己的建倉日。
          月走勢與歷年績效要回溯更早的期間，需匯入「YYYY損益表」格式的週記帳試算表。
        </p>

        {importMsg && <p className="mt-2 text-[11px] text-sky-400">{importMsg}</p>}

        {importOptions && (
          <div className="mt-2 flex flex-wrap gap-2">
            {Object.keys(importOptions.accounts).map((acc) => (
              <button
                key={acc}
                type="button"
                onClick={() => applyImport(importOptions, acc)}
                className="rounded border border-sky-700 bg-sky-600/20 px-2.5 py-1 text-xs text-sky-300 transition hover:bg-sky-600/30"
              >
                匯入 {acc}（{importOptions.accounts[acc].length} 筆）
              </button>
            ))}
          </div>
        )}
      </section>

      {monthPartial && !useSnapshots && (
        <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-3 text-xs text-slate-400">
          損益走勢的統計區間自 <span className="tabular">{curveStart}</span> 起算，
          那是最早一筆交易紀錄或持股建倉日。此日之前的損益不在下方的月曆、月走勢與歷年績效中。
          若持股在更早之前就已買進且之後沒有異動，把上方的統計起算日設到那天即可回推。
          上方的「總損益」採成本法，不受此限制。
        </div>
      )}

      {/* 今日逐檔明細 */}
      <Panel
        title="今日各檔損益"
        note="盤中為即時試算，可與券商對照。今日成交的部位以成交價計算價差，不套用整日漲跌"
      >
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
                    {item.name && <span className="ml-1.5 text-slate-500">{item.name}</span>}
                    {item.tradedShares !== 0 && (
                      <span className="ml-1.5 rounded bg-sky-950/60 px-1 py-0.5 text-[10px] text-sky-400">
                        今日成交 {int(item.tradedShares)}
                      </span>
                    )}
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
      <Panel
        title={`每月損益走勢（近 ${MONTHS_SHOWN} 個月）`}
        note={
          useSnapshots
            ? `資料來源：匯入的週記帳，採試算表自己的當周損益金額。` +
              `期間 ${usableSnapshots[0].date} 至 ${usableSnapshots[usableSnapshots.length - 1].date}`
            : curveStart
              ? `資料來源：權益曲線，以每日淨值變動加總並扣除資金進出。` +
                `統計自 ${curveStart} 起，區間內累計 ${money(latest?.cumulativePnl ?? 0)}`
              : '資料來源：權益曲線，以每日淨值變動加總並扣除資金進出'
        }
        action={
          hasSnapshots && (
            <div className="flex gap-1 text-[11px]">
              {[
                ['snapshots', '週記帳'],
                ['curve', '權益曲線'],
              ].map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setSource(key)}
                  className={`rounded border px-2 py-0.5 transition ${
                    activeSource === key
                      ? 'border-sky-600 bg-sky-600/20 text-sky-300'
                      : 'border-slate-700 text-slate-500 hover:text-slate-300'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          )
        }
      >
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
        note={
          useSnapshots
            ? '資料來源：匯入的週記帳。年度損益為該年當周損益金額的加總，報酬率分母為該年度總成本，沿用試算表本身的定義'
            : '資料來源：權益曲線。年度報酬率的分母為年初淨值加該年淨入金，未做時間加權；年中有大額入金時報酬率會被低估'
        }
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

function Panel({ title, note, action, children }) {
  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-slate-300">{title}</h3>
        {action}
      </div>
      {note && <p className="mb-3 mt-0.5 text-[11px] leading-relaxed text-slate-600">{note}</p>}
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
