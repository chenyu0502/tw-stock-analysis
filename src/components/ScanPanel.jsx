import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

/**
 * 批次掃描面板的外框。
 *
 * 三個面板（融資融券、型態與攻守、其餘規則）共用同一個外框，
 * 標題列在收合狀態就要把結論講完——「3 檔觸發」比「點開才知道」有用得多。
 * 二十幾檔的清單全部展開會佔滿整個畫面，預設收合、有事才展開。
 *
 * @param {{
 *   icon: import('react').ReactNode,
 *   title: string,
 *   summary: string,
 *   defaultOpen?: boolean,
 *   note?: string,
 *   children: import('react').ReactNode
 * }} props
 */
export default function ScanPanel({ icon, title, summary, defaultOpen = false, note, children }) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 text-left"
      >
        {icon}
        <h3 className="text-sm font-medium text-slate-300">{title}</h3>
        <span className="text-xs text-slate-500">{summary}</span>
        {open ? (
          <ChevronUp size={15} className="ml-auto shrink-0 text-slate-500" />
        ) : (
          <ChevronDown size={15} className="ml-auto shrink-0 text-slate-500" />
        )}
      </button>

      {open && (
        <div className="mt-2">
          {children}
          {note && <p className="mt-2 text-[11px] leading-relaxed text-slate-600">{note}</p>}
        </div>
      )}
    </section>
  );
}
