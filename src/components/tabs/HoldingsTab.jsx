import { useEffect, useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import {
  Plus,
  AlertTriangle,
  Banknote,
  Download,
  Upload,
  FileSpreadsheet,
  Trash2,
} from 'lucide-react';
import {
  recordTrade,
  updateTransaction,
  removeTransaction,
  removeHolding,
  updateHolding,
  recordCashFlow,
  removeCashFlow,
  setCash,
  today,
  restorePortfolio,
  upsertHolding,
} from '../../store/portfolioSlice.js';
import { loadQuotes, loadDailyStats, loadExDividend } from '../../store/marketSlice.js';
import { useHealthScores } from '../../lib/useHealthScores.js';
import { tradeCost } from '../../lib/fees.js';
import {
  exportExcel,
  exportJson,
  importExcel,
  importJson,
  holdingsTemplate,
} from '../../lib/excel.js';
import { positionSummary } from '../../lib/performance.js';
import { money, pct, num, int, changeColor } from '../../lib/format.js';
import StockCard from '../StockCard.jsx';
import ExDividendNotice from '../ExDividendNotice.jsx';
import TransactionList from '../TransactionList.jsx';
import RiskScan from '../RiskScan.jsx';

/** 單一標的市值佔比超過此門檻即提出集中度警示。 */
const CONCENTRATION_THRESHOLD = 30;

/**
 * 資金流水預設顯示的筆數。
 *
 * 流水只增不減，全部攤開會一路把下面的持股推出畫面。平常要看的只有剛記的
 * 那幾筆（確認有沒有記對），其餘收合，要對帳時再展開。
 */
const FLOWS_SHOWN = 3;

/**
 * 持股頁：部位管理與損益總覽。
 */
export default function HoldingsTab() {
  const dispatch = useDispatch();
  // transactions 與 cashFlows 只用於匯出：備份與對帳需要進出紀錄，光有持股不夠。
  const { holdings, cash, transactions, cashFlows, statsStartDate } = useSelector(
    (s) => s.portfolio
  );
  const quotes = useSelector((s) => s.market.quotes);
  const exDividend = useSelector((s) => s.market.exDividend);

  const [form, setForm] = useState({ code: '', shares: '', price: '', fee: '', date: today() });
  const [flowAmount, setFlowAmount] = useState('');
  // 資金進出的日期。原本沒有這個欄位、一律記成今天，於是補記一筆過去的入金
  // （或誤刪後想還原）時，那筆會落在錯的日子上，歷史現金整段偏掉。
  const [flowDate, setFlowDate] = useState(today());
  const [showAllFlows, setShowAllFlows] = useState(false);
  const [message, setMessage] = useState('');

  // 新的在前。只算一次，收合與展開共用。
  const sortedFlows = useMemo(
    () => [...cashFlows].sort((a, b) => String(b.date).localeCompare(String(a.date))),
    [cashFlows]
  );
  const visibleFlows = showAllFlows ? sortedFlows : sortedFlows.slice(0, FLOWS_SHOWN);
  const netFlow = useMemo(() => cashFlows.reduce((acc, f) => acc + f.amount, 0), [cashFlows]);

  const codesKey = holdings.map((h) => h.code).join(',');

  // 體質燈號。財報逐檔排隊載入，燈號會由上往下陸續出現。
  const healthByCode = useHealthScores(useMemo(() => holdings.map((h) => h.code), [holdings]));

  useEffect(() => {
    if (!codesKey) return;
    const list = codesKey.split(',');
    dispatch(loadQuotes(list));
    dispatch(loadDailyStats(list));
    // 除權息預告是全市場一次取回。帶入持股代號是為了讓伺服器順便補上發放日，
    // 全市場清單本身共用同一份快取，不會因為代號不同而重建。
    dispatch(loadExDividend(list));
  }, [codesKey, dispatch]);

  // 與績效頁共用同一個彙總函式，兩頁的總市值、未實現損益與總淨值不會出現分歧。
  const summary = useMemo(() => positionSummary(holdings, quotes, cash), [holdings, quotes, cash]);
  const rows = summary.items;

  const concentrated = useMemo(
    () =>
      summary.totalValue === 0
        ? []
        : rows
            .map((r) => ({ code: r.code, share: ((r.value ?? r.cost) / summary.totalValue) * 100 }))
            .filter((r) => r.share > CONCENTRATION_THRESHOLD)
            .sort((a, b) => b.share - a.share),
    [rows, summary.totalValue]
  );

  // 手續費與證交稅的試算，供「帶入試算」使用。
  //
  // 只是試算：券商折讓每家不同（這裡用常見的六折），最低收費與捨入方式也有差異，
  // 真正的金額要看對帳單。因此不自動填進欄位，由使用者按一下才帶入、帶入後仍可改。
  const estimatedCost = useMemo(() => {
    const shares = Number(form.shares);
    const price = Number(form.price);
    if (!form.code || !Number.isFinite(shares) || !Number.isFinite(price) || price <= 0) return null;
    return tradeCost({ code: form.code, shares, price });
  }, [form]);

  function handleTrade(e) {
    e.preventDefault();
    const code = form.code.trim();
    const shares = Number(form.shares);
    const price = Number(form.price);

    if (!/^\d{4,6}[A-Z]?$/.test(code)) {
      setMessage('代號格式不正確');
      return;
    }
    if (!Number.isFinite(shares) || shares === 0) {
      setMessage('股數需為非零數字，賣出請填負數');
      return;
    }
    if (!Number.isFinite(price) || price <= 0) {
      setMessage('價格需為正數');
      return;
    }
    if (shares < 0 && !holdings.some((h) => h.code === code)) {
      setMessage(`目前沒有 ${code} 的部位，無法賣出`);
      return;
    }

    // 費用欄留空代表「價格已含費用」，此時 fee 為零，行為與這個欄位出現之前完全相同。
    const fee = form.fee === '' ? 0 : Number(form.fee);
    if (!Number.isFinite(fee) || fee < 0) {
      setMessage('手續費與交易稅需為零或正數');
      return;
    }

    dispatch(recordTrade({ code, shares, price, fee, date: form.date }));
    setForm({ code: '', shares: '', price: '', fee: '', date: today() });
    setMessage('');
  }

  /**
   * 匯入持股。
   *
   * 兩種來源的語意不同，刻意分開處理：
   *
   * - **JSON**：這頁匯出的備份，代表「回到那個時間點」，因此整包取代並含
   *   進出紀錄與現金。會覆蓋現有資料，先要求確認。
   * - **試算表**：只是一份部位清單，代表「這幾檔現在是這個股數」，
   *   因此逐列新增或更新，不動其他標的、也不產生交易紀錄。
   */
  async function handleImport(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      if (file.name.endsWith('.json')) {
        const data = await importJson(file);
        const list = Array.isArray(data) ? data : (data.holdings ?? []);
        if (!Array.isArray(list) || list.length === 0) {
          setMessage('檔案中沒有持股資料');
          return;
        }
        const ok = window.confirm(
          `將以檔案內容取代目前的 ${holdings.length} 檔持股（共 ${list.length} 檔）。\n` +
            '進出紀錄、資金流水與帳上現金若檔案中有，也會一併取代。\n' +
            '感興趣標的不受影響。\n\n建議先按「匯出 JSON」備份目前資料。確定要匯入嗎？'
        );
        if (!ok) return;
        dispatch(restorePortfolio(Array.isArray(data) ? { holdings: list } : data));
        setMessage(`已匯入 ${list.length} 檔持股`);
      } else {
        const rows = await importExcel(file);
        let count = 0;
        for (const row of rows) {
          // 欄位名稱容許中英文兩種寫法，降低使用者自製檔案的失敗率。
          const code = String(row['股票代號'] ?? row.code ?? row.Code ?? '').trim();
          if (!/^\d{4,6}[A-Z]?$/.test(code)) continue;
          const shares = Number(row['股數'] ?? row.shares);
          if (!Number.isFinite(shares) || shares <= 0) continue;
          dispatch(
            upsertHolding({
              code,
              shares,
              avgCost: Number(row['平均成本'] ?? row['成本均價'] ?? row.avgCost),
              note: String(row['備註'] ?? row.note ?? ''),
            })
          );
          count += 1;
        }
        setMessage(count === 0 ? '沒有可匯入的資料列，請確認欄位名稱' : `已匯入 ${count} 檔`);
      }
    } catch (err) {
      setMessage(`匯入失敗：${err.message}`);
    } finally {
      // 清空 value 才能重複選同一個檔案。
      e.target.value = '';
    }
  }

  function handleCashFlow() {
    const amount = Number(flowAmount);
    if (!Number.isFinite(amount) || amount === 0) {
      setMessage('入金金額需為非零數字，出金請填負數');
      return;
    }
    dispatch(recordCashFlow({ amount, date: flowDate || today() }));
    setFlowAmount('');
    // 日期跳回今天：補記過去那一筆之後，下一筆最常見的仍是今天，
    // 留著舊日期很容易讓下一筆也被誤記到過去。
    setFlowDate(today());
    setMessage('');
  }

  /**
   * 刪除一筆交易，先確認。
   *
   * 與資金流水同一個理由：刪除不只是把一列拿掉，帳上現金會同步反向調整。
   */
  function handleRemoveTransaction(tx) {
    const cashDelta = tx.shares * tx.price + (Number.isFinite(tx.fee) ? tx.fee : 0);
    const direction = cashDelta > 0 ? '增加' : '減少';
    const ok = window.confirm(
      `刪除 ${tx.date} ${tx.code} ${int(tx.shares)} 股 @ ${num(tx.price)}？\n\n` +
        `帳上現金會同步${direction} ${money(Math.abs(cashDelta))}。\n` +
        '持股的股數與成本均價不會跟著改，需要時請在上方持股列直接編輯。'
    );
    if (ok) dispatch(removeTransaction(tx.id));
  }

  /**
   * 刪除一筆資金流水，先確認。
   *
   * 刪除不只是把一列拿掉——帳上現金會同步反向調整。先前按一下垃圾桶就立刻
   * 生效，實際發生過誤刪 5,249 的入金，現金也跟著少了這個數。
   */
  function handleRemoveFlow(flow) {
    const direction = flow.amount > 0 ? '減少' : '增加';
    const ok = window.confirm(
      `刪除 ${flow.date} 這筆 ${money(flow.amount)}？\n\n` +
        `帳上現金會同步${direction} ${money(Math.abs(flow.amount))}。`
    );
    if (ok) dispatch(removeCashFlow(flow.id));
  }

  return (
    <div className="space-y-4">
      {/* 總覽 */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <SummaryCard label="總市值" value={money(summary.totalValue)} />
        <SummaryCard label="總投入成本" value={money(summary.totalCost)} />
        <SummaryCard
          label="未實現損益"
          value={money(summary.unrealized)}
          sub={pct(summary.unrealizedPercent, 2, true)}
          tone={summary.unrealized}
        />
        <SummaryCard
          label="總淨值"
          value={money(summary.netWorth)}
          sub={`持股水位 ${pct(summary.exposure, 1)}`}
        />
      </div>

      {/* 現金與資金進出 */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-3">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-slate-400">帳上現金</span>
          <input
            type="number"
            value={cash || ''}
            onChange={(e) => dispatch(setCash(e.target.value))}
            placeholder="0"
            className="tabular min-w-32 flex-1 rounded border border-slate-700 bg-slate-800 px-3 py-1.5 text-right"
          />
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            type="date"
            value={flowDate}
            // 未來的入金還沒發生，擋掉可以避免手滑選到明年。
            max={today()}
            onChange={(e) => setFlowDate(e.target.value)}
            title="入金或出金的日期"
            className="tabular rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-300"
          />
          <input
            type="number"
            value={flowAmount}
            onChange={(e) => setFlowAmount(e.target.value)}
            placeholder="入金金額（出金填負數）"
            className="tabular min-w-40 flex-1 rounded border border-slate-700 bg-slate-800 px-3 py-1.5 text-sm placeholder:text-slate-600"
          />
          <button
            type="button"
            onClick={handleCashFlow}
            className="flex items-center gap-1.5 rounded border border-slate-700 px-3 py-1.5 text-xs text-slate-300 transition hover:border-slate-500"
          >
            <Banknote size={14} className="text-cyan-400" /> 記錄資金進出
          </button>
        </div>
        <p className="mt-1.5 text-[12px] leading-relaxed text-slate-600">
          這裡只記<span className="text-slate-500">錢進出證券戶</span>——銀行匯入、出金領回。
          績效頁計算報酬率時會把它排除在獲利之外，否則入金會被算成賺錢。
          <br />
          <span className="text-slate-500">用帳上現金買股票不要記在這裡。</span>
          那是錢從現金換成股票，沒有離開投資組合；「記錄交易」已經會扣掉現金，
          再記一筆等於扣兩次。券商實扣金額與成交價乘積不符時（例如先圈存再退還），
          差額請填在交易的手續費欄。
        </p>

        {sortedFlows.length > 0 && (
          <div className="mt-2 border-t border-slate-800 pt-2">
            {/* 收合時也看得到總數與淨入金，不必展開就知道流水大致的樣子。 */}
            <div className="mb-1 flex items-baseline gap-2 text-[12px] text-slate-500">
              <span>資金流水</span>
              <span className="tabular text-slate-600">
                共 {sortedFlows.length} 筆，淨入金{' '}
                <span className={changeColor(netFlow)}>{money(netFlow)}</span>
              </span>
            </div>
            <ul className="space-y-0.5">
              {visibleFlows.map((flow) => (
                <li key={flow.id} className="flex items-center gap-2 text-[12px]">
                  <span className="tabular w-20 shrink-0 text-slate-400">{flow.date}</span>
                  <span className={`tabular w-24 shrink-0 text-right ${changeColor(flow.amount)}`}>
                    {money(flow.amount)}
                  </span>
                  {flow.note && <span className="min-w-0 truncate text-slate-600">{flow.note}</span>}
                  <button
                    type="button"
                    onClick={() => handleRemoveFlow(flow)}
                    title="刪除這筆（帳上現金會同步調整）"
                    className="ml-auto shrink-0 rounded p-1 text-slate-600 transition hover:bg-rose-500/10 hover:text-rose-500"
                  >
                    <Trash2 size={12} />
                  </button>
                </li>
              ))}
            </ul>
            {sortedFlows.length > FLOWS_SHOWN && (
              <button
                type="button"
                onClick={() => setShowAllFlows((v) => !v)}
                className="mt-1 text-[12px] text-sky-400 transition hover:text-sky-300"
              >
                {showAllFlows
                  ? '收合'
                  : `顯示全部 ${sortedFlows.length} 筆（另有 ${sortedFlows.length - FLOWS_SHOWN} 筆）`}
              </button>
            )}
          </div>
        )}
      </div>

      <ExDividendNotice holdings={holdings} exDividend={exDividend} />

      <RiskScan holdings={holdings} />

      {concentrated.length > 0 && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-800/60 bg-amber-950/30 p-3 text-xs text-amber-300">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          <div>
            <div className="font-medium">集中度風險警示</div>
            <p className="mt-0.5 text-amber-400/80">
              {concentrated.map((c) => `${c.code} 佔 ${num(c.share, 1)}%`).join('、')}
              ，單一標的超過 {CONCENTRATION_THRESHOLD}% 時，個股利空對整體資產的衝擊會被放大。
            </p>
          </div>
        </div>
      )}

      {/* 記錄交易 */}
      <form onSubmit={handleTrade} className="space-y-2">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          <input
            value={form.code}
            onChange={(e) => setForm({ ...form, code: e.target.value })}
            placeholder="代號"
            inputMode="numeric"
            className="tabular rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm placeholder:text-slate-600 focus:border-sky-600 focus:outline-none"
          />
          <input
            value={form.shares}
            onChange={(e) => setForm({ ...form, shares: e.target.value })}
            placeholder="股數（賣出填負數）"
            type="number"
            className="tabular rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm placeholder:text-slate-600 focus:border-sky-600 focus:outline-none"
          />
          <input
            value={form.price}
            onChange={(e) => setForm({ ...form, price: e.target.value })}
            placeholder="成交價"
            type="number"
            // 券商對帳單的成本均價常帶到小數點後四位，輸入時如實保留，顯示才取兩位。
            step="0.0001"
            className="tabular rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm placeholder:text-slate-600 focus:border-sky-600 focus:outline-none"
          />
          <input
            value={form.fee}
            onChange={(e) => setForm({ ...form, fee: e.target.value })}
            placeholder="手續費/交易稅"
            type="number"
            min="0"
            step="1"
            title="該筆交易的手續費與交易稅合計，買進賣出都是扣掉這筆錢"
            className="tabular rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm placeholder:text-slate-600 focus:border-sky-600 focus:outline-none"
          />
          <input
            value={form.date}
            onChange={(e) => setForm({ ...form, date: e.target.value })}
            type="date"
            className="tabular rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm focus:border-sky-600 focus:outline-none"
          />
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-sky-500"
          >
            <Plus size={15} /> 記錄交易
          </button>
          {estimatedCost && (
            <span className="tabular flex flex-wrap items-center gap-2 text-xs text-slate-500">
              <button
                type="button"
                onClick={() => setForm({ ...form, fee: String(estimatedCost.total) })}
                className="rounded border border-slate-700 px-2 py-1 text-slate-300 transition hover:border-sky-600 hover:text-sky-400"
              >
                帶入試算 {money(estimatedCost.total)}
              </button>
              <span>
                手續費 {money(estimatedCost.brokerFee)}
                {estimatedCost.tax > 0 && ` ＋ 證交稅 ${money(estimatedCost.tax)}`}
                （六折試算，實際金額請照對帳單）
              </span>
            </span>
          )}
        </div>
        <p className="text-[12px] leading-relaxed text-slate-600">
          <span className="text-slate-500">成交價填成交的價格，手續費與交易稅填那一筆的實收金額</span>
          ——兩者都是流出：買進時攤進成本均價，賣出時從已實現損益扣掉，帳上現金兩邊都少。
          <br />
          若填的是券商對帳單上<span className="text-slate-500">已含費用的成本均價</span>
          ，費用欄請留空，行為與這個欄位出現之前相同，不會重複加計。
          <br />
          <span className="text-slate-500">成交會自動加減帳上現金</span>
          （買進扣、賣出加），不必再到上面記一筆資金進出。
        </p>

        {/* 交易清單。預設收合——平常看持股不需要看到全部歷史。
            存在的理由是：價格填錯之後帳上現金就一直是錯的，而原本沒有任何地方
            可以修正，只能另記一筆資金流水去湊，而那會讓權益曲線多算一次。 */}
        <TransactionList
          transactions={transactions}
          onUpdate={(id, patch) => dispatch(updateTransaction({ id, patch }))}
          onRemove={handleRemoveTransaction}
        />
      </form>

      {message && <p className="text-xs text-amber-500">{message}</p>}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-slate-300">
          目前持股
          <span className="tabular ml-2 rounded bg-slate-800 px-1.5 py-0.5 text-xs text-slate-400">
            {rows.length}
          </span>
        </h2>

        <div className="flex flex-wrap gap-2 text-xs">
          {rows.length > 0 && (
            <button
              type="button"
              // 匯出的是完整的持股與交易資料，不只畫面上看得到的欄位：
              // 拿來備份、換裝置、或與人核對數字時都需要成本與進出紀錄。
              onClick={() =>
                exportJson(
                  {
                    exportedAt: new Date().toISOString(),
                    holdings,
                    transactions,
                    cashFlows,
                    cash,
                    // 起算日決定權益曲線從哪天開始算，對帳時少了它會對不出來。
                    statsStartDate,
                  },
                  `持股_${today()}.json`
                )
              }
              className="flex items-center gap-1.5 rounded border border-slate-700 px-2.5 py-1.5 text-slate-300 transition hover:border-slate-500"
            >
              <Download size={13} className="text-sky-400" /> 匯出 JSON
            </button>
          )}

          <label className="flex cursor-pointer items-center gap-1.5 rounded border border-slate-700 px-2.5 py-1.5 text-slate-300 transition hover:border-slate-500">
            <Upload size={13} className="text-violet-400" /> 匯入
            <input
              type="file"
              accept=".json,.xlsx,.xls,.csv"
              onChange={handleImport}
              className="hidden"
            />
          </label>

          <button
            type="button"
            onClick={() => exportExcel(holdingsTemplate(), '持股匯入範例.xlsx', '持股清單')}
            className="flex items-center gap-1.5 rounded border border-slate-700 px-2.5 py-1.5 text-slate-300 transition hover:border-slate-500"
          >
            <FileSpreadsheet size={13} className="text-indigo-400" /> 下載範例
          </button>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-800 py-12 text-center text-sm text-slate-500">
          尚無持股部位
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((row) => (
            <StockCard
              key={row.code}
              item={row}
              onRemove={(code) => dispatch(removeHolding(code))}
              onUpdate={(code, patch) => dispatch(updateHolding({ code, patch }))}
              health={healthByCode[row.code] ?? null}
              extra={
                <div className="tabular grid grid-cols-4 gap-2 border-t border-slate-800/70 px-3 py-2 text-xs">
                  <EditableCell
                    label="股數"
                    value={row.shares}
                    format={int}
                    integer
                    onCommit={(shares) => dispatch(updateHolding({ code: row.code, patch: { shares } }))}
                  />
                  <EditableCell
                    label="成本均價"
                    value={row.avgCost}
                    format={formatCost}
                    step="0.0001"
                    onCommit={(avgCost) => dispatch(updateHolding({ code: row.code, patch: { avgCost } }))}
                  />
                  <Cell label="市值" value={money(row.value)} />
                  <Cell
                    label="損益"
                    value={money(row.profit)}
                    sub={pct(row.profitPercent, 2, true)}
                    tone={row.profit}
                  />
                </div>
              }
            />
          ))}

          <p className="px-1 text-[12px] leading-relaxed text-slate-600">
            股數與成本均價可直接點擊修改，用來對齊券商對帳單——零股的手續費有最低收費，
            攤進去之後的成本均價不會是程式算得出來的數字。
            這種修改不會產生交易紀錄，因此與「記錄交易」不同：它只改現況，不改歷史。
            權益曲線一律以持股清單的股數為準，兩邊不一致時績效頁會提示。
          </p>
        </div>
      )}
    </div>
  );
}

