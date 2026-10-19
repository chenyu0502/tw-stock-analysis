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
import { CalendarClock } from 'lucide-react';
import { loadHistory, loadQuotes, isHistoryStale } from '../../store/marketSlice.js';
import {
  today as todayDate,
  setStatsStartDate,
  dropTransactionsForCodes,
} from '../../store/portfolioSlice.js';
import {
  normalizeTransactions,
  buildEquityCurve,
  aggregateByMonth,
  aggregateByYear,
  realizedSummary,
  positionSummary,
  todayPnl,
  reconcileShares,
  reconcileToday,
} from '../../lib/performance.js';
import {
  money,
  pct,
  num,
  int,
  changeColor,
  limitState,
  limitBlockClass,
  limitLabel,
} from '../../lib/format.js';
import PnlCalendar from '../PnlCalendar.jsx';

/** 月損益走勢顯示的月份數。 */
const MONTHS_SHOWN = 18;

/**
 * 檢查歷史股價缺漏時回溯的交易日數。
 *
 * 只看最近這段就夠：更早的缺漏對當期對帳沒有意義，全部列出來反而會把
 * 真正要處理的那幾天淹掉。二十天涵蓋約一個月，足以對完整個當月月曆。
 */
const RECENT_DAYS_CHECKED = 20;

/**
 * 同一檔最多自動重抓幾次。
 *
 * 一定要有上限。重抓完成後 history 更新，偵測若仍成立就會再觸發一次，
 * 沒有上限就是無限迴圈——而且上游真的沒有那幾天時，這個迴圈永遠不會停。
 *
 * 取 2 而不是 1：伺服器端有多個 serverless 實例，各自有獨立的記憶體快取，
 * 第一次抓到殘缺資料的那個實例未必是第二次服務的那個。這正是同一時間
 * 手機正確、桌機錯誤的成因，也是重抓有效的原因。
 */
const MAX_AUTO_REPAIR = 2;

/**
 * 自動修復一次最多同時重抓幾檔。
 *
 * 每一檔是兩年份的日 K，伺服器端還要為它抓官方月報表校正近幾日收盤。
 * 一次派發十幾檔正是 README 記載過把 `/api/history` 打到 504 的請求形狀。
 * 分批派發，剩下的由下一輪偵測接手——偵測本來就會在 history 更新後重跑。
 */
const AUTO_REPAIR_BATCH = 5;

/**
 * 績效頁：損益追蹤與歷年報酬。
 */
