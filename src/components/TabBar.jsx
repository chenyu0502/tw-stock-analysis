import { LineChart, Wallet, TrendingUp, Sparkles } from 'lucide-react';

/**
 * 底部導覽的分頁定義。
 *
 * 每頁配一個專屬色，選中時圖示與上緣指示條一起變色。四頁一眼分得出來，
 * 不必讀字。色相刻意都落在藍紫青這一帶：**紅綠在台股是漲跌的意思**，
 * 拿來當裝飾色會被誤讀成方向。
 *
 * Tailwind 是掃描原始碼字串來產生樣式的，class 必須寫成完整字面值，
 * 不能用 `text-${color}-400` 這種拼接寫法，否則產不出對應的 CSS。
 */
export const TABS = [
  { id: 'analysis', label: '分析', Icon: LineChart, on: 'text-sky-400', bar: 'bg-sky-400' },
  { id: 'holdings', label: '持股', Icon: Wallet, on: 'text-violet-400', bar: 'bg-violet-400' },
  { id: 'performance', label: '績效', Icon: TrendingUp, on: 'text-cyan-400', bar: 'bg-cyan-400' },
  { id: 'ai', label: 'AI', Icon: Sparkles, on: 'text-fuchsia-400', bar: 'bg-fuchsia-400' },
];

/**
 * 底部固定導覽列。
 * @param {{ active: string, onChange: (id: string) => void }} props
 */
export default function TabBar({ active, onChange }) {
  return (
    <nav className="fixed inset-x-0 bottom-0 z-20 border-t border-slate-800 bg-slate-950/95 backdrop-blur">
      <div className="mx-auto flex max-w-5xl">
        {TABS.map(({ id, label, Icon, on, bar }) => {
          const isActive = active === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onChange(id)}
              className={`relative flex flex-1 flex-col items-center gap-1 py-2.5 text-xs transition ${
                isActive ? on : 'text-slate-500 hover:text-slate-300'
              }`}
            >
              {/* 指示條貼在頂緣，位置固定，不會讓按鈕內容跳動 */}
              <span
                className={`absolute inset-x-4 top-0 h-0.5 rounded-full transition ${
                  isActive ? bar : 'bg-transparent'
                }`}
              />
              <Icon size={18} />
              {label}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
