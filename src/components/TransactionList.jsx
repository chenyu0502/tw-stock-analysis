import { useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, Pencil, Trash2, Check, X } from 'lucide-react';
import { money, num, int } from '../lib/format.js';

/** 收合時不顯示任何列；展開後預設顯示的筆數。 */
const SHOWN = 12;

/**
 * 交易清單：檢視、修正、刪除既有的進出紀錄。
 *
 * 做這個的理由很具體：記錄交易時帳上現金會同步扣減，**價格填錯之後現金就一直是錯的，
 * 而原本沒有任何地方可以修正**——只能靠另記一筆資金流水去湊，而那又會讓權益曲線
 * 多算一次。這一頁補上那個缺口。
 *
 * 預設收合。平常看持股不需要看到全部歷史，展開才列出。
 *
 * **不提供代號的編輯。** 改代號等於把一筆交易搬到另一檔，牽動兩邊的持股與成本，
 * 那是刪掉重記，不是修正。
 *
 * @param {{
 *   transactions: object[],
 *   onUpdate: (id: string, patch: object) => void,
 *   onRemove: (tx: object) => void,
 * }} props
 */
export default function TransactionList({ transactions, onUpdate, onRemove }) {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState(null);

  // 新的在前。日期相同時以建立順序的反序排，同一天多筆才看得出先後。
  const sorted = useMemo(
    () =>
      [...transactions].sort(
        (a, b) =>
          String(b.date).localeCompare(String(a.date)) || (b.addedAt ?? 0) - (a.addedAt ?? 0)
      ),
    [transactions]
  );

  if (sorted.length === 0) return null;
  const visible = showAll ? sorted : sorted.slice(0, SHOWN);

  function startEdit(tx) {
    setEditingId(tx.id);
    setDraft({
      date: tx.date ?? '',
      shares: String(tx.shares ?? ''),
      price: String(tx.price ?? ''),
      fee: String(Number.isFinite(tx.fee) ? tx.fee : 0),
    });
  }

  function cancelEdit() {
    setEditingId(null);
    setDraft(null);
  }

  function commit(tx) {
    const shares = Number(draft.shares);
    const price = Number(draft.price);
    const fee = Number(draft.fee);
    // 擋掉會讓現金算出 NaN 的輸入。股數為零的交易沒有意義，價格必須為正。
    if (!Number.isFinite(shares) || shares === 0) return;
    if (!Number.isFinite(price) || price <= 0) return;
    onUpdate(tx.id, {
      date: draft.date || tx.date,
      shares,
      price,
      fee: Number.isFinite(fee) ? fee : 0,
    });
    cancelEdit();
  }

  return (
    <div className="mt-2 border-t border-slate-800 pt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 text-[12px] text-slate-500 transition hover:text-slate-300"
      >
        {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        <span>交易清單</span>
        <span className="tabular text-slate-600">共 {sorted.length} 筆</span>
        <span className="ml-auto text-slate-600">{open ? '收合' : '展開以修正或刪除'}</span>
      </button>

      {open && (
        <>
          <div className="mt-2 overflow-x-auto">
            <table className="tabular w-full min-w-[40rem] text-[12px]">
              <thead>
                <tr className="text-slate-500">
                  <th className="pb-1 text-left font-normal">日期</th>
                  <th className="pb-1 text-left font-normal">代號</th>
                  <th className="pb-1 text-right font-normal">股數</th>
                  <th className="pb-1 text-right font-normal">價格</th>
                  <th className="pb-1 text-right font-normal">手續費</th>
                  <th className="pb-1 text-right font-normal">現金變動</th>
                  <th className="pb-1 text-right font-normal">已實現</th>
                  <th className="pb-1" />
                </tr>
              </thead>
              <tbody>
                {visible.map((tx) =>
                  editingId === tx.id ? (
                    <tr key={tx.id} className="border-t border-slate-800/60">
                      <td className="py-1 pr-1">
                        <Field
                          type="date"
                          value={draft.date}
                          onChange={(v) => setDraft({ ...draft, date: v })}
                          className="w-28"
                        />
                      </td>
                      <td className="py-1 text-slate-400">{tx.code}</td>
                      <td className="py-1 pr-1">
                        <Field
                          value={draft.shares}
                          onChange={(v) => setDraft({ ...draft, shares: v })}
                          className="w-20 text-right"
                        />
                      </td>
                      <td className="py-1 pr-1">
                        <Field
                          value={draft.price}
                          onChange={(v) => setDraft({ ...draft, price: v })}
                          className="w-20 text-right"
                        />
                      </td>
                      <td className="py-1 pr-1">
                        <Field
                          value={draft.fee}
                          onChange={(v) => setDraft({ ...draft, fee: v })}
                          className="w-16 text-right"
                        />
                      </td>
                      <td className="py-1 text-right text-slate-600" colSpan={2}>
                        儲存後重算
                      </td>
                      <td className="py-1">
                        <div className="flex justify-end gap-1">
                          <IconButton
                            onClick={() => commit(tx)}
                            title="儲存（帳上現金會同步調整）"
                            tone="sky"
                          >
                            <Check size={13} />
                          </IconButton>
                          <IconButton onClick={cancelEdit} title="取消">
                            <X size={13} />
                          </IconButton>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    <tr key={tx.id} className="border-t border-slate-800/60 text-slate-400">
                      <td className="py-1 text-left">{tx.date}</td>
                      <td className="py-1 text-left text-slate-300">{tx.code}</td>
                      {/* 買進為正、賣出為負，沿用輸入時的慣例，不另外標買賣字樣。 */}
                      <td className="py-1 text-right">{int(tx.shares)}</td>
                      <td className="py-1 text-right">{num(tx.price)}</td>
                      <td className="py-1 text-right text-slate-600">
                        {Number.isFinite(tx.fee) && tx.fee !== 0 ? num(tx.fee, 0) : '—'}
                      </td>
                      {/* 記錄時帳上現金實際變動的方向與金額，與 recordTrade 同一個式子。 */}
                      <td className="py-1 text-right">
                        {money(-(tx.shares * tx.price + (tx.fee ?? 0)))}
                      </td>
                      <td className="py-1 text-right">
                        {Number.isFinite(tx.realized) ? money(tx.realized) : '—'}
                      </td>
                      <td className="py-1">
                        <div className="flex justify-end gap-1">
                          <IconButton onClick={() => startEdit(tx)} title="修正這筆">
                            <Pencil size={12} />
                          </IconButton>
                          <IconButton
                            onClick={() => onRemove(tx)}
                            title="刪除這筆（帳上現金會同步還原）"
                            tone="rose"
                          >
                            <Trash2 size={12} />
                          </IconButton>
                        </div>
                      </td>
                    </tr>
                  )
                )}
              </tbody>
            </table>
          </div>

          {sorted.length > SHOWN && (
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className="mt-1 text-[12px] text-sky-400 transition hover:text-sky-300"
            >
              {showAll ? '只顯示最近 12 筆' : `顯示全部 ${sorted.length} 筆`}
            </button>
          )}

          <p className="mt-2 text-[11px] leading-relaxed text-slate-600">
            修正或刪除都會<span className="text-slate-400">同步調整帳上現金</span>
            ，差額按新舊金額的落差補上，不必再另記一筆資金流水去湊。
            <br />
            <span className="text-slate-400">股數與成本均價不會跟著改。</span>
            成本均價是逐筆累進的加權平均，後續買進已經把它折進去，無法從單一筆交易反推；
            硬算只會得到一個對不上任何對帳單的數字。那兩個欄位請直接在上方的持股列編輯。
            <br />
            代號不提供編輯——改代號等於把交易搬到另一檔，那是刪掉重記，不是修正。
          </p>
        </>
      )}
    </div>
  );
}

function Field({ value, onChange, className = '', type = 'text' }) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`tabular rounded border border-slate-700 bg-slate-950 px-1.5 py-0.5 text-[12px] text-slate-100 focus:border-sky-600 focus:outline-none ${className}`}
    />
  );
}

function IconButton({ onClick, title, tone = 'slate', children }) {
  const hover = {
    slate: 'hover:bg-slate-700/40 hover:text-slate-200',
    sky: 'hover:bg-sky-500/10 hover:text-sky-400',
    rose: 'hover:bg-rose-500/10 hover:text-rose-500',
  }[tone];
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`shrink-0 rounded p-1 text-slate-600 transition ${hover}`}
    >
      {children}
    </button>
  );
}
