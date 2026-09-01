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
import RiskScan from '../RiskScan.jsx';

/** 單一標的市值佔比超過此門檻即提出集中度警示。 */
const CONCENTRATION_THRESHOLD = 30;

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

  const [form, setForm] = useState({ code: '', shares: '', price: '', date: today() });
  const [flowAmount, setFlowAmount] = useState('');
  const [message, setMessage] = useState('');

  const codesKey = holdings.map((h) => h.code).join(',');

  useEffect(() => {
    if (!codesKey) return;
    const list = codesKey.split(',');
    dispatch(loadQuotes(list));
    dispatch(loadDailyStats(list));
    // 除權息預告是全市場一次取回，與持股清單無關，因此不隨 codesKey 重複請求太多次。
    dispatch(loadExDividend());
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

  // 手續費與證交稅的參考試算。
  //
  // 這個數字不會被計入成本：成本均價由使用者直接填入且已含費用，
  // 程式再加一次就會重複計算。這裡只是讓使用者在手邊沒有對帳單時，
  // 能自行推算含費用的單位成本。
  const estimatedCost = useMemo(() => {
    const shares = Number(form.shares);
    const price = Number(form.price);
    if (!form.code || !Number.isFinite(shares) || !Number.isFinite(price) || price <= 0) return null;
    const cost = tradeCost({ code: form.code, shares, price });
    return { ...cost, unitCost: price + cost.total / Math.abs(shares) };
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

    dispatch(recordTrade({ code, shares, price, date: form.date }));
    setForm({ code: '', shares: '', price: '', date: today() });
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
    dispatch(recordCashFlow({ amount }));
    setFlowAmount('');
    setMessage('');
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
        <p className="mt-1.5 text-[11px] leading-relaxed text-slate-600">
          這裡只記<span className="text-slate-500">錢進出證券戶</span>——銀行匯入、出金領回。
          績效頁計算報酬率時會把它排除在獲利之外，否則入金會被算成賺錢。
          <br />
          <span className="text-slate-500">用帳上現金買股票不要記在這裡。</span>
          那是錢從現金換成股票，沒有離開投資組合；「記錄交易」已經會扣掉現金，
          再記一筆等於扣兩次。券商實扣金額與成交價乘積不符時（例如先圈存再退還），
          差額請填在交易的手續費欄。
        </p>

        {cashFlows.length > 0 && (
          <div className="mt-2 border-t border-slate-800 pt-2">
            <div className="mb-1 text-[11px] text-slate-500">資金流水</div>
            <ul className="space-y-0.5">
              {[...cashFlows]
                .sort((a, b) => String(b.date).localeCompare(String(a.date)))
                .map((flow) => (
                  <li key={flow.id} className="flex items-center gap-2 text-[11px]">
                    <span className="tabular w-20 shrink-0 text-slate-400">{flow.date}</span>
                    <span className={`tabular w-24 shrink-0 text-right ${changeColor(flow.amount)}`}>
                      {money(flow.amount)}
                    </span>
                    {flow.note && <span className="min-w-0 truncate text-slate-600">{flow.note}</span>}
                    <button
                      type="button"
                      onClick={() => dispatch(removeCashFlow(flow.id))}
                      title="刪除這筆"
                      className="ml-auto shrink-0 rounded p-1 text-slate-600 transition hover:bg-rose-500/10 hover:text-rose-500"
                    >
                      <Trash2 size={12} />
                    </button>
                  </li>
                ))}
            </ul>
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
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
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
            placeholder="成本均價（含費用）"
            type="number"
            // 券商對帳單的成本均價常帶到小數點後四位，輸入時如實保留，顯示才取兩位。
            step="0.0001"
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
            <span className="tabular text-xs text-slate-500">
              參考：手續費約 {money(estimatedCost.brokerFee)}
              {estimatedCost.tax > 0 && ` ＋ 證交稅約 ${money(estimatedCost.tax)}`}
              ，若上方填的是純成交價，含費用單位成本約 {num(estimatedCost.unitCost, 4)}
            </span>
          )}
        </div>
        <p className="text-[11px] leading-relaxed text-slate-600">
          成本均價請填券商對帳單上已含手續費的數字，程式不會再自行加計。參考試算僅供換算，不影響記錄。
          <br />
          <span className="text-slate-500">成交會自動加減帳上現金</span>
          （買進扣、賣出加），不必再到上面記一筆資金進出。
        </p>
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

          <p className="px-1 text-[11px] leading-relaxed text-slate-600">
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
      <div className="text-[11px] text-slate-500">{label}</div>
      <div
        className={`tabular mt-1 text-base font-semibold ${
          tone === undefined ? 'text-slate-100' : changeColor(tone)
        }`}
      >
        {value}
      </div>
      {sub && (
        <div className={`tabular text-[11px] ${tone === undefined ? 'text-slate-500' : changeColor(tone)}`}>
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
        <div className="text-[10px] text-slate-500">{label}</div>
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
      <div className="text-[10px] text-slate-500">{label}</div>
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
      <div className="text-[10px] text-slate-500">{label}</div>
      <div className={tone === undefined ? 'text-slate-200' : changeColor(tone)}>{value}</div>
      {sub && (
        <div className={`text-[10px] ${tone === undefined ? 'text-slate-500' : changeColor(tone)}`}>{sub}</div>
      )}
    </div>
  );
}