export default function PerformanceTab() {
  const dispatch = useDispatch();
  const { holdings, transactions, cashFlows, cash, statsStartDate } = useSelector(
    (s) => s.portfolio
  );
  const history = useSelector((s) => s.market.history);
  const quotes = useSelector((s) => s.market.quotes);
  const loadingHistory = useSelector((s) => s.market.loading.history);
  // 自動修復要知道哪幾檔正在請求中，否則會對同一檔重複派發、白白用掉重試次數。
  const historyPending = useSelector((s) => s.market.historyPending);

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

  // 換日後要重抓日 K。應用程式開著跨過換日時，舊資料會讓月曆少掉今天那格，
  // 昨天那格也會停在昨天盤中的價格。把日期放進相依，切回這一頁就會補抓。
  const day = todayDate();

  useEffect(() => {
    if (!codesKey) return;
    if (quoteCodesKey) dispatch(loadQuotes(quoteCodesKey.split(',')));
    codesKey.split(',').forEach((code) => {
      if (isHistoryStale(history[code])) dispatch(loadHistory({ code, range: '2y' }));
    });
    // history 刻意不列入相依，否則每次寫入快取都會重新觸發整批載入。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [codesKey, quoteCodesKey, day, dispatch]);

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
        startDate: statsStartDate,
        // 帶入即時報價，月曆今天那格才會與上方的「今日損益」同一個口徑。
        quotes,
        todayDate: todayDate(),
        // 帶入持股清單，曲線的股數才會校正為與持股頁一致。
        holdings,
      }),
    [allTransactions, cashFlows, cash, history, statsStartDate, quotes, holdings]
  );

  // 交易紀錄累加出來的股數與持股清單不一致的標的。
  // 最常見的成因是交易紀錄重複匯入，會讓每日損益整段等比例放大。
  const shareMismatch = useMemo(
    () => reconcileShares(allTransactions, holdings),
    [allTransactions, holdings]
  );
  // 只有「進出紀錄比持股清單多」才是真的有問題。
  //
  // reconcileShares 的差額 = 持股清單 − 進出紀錄累計：
  //
  // - **差額為正**（紀錄少於持股）是**正常情形**，不該警告。開始記錄交易之前就持有的
  //   部位本來就沒有紀錄，曲線會把差額當成期初部位，算出來的損益完全正確。
  //   買零股時尤其明顯：手上四千多股、紀錄只有剛買的九十五股，那不是資料壞掉。
  // - **差額為負**（紀錄多於持股）才有問題：期初部位會變成負數，等於曲線從一個
  //   不存在的空單開始。重複匯入交易紀錄就是這個形狀，每日損益會整段放大。
  const mismatchCodes = Object.keys(shareMismatch).filter((code) => shareMismatch[code] < 0);

  // 完全沒有歷史股價的持股。
  //
  // 這種標的在曲線裡只能用即時報價推得的昨收評價，過去每一天都是同一個價格，
  // 等於整段沒有損益。載入失敗（例如 history 回應 504）時就會這樣，
  // 而且畫面上原本毫無跡象——月曆看起來只是「數字怪怪的」。
  const noHistoryCodes = useMemo(
    () => holdings.filter((h) => (history[h.code]?.candles?.length ?? 0) === 0).map((h) => h.code),
    [holdings, history]
  );

  // 歷史股價缺了交易日的持股。
  //
  // 有資料但缺了幾天，比完全沒有資料更難察覺，而且會**把損益在日期之間搬移**：
  // 缺 K 棒的那天會沿用前一日收盤，於是那天少算了它的漲跌，
  // 下一個有價格的日子再一次補回來。兩天的合計沒錯，逐日數字全錯。
  //
  // 兩種形狀都會發生，而且都實測過：
  //
  // - **尾端落後**：3481 的歷史停在 09-03 時，09-04 少 1,200、09-07 多 1,200。
  //   成因是某一台裝置重抓失敗，另一台正常，於是兩台顯示不同數字。
  // - **中間有洞**：Yahoo 對台股 ETF 常給 null 收盤（實測 00915 的 09-07），
  //   正常由官方月報表補上，那一趟失敗時整根 K 棒會消失。五檔 ETF 同時缺
  //   09-07 時，09-07 與 09-08 各差七千多元。這種洞不在尾端，只比對最後一天
  //   完全看不出來。
  //
  // 因此改成比對「其他標的有、這一檔沒有」的交易日，兩種形狀一起涵蓋。
  // 不需要台股行事曆；只看最近這段，更早的缺漏對當期對帳沒有意義。
  // 該檔第一根 K 棒之前的日期不算，新上市的標的不該被誤報。
  //
  // **今天那一格必須排除，否則會變成大規模假警報。**
  //
  // 今天的 K 棒不是同時到齊的：Yahoo 對台股 ETF 的當日收盤常給 null，
  // 那種列會被伺服器濾掉，而正常交易的個股有值、會保留。於是「所有標的的
  // 日期聯集」含有今天，沒有今天那根的標的**全部**被判為缺漏——
  // 實際遇到的是一次報 16 檔。
  //
  // 而且這種警報既無意義也修不掉：
  //
  // 1. 無意義——今天那根 K 棒在權益曲線裡從頭到尾用不到，一律以即時報價評價
  //    （見 buildEquityCurve 的 liveDate）。缺它不影響任何數字。
  // 2. 修不掉——重抓也拿不到上游還沒發布的當日收盤，自動修復只是白跑，
  //    16 檔 × 2 次 × 兩年份的請求形狀正是先前把 /api/history 打到 504 的那一種。
  //
  // 昨天以前不排除：那些日子的 K 棒確實會被用到，缺了就是真的會算錯。
  const staleHistoryCodes = useMemo(() => {
    const candlesOf = (code) => history[code]?.candles ?? [];
    const union = new Set();
    for (const h of holdings) for (const c of candlesOf(h.code)) union.add(c.date);
    const recent = [...union]
      .filter((d) => d < day)
      .sort()
      .slice(-RECENT_DAYS_CHECKED);
    if (recent.length === 0) return [];

    return holdings
      .map((h) => {
        const candles = candlesOf(h.code);
        // 完全沒有資料的由 noHistoryCodes 負責，不重複提示。
        if (candles.length === 0) return null;
        const own = new Set(candles.map((c) => c.date));
        const first = candles[0].date;
        const missing = recent.filter((d) => d >= first && !own.has(d));
        return missing.length > 0 ? { code: h.code, missing } : null;
      })
      .filter(Boolean);
  }, [holdings, history, day]);

  /**
   * 偵測到歷史股價缺了交易日就自動重抓，不必等使用者發現頁面下方的警告。
   *
   * 這個缺陷的症狀是**數字安靜地錯掉**：缺 K 棒的那天沿用前一筆收盤價，
   * 當日損益被挪到下一個有價格的日子，兩天合計正確、逐日數字全錯。
   * 而警告在月曆下方，實際使用時很容易整天沒注意到。
   *
   * 已在請求中的不重複派發，也不計入次數——那一次本來就會帶回新資料，
   * 把它算成一次嘗試等於平白浪費配額。
   */
  const [repairAttempts, setRepairAttempts] = useState({});

  useEffect(() => {
    const targets = staleHistoryCodes
      .map((h) => h.code)
      .filter((code) => !historyPending[code] && (repairAttempts[code] ?? 0) < MAX_AUTO_REPAIR)
      .slice(0, AUTO_REPAIR_BATCH);
    if (targets.length === 0) return;

    setRepairAttempts((prev) => {
      const next = { ...prev };
      for (const code of targets) next[code] = (next[code] ?? 0) + 1;
      return next;
    });
    for (const code of targets) dispatch(loadHistory({ code, range: '2y' }));
  }, [staleHistoryCodes, historyPending, repairAttempts, dispatch]);

  // 還有機會自動修好的期間顯示「正在重新載入」，用完次數仍缺才顯示警告。
  // 兩者分開是因為意義不同：前者是暫時狀態，後者代表上游真的沒有那幾天，
  // 數字確實不可信，使用者需要知道。
  const repairing = staleHistoryCodes.some(
    (h) => historyPending[h.code] || (repairAttempts[h.code] ?? 0) < MAX_AUTO_REPAIR
  );

  const curveMonthly = useMemo(() => aggregateByMonth(curve), [curve]);
  const yearly = useMemo(() => aggregateByYear(curve), [curve]);
  const realized = useMemo(() => realizedSummary(transactions), [transactions]);
  const monthly = useMemo(() => curveMonthly.slice(-MONTHS_SHOWN), [curveMonthly]);
  // 當日損益一律「庫存股數 × 當日漲跌」，不對今日成交做特別處理、也不扣手續費。
  // 理由見 todayPnl：交易紀錄的日期是登錄日而非成交日，特別處理反而會算錯。
  //
  // 漲跌停狀態另外併上去。todayPnl 只負責損益計算，刻意不帶報價的漲跌停欄位，
  // 那是顯示用的資訊；在這裡補一次，每一列只判定一次。
  const today = useMemo(() => {
    const result = todayPnl(holdings, quotes);
    return {
      ...result,
      items: result.items.map((i) => ({ ...i, limit: limitState(quotes[i.code]) })),
    };
  }, [holdings, quotes]);

  // 今日各檔損益與月曆今天那格的逐檔對帳。純計算，不發任何請求。
  const reconcile = useMemo(
    () =>
      reconcileToday({
        curve,
        holdings,
        quotes,
        transactions,
        historyByCode: history,
        todayDate: todayDate(),
      }),
    [curve, holdings, quotes, transactions, history]
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
  //
  // 配息採除息日應計，但實際入帳約在一個多月後，「帳上現金」多半還沒收到這筆錢，
  // 往回推算的歷史現金會整段偏低。檢查時把累計配息加回，否則單純因為配息就會誤報。
  const totalDividend = latest?.cumulativeDividend ?? 0;
  const hasNegativeCash = curve.some(
    (r) => r.cash + (totalDividend - (r.cumulativeDividend ?? 0)) < 0
  );

  return (
    <div className="space-y-4">
      {hasNegativeCash && (
        <div className="rounded-lg border border-amber-800/60 bg-amber-950/30 p-3 text-xs text-amber-300">
          推算出的歷史現金曾為負值，代表「帳上現金」與交易紀錄不一致，通常是漏記了入金。
          請到持股頁補記資金進出，否則淨值與年度報酬率會失真。
        </div>
      )}

      {mismatchCodes.length > 0 && (
        <div className="rounded-lg border border-amber-800/60 bg-amber-950/30 p-3 text-xs text-amber-300">
          <div className="leading-relaxed">
            以下 {mismatchCodes.length} 檔的「進出紀錄」累計股數<span className="text-amber-200">多於</span>
            持股清單。
            <span className="text-amber-200">下方所有數字已改以持股清單為準，是正確的。</span>
          </div>
          <ul className="tabular mt-2 space-y-0.5">
            {mismatchCodes.slice(0, 12).map((code) => {
              const target = holdings.find((h) => h.code === code)?.shares ?? 0;
              return (
                <li key={code}>
                  {code}　持股清單 {int(target)} 股　進出紀錄累計 {int(target - shareMismatch[code])} 股
                </li>
              );
            })}
            {mismatchCodes.length > 12 && <li>…另有 {mismatchCodes.length - 12} 檔</li>}
          </ul>
          <p className="mt-2 leading-relaxed text-amber-400/90">
            最常見的成因是同一檔重複輸入或重複匯入，多留了幾筆買進。
            這會讓權益曲線的期初部位變成負數，等於從一個不存在的空單開始起算。
            <br />
            若這幾檔確實有過買賣，先用「匯出 JSON」備份再處理；
            只是重複輸入造成的，直接清除最乾淨。
          </p>
          {/* 沒有實際買賣時，清掉這些紀錄是最乾淨的收尾：
              該檔會改用「以統計起算日建倉」的補記方式，股數與成本直接取自持股清單。 */}
          <button
            type="button"
            onClick={() => {
              if (
                window.confirm(
                  `將清除這 ${mismatchCodes.length} 檔的進出紀錄，持股本身不受影響。\n` +
                    '這些標的的歷史買賣明細會消失，已實現損益也會一併移除。\n' +
                    '若這幾檔確實有過買賣，請先用上方的「匯出 JSON」備份。\n\n確定要清除嗎？'
                )
              ) {
                dispatch(dropTransactionsForCodes(mismatchCodes));
              }
            }}
            className="mt-2 rounded border border-amber-700 px-2 py-1 text-amber-200 transition hover:bg-amber-900/40"
          >
            清除這 {mismatchCodes.length} 檔的進出紀錄
          </button>
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
          sub={monthPartial ? `自 ${curveStart} 起` : (currentMonth ?? '')}
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

      {monthPartial && (
        <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-3 text-xs text-slate-400">
          {statsStartDate ? (
            // 使用者已自行指定起算日，就不必再建議他去設定，只需說明涵蓋範圍。
            <>
              下方的月曆、月走勢與歷年績效自 <span className="tabular">{curveStart}</span> 起算，
              這是你設定的統計起算日之後的第一個交易日。上方的「總損益」採成本法，涵蓋全部持有期間。
            </>
          ) : (
            <>
              損益走勢的統計區間自 <span className="tabular">{curveStart}</span> 起算，
              那是最早一筆交易紀錄或持股建倉日。此日之前的損益不在下方的月曆、月走勢與歷年績效中。
              若持股在更早之前就已買進且之後沒有異動，把頁面最下方的統計起算日設到那天即可回推。
              上方的「總損益」採成本法，不受此限制。
            </>
          )}
        </div>
      )}

      {/* 今日逐檔明細 */}
      <Panel
        title="今日各檔損益"
        note="損益為「庫存股數 × 當日漲跌」，不扣手續費。盤中為即時試算，可與券商對照；股數或成本有出入時，在持股頁直接編輯校正"
      >
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-slate-500">
                <th className="pb-2 text-left font-normal">標的</th>
                <th className="pb-2 text-right font-normal">現價</th>
                <th className="pb-2 text-right font-normal">股數</th>
                <th className="pb-2 text-right font-normal">漲跌</th>
                <th className="pb-2 text-right font-normal">幅度</th>
                <th className="pb-2 text-right font-normal">損益</th>
              </tr>
            </thead>
            <tbody className="tabular">
              {today.items.map((item) => (
                <tr key={item.code} className="border-t border-slate-800/60">
                  {/* 窄螢幕代號與名稱各佔一行，寬螢幕併回同一行。
                      手機上併在一行會把這一欄撐得很寬，右邊的數字欄跟著被擠窄；
                      桌機空間足夠，一行比較好掃視。

                      兩種寬度都不讓名稱折行。表格會自動把欄位縮到剛好放不下最長
                      名稱的寬度，於是「富邦特選高股息30」這種八字加數字的會多折
                      一行，同一欄裡有的兩行有的三行，看起來像壞掉。寧可讓表格
                      橫向捲動——外層本來就有 overflow-x-auto。 */}
                  <td className="py-1.5">
                    <div className="text-slate-300 sm:inline">{item.code}</div>
                    {item.name && (
                      <div className="whitespace-nowrap text-slate-500 sm:ml-1.5 sm:inline">
                        {/* 漲跌停才套背景方塊。方塊掛在內層的 span 上，不是這個 div——
                            窄螢幕時這個 div 是區塊元素，背景會整欄拉滿。
                            沒有漲跌停時維持原樣，連 span 都不加。 */}
                        {item.limit ? (
                          <span
                            className={limitBlockClass(item.limit)}
                            title={limitLabel(item.limit)}
                          >
                            {item.name}
                          </span>
                        ) : (
                          item.name
                        )}
                      </div>
                    )}
                  </td>
                  <td className="py-1.5 text-right text-slate-300">{num(item.price)}</td>
                  <td className="py-1.5 text-right text-slate-400">{int(item.shares)}</td>
                  <td className={`py-1.5 text-right ${changeColor(item.change)}`}>{num(item.change)}</td>
                  <td className={`py-1.5 text-right ${changeColor(item.change)}`}>
                    {pct(item.changePercent, 2, true)}
                  </td>
                  <td className={`py-1.5 text-right ${changeColor(item.pnl)}`}>{money(item.pnl)}</td>
                </tr>
              ))}
              <tr className="border-t border-slate-700">
                <td className="py-1.5 text-slate-400" colSpan={5}>
                  合計
                </td>
                <td className={`tabular py-1.5 text-right font-medium ${changeColor(today.total)}`}>
                  {money(today.total)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* 與月曆對不上時，逐檔指出差額來自哪一檔。
            這兩個數字的口徑本該完全一致，實務上卻反覆出現落差，而每一次都要人工
            去比對 API 回應才找得出原因。所需資料畫面上全都有，不發任何請求，
            因此常駐——只有真的有落差時才會出現。 */}
        {reconcile && reconcile.items.length > 0 && (
          <div className="mt-3 rounded-lg border border-amber-900/60 bg-amber-950/30 p-2.5">
            <p className="text-[12px] leading-relaxed text-amber-400">
              上方合計與每日損益月曆今天那格相差 {money(reconcile.total)}。
              差額來自下列標的的「昨收基準」不一致——
              卡片用即時報價的昨收（除息日為除息參考價），月曆用歷史 K 線前一交易日的收盤
              （原始收盤）。除息日兩者必然相差一個配息，程式會把配息加回；
              配息缺漏或金額不符時落差就會留下來。
            </p>
            <div className="mt-2 overflow-x-auto">
              <table className="tabular w-full min-w-[34rem] text-[11px]">
                <thead>
                  <tr className="text-slate-500">
                    <th className="pb-1 text-left font-normal">標的</th>
                    <th className="pb-1 text-right font-normal">股數</th>
                    <th className="pb-1 text-right font-normal">報價昨收</th>
                    <th className="pb-1 text-right font-normal">曲線昨收</th>
                    <th className="pb-1 text-right font-normal">今日配息</th>
                    <th className="pb-1 text-right font-normal">卡片</th>
                    <th className="pb-1 text-right font-normal">月曆</th>
                    <th className="pb-1 text-right font-normal">差額</th>
                  </tr>
                </thead>
                <tbody>
                  {reconcile.items.map((r) => (
                    <tr key={r.code} className="border-t border-slate-800/60 text-slate-400">
                      <td className="py-1 text-left text-slate-300">{r.code}</td>
                      <td className="py-1 text-right">{int(r.shares)}</td>
                      <td className="py-1 text-right">{num(r.quotePrevClose)}</td>
                      <td className="py-1 text-right">{num(r.curvePrevClose)}</td>
                      <td className="py-1 text-right">{r.dividend ? num(r.dividend, 4) : '—'}</td>
                      <td className="py-1 text-right">{money(r.cardPnl)}</td>
                      <td className="py-1 text-right">{money(r.curvePnl)}</td>
                      <td className="py-1 text-right font-medium text-amber-300">
                        {money(r.diff)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
              非除息日兩個昨收應該相等——K 線的近期收盤已校正為證交所與櫃買的官方行情。
              不相等代表那一檔的官方校正失敗。差額不影響兩天的合計，只讓今天與下一個
              交易日的逐日數字各錯一段。
            </p>
          </div>
        )}
      </Panel>

      {/* 每日損益月曆 */}
      <Panel
        title="每日損益月曆"
        note="每一天都是「當日收盤持股數 × 當日漲跌 ＋ 當日配息」，與上方今日損益同一口徑，不含成本與手續費。除息日已把配息計入，不會出現等於配息的假性虧損"
      >
        <PnlCalendar curve={curve} />
        {noHistoryCodes.length > 0 && (
          <p className="mt-2 rounded-lg border border-amber-900/60 bg-amber-950/30 px-2.5 py-2 text-[12px] leading-relaxed text-amber-400">
            有 {noHistoryCodes.length} 檔尚未取得歷史股價（{noHistoryCodes.join('、')}），
            這些標的在月曆中沒有每日損益，只有今天以現價計算。
            回到持股頁或分析頁重新載入即可補齊；若持續失敗，多半是上游暫時取不到資料。
          </p>
        )}
        {staleHistoryCodes.length > 0 && repairing && (
          <p className="mt-2 rounded-lg border border-slate-700 bg-slate-900/60 px-2.5 py-2 text-[12px] leading-relaxed text-slate-400">
            偵測到 {staleHistoryCodes.length} 檔的歷史股價缺了交易日，正在自動重新載入…
            補齊之前，那幾天的每日損益會被挪到下一個有價格的日子。
          </p>
        )}
        {staleHistoryCodes.length > 0 && !repairing && (
          <div className="mt-2 rounded-lg border border-amber-900/60 bg-amber-950/30 px-2.5 py-2 text-[12px] leading-relaxed text-amber-400">
            <p>
              以下 {staleHistoryCodes.length} 檔的歷史股價缺了交易日，
              已自動重新載入 {MAX_AUTO_REPAIR} 次仍然缺漏，多半是上游真的沒有這幾天的資料。
              那幾天會沿用前一筆收盤價，
              <span className="text-amber-200">當日損益會被挪到下一個有價格的日子</span>，
              兩天的合計正確、逐日數字不正確。
            </p>
            <ul className="tabular mt-1 space-y-0.5">
              {staleHistoryCodes.slice(0, 12).map((h) => (
                <li key={h.code}>
                  {h.code}　缺 {h.missing.slice(0, 4).join('、')}
                  {h.missing.length > 4 && ` 等 ${h.missing.length} 天`}
                </li>
              ))}
              {staleHistoryCodes.length > 12 && (
                <li>…另有 {staleHistoryCodes.length - 12} 檔</li>
              )}
            </ul>
            <button
              type="button"
              onClick={() => {
                // 一併清掉重試次數，這一次是使用者明確要求，自動修復也重新取得配額。
                setRepairAttempts({});
                staleHistoryCodes.forEach((h) =>
                  dispatch(loadHistory({ code: h.code, range: '2y' }))
                );
              }}
              className="mt-1.5 rounded-lg border border-amber-700 px-2 py-1 font-medium text-amber-300 transition hover:bg-amber-900/40"
            >
              再試一次（{staleHistoryCodes.length} 檔）
            </button>
          </div>
        )}
      </Panel>

      {/* 每月損益走勢 */}
      <Panel
        title={`每月損益走勢（近 ${MONTHS_SHOWN} 個月）`}
        note={
          curveStart
            ? `每日損益加總，與月曆同源。統計自 ${curveStart} 起，` +
              `區間內累計 ${money(latest?.cumulativePnl ?? 0)}`
            : '每日損益加總，與月曆同源'
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
                  tick={{ fill: '#64748b', fontSize: 11 }}
                  tickFormatter={(m) => m.slice(2)}
                  minTickGap={24}
                />
                <YAxis
                  tick={{ fill: '#64748b', fontSize: 11 }}
                  width={48}
                  tickFormatter={(v) => `${Math.round(v / 1000)}k`}
                />
                <Tooltip
                  cursor={{ fill: '#1e293b', fillOpacity: 0.5 }}
                  content={<MonthTooltip />}
                />
                {/*
                  關掉進場動畫。各檔歷史股價是逐一載入的，每載入一檔就會重算整條權益曲線，
                  這張圖的資料因此在開頁後連續換新數十次。recharts 每次換資料都會重啟動畫，
                  其 JavascriptAnimate 在 effect 內 setState，連續重啟會撞到 React 的
                  更新深度上限（Maximum update depth exceeded）。
                  這是一張靜態的月損益長條圖，動畫本來就沒有作用。
                */}
                <Bar dataKey="pnl" name="損益" isAnimationActive={false}>
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
        note="年度報酬率的分母為年初淨值加該年淨入金，未做時間加權；年中有大額入金時報酬率會被低估。累積報酬採逐年連乘"
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
                    {/* 「自 ⋯ 起」在窄螢幕換到第二行。與年度併在一行會把這一欄
                        撐寬，右邊兩欄的百分比就被擠到換行。寬螢幕空間夠，維持同一行。 */}
                    <td className="py-1.5 text-slate-300">
                      <div className="sm:inline">{y.year}</div>
                      {y.partial && (
                        <div className="rounded bg-slate-800 px-1 py-0.5 text-[11px] whitespace-nowrap text-slate-500 sm:ml-1.5 sm:inline">
                          自 {y.firstDate?.slice(5)} 起
                        </div>
                      )}
                    </td>
                    {/* 百分比與金額一律不折行：折了之後同一列高高低低，很難橫向比較。 */}
                    <td className={`py-1.5 text-right whitespace-nowrap ${changeColor(y.pnl)}`}>
                      {money(y.pnl)}
                    </td>
                    <td className="py-1.5 text-right whitespace-nowrap text-slate-400">
                      {money(y.endNetWorth)}
                    </td>
                    <td
                      className={`py-1.5 text-right whitespace-nowrap ${changeColor(y.returnPercent)}`}
                    >
                      {pct(y.returnPercent, 2, true)}
                    </td>
                    <td
                      className={`py-1.5 text-right whitespace-nowrap ${changeColor(y.cumulativeReturnPercent)}`}
                    >
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

      {/* 統計區間。
          放在最下方是刻意的：設定一次之後幾乎不會再動，擺在頁首只會把
          每天都要看的損益數字往下推。 */}
      <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <label className="flex items-center gap-2 text-xs text-slate-400">
            <CalendarClock size={14} className="text-sky-400" />
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
        </div>

        <p className="mt-2 text-[12px] leading-relaxed text-slate-500">
          起算日設為那天，每日損益月曆、月走勢與歷年績效即可自該日完整回推。
        </p>
      </section>
    </div>
  );
}

/**
 * 月損益走勢的浮動說明。
 *
 * 改用自訂內容而不是 recharts 的預設 Tooltip，是因為預設版本會把金額那一行
 * 染成該系列的顏色，而顏色是取自 `<Bar>` 自己的 fill。這張圖的紅綠是掛在
 * 每根 `<Cell>` 上的，Bar 本身沒有 fill，於是那一行拿到 rgb(0,0,0)——
 * 黑字印在 slate-900 的底上，等於整行看不見，只剩月份那一行看得到。
 *
 * 自己畫還有一個好處：金額可以依正負套用紅漲綠跌，與月曆和其他數字一致。
 */
function MonthTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-2 text-[12px]">
      <div className="tabular font-medium text-slate-300">{row.month}</div>
      <div className={`tabular mt-0.5 text-sm font-semibold ${changeColor(row.pnl)}`}>
        {money(row.pnl)}
      </div>
      <div className="tabular mt-0.5 text-slate-500">
        月底淨值 {money(row.endNetWorth)}
      </div>
    </div>
  );
}

function Panel({ title, note, children }) {
  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-3">
      <h3 className="text-sm font-medium text-slate-300">{title}</h3>
      {note && <p className="mb-3 mt-0.5 text-[12px] leading-relaxed text-slate-600">{note}</p>}
      <div className={note ? '' : 'mt-3'}>{children}</div>
    </section>
  );
}

function Summary({ label, value, sub, tone }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-2.5">
      <div className="text-[12px] text-slate-500">{label}</div>
      <div
        className={`tabular mt-0.5 text-sm font-semibold ${
          tone === undefined ? 'text-slate-100' : changeColor(tone)
        }`}
      >
        {value}
      </div>
      {sub && <div className="text-[11px] text-slate-600">{sub}</div>}
    </div>
  );
}
