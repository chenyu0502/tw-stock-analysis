import { useEffect, useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { Plus, AlertTriangle, Banknote } from 'lucide-react';
import {
  recordTrade,
  removeHolding,
  updateHolding,
  recordCashFlow,
  setCash,
  today,
} from '../../store/portfolioSlice.js';
import { loadQuotes, loadDailyStats, loadExDividend } from '../../store/marketSlice.js';
import { tradeCost } from '../../lib/fees.js';
import { positionSummary } from '../../lib/performance.js';
import { money, pct, num, int, changeColor } from '../../lib/format.js';
import StockCard from '../StockCard.jsx';
import ExDividendNotice from '../ExDividendNotice.jsx';

/** 單一標的市值佔比超過此門檻即提出集中度警示。 */
const CONCENTRATION_THRESHOLD = 30;

/**
 * 持股頁：部位管理與損益總覽。
 */
export default function HoldingsTab() {
  const dispatch = useDispatch();
  const { holdings, cash } = useSelector((s) => s.portfolio);
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
            <Banknote size={14} /> 記錄資金進出
          </button>
        </div>
        <p className="mt-1.5 text-[11px] text-slate-600">
          資金進出會記入流水並調整現金，績效頁計算報酬率時會把入金排除在獲利之外。
        </p>
      </div>

      <ExDividendNotice holdings={holdings} exDividend={exDividend} />

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
        <p className="text-[11px] text-slate-600">
          成本均價請填券商對帳單上已含手續費的數字，程式不會再自行加計。參考試算僅供換算，不影響記錄。
        </p>
      </form>

      {message && <p className="text-xs text-amber-500">{message}</p>}

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
                  <Cell label="股數" value={int(row.shares)} />
                  <Cell label="成本均價" value={num(row.avgCost)} />
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