function SummaryCard({ label, value, sub, tone }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-3">
      <div className="text-[12px] text-slate-500">{label}</div>
      <div
        className={`tabular mt-1 text-base font-semibold ${
          tone === undefined ? 'text-slate-100' : changeColor(tone)
        }`}
      >
        {value}
      </div>
      {sub && (
        <div className={`tabular text-[12px] ${tone === undefined ? 'text-slate-500' : changeColor(tone)}`}>
          {sub}
        </div>
      )}
    </div>
  );
}

/**
 * 成本均價的顯示格式。
 *
 * 平常兩位小數就夠，但零股買賣攤進手續費之後常常除不盡（例如 36.1834）。
 * 一律顯示兩位會讓使用者剛存好的數字看起來被改掉，因此**有多的位數才顯示多的**，
 * 最多四位——與記錄交易那裡的含費用單位成本試算同一個精度。
 * @param {number|null|undefined} value
 * @returns {string}
 */
function formatCost(value) {
  if (!Number.isFinite(value)) return num(value);
  return Math.abs(value * 100 - Math.round(value * 100)) < 1e-9 ? num(value, 2) : num(value, 4);
}

/**
 * 可就地編輯的欄位。
 *
 * 存在的理由是零股：券商收的手續費有最低收費，攤進去之後的成本均價
 * 不是程式算得出來的漂亮數字，得照對帳單填。股數同理，配息再投資或
 * 盤後零股成交都可能讓數字對不上。
 *
 * 點一下數字才進入編輯，不做成永遠是輸入框——手機上捲動時很容易誤觸。
 * Enter 或離開焦點即存檔，Esc 取消。
 *
 * @param {{
 *   label: string,
 *   value: number,
 *   format: (v:number)=>string,
 *   onCommit: (v:number)=>void,
 *   integer?: boolean,
 *   step?: string
 * }} props
 */
