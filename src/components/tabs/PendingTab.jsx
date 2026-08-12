import { Construction } from 'lucide-react';

/**
 * 尚未實作的分頁佔位。
 *
 * 這三個分頁（績效、資金、AI）的規格取決於使用者自己的操作紀律與需求，
 * 照抄參考站沒有意義，等規格確認後再實作。
 *
 * @param {{ title: string, items: string[] }} props
 */
export default function PendingTab({ title, items }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-800 p-6">
      <div className="flex items-center gap-2 text-slate-400">
        <Construction size={18} />
        <h2 className="text-sm font-medium">{title}</h2>
      </div>
      <p className="mt-3 text-xs text-slate-500">此分頁待規格確認後實作。參考站的對應功能包含：</p>
      <ul className="mt-2 space-y-1 text-xs text-slate-500">
        {items.map((item) => (
          <li key={item} className="flex gap-2">
            <span className="text-slate-700">·</span>
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}
