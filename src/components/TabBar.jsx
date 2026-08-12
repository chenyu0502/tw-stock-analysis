import { LineChart, Wallet, TrendingUp, Coins, Sparkles } from 'lucide-react';

/** 底部導覽的分頁定義。 */
export const TABS = [
  { id: 'analysis', label: '分析', Icon: LineChart },
  { id: 'holdings', label: '持股', Icon: Wallet },
  { id: 'performance', label: '績效', Icon: TrendingUp },
  { id: 'capital', label: '資金', Icon: Coins },
  { id: 'ai', label: 'AI', Icon: Sparkles },
];

/**
 * 底部固定導覽列。
 * @param {{ active: string, onChange: (id: string) => void }} props
 */
export default function TabBar({ active, onChange }) {
  return (
    <nav className="fixed inset-x-0 bottom-0 z-20 border-t border-slate-800 bg-slate-950/95 backdrop-blur">
      <div className="mx-auto flex max-w-5xl">
        {TABS.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => onChange(id)}
            className={`flex flex-1 flex-col items-center gap-1 py-2.5 text-xs transition ${
              active === id ? 'text-sky-400' : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            <Icon size={18} />
            {label}
          </button>
        ))}
      </div>
    </nav>
  );
}