function EditableCell({ label, value, format, onCommit, integer = false, step = '1' }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  function start() {
    setDraft(Number.isFinite(value) ? String(value) : '');
    setEditing(true);
  }

  function commit() {
    setEditing(false);
    const next = Number(draft);
    // 空白、非數字或負數一律視為取消，不要把持股數變成 NaN——
    // 那會讓整條權益曲線變成 NaN，而且畫面上看不出原因。
    if (draft.trim() === '' || !Number.isFinite(next) || next < 0) return;
    // 數值沒變也照樣送出。
    //
    // 送出會更新 updatedAt，而那是跨裝置合併判斷新舊的依據。
    // 兩台裝置的同一檔若都只有 addedAt，比較結果永遠平手、各自保留自己的版本，
    // 這時「點開再按 Enter」就是把正確的那一台標記成較新的最簡單做法。
    onCommit(integer ? Math.round(next) : next);
  }

  if (!editing) {
    return (
      <div>
        <div className="text-[11px] text-slate-500">{label}</div>
        <button
          type="button"
          onClick={start}
          title={`點擊編輯${label}`}
          className="w-full text-left text-slate-200 underline decoration-slate-700 decoration-dotted underline-offset-4 transition hover:decoration-sky-500"
        >
          {format(value)}
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="text-[11px] text-slate-500">{label}</div>
      <input
        type="number"
        min="0"
        step={step}
        value={draft}
        autoFocus
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') setEditing(false);
        }}
        className="tabular w-full rounded border border-sky-600 bg-slate-800 px-1 py-0.5 text-slate-100 focus:outline-none"
      />
    </div>
  );
}

function Cell({ label, value, sub, tone }) {
  return (
    <div>
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className={tone === undefined ? 'text-slate-200' : changeColor(tone)}>{value}</div>
      {sub && (
        <div className={`text-[11px] ${tone === undefined ? 'text-slate-500' : changeColor(tone)}`}>{sub}</div>
      )}
    </div>
  );
}
