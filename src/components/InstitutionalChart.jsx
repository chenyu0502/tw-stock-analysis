import { useMemo } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceLine,
  Legend,
} from 'recharts';
import { INVESTORS, summarize, streakText } from '../lib/chips.js';
import { int, num, changeColor } from '../lib/format.js';

/**
 * 各法人別的顏色。
 *
 * 刻意避開紅綠兩色。在台股語境紅綠代表漲跌，用在法人別上會被誤讀成
 * 「紅色那個是買超」，但柱狀圖的正負才是買賣方向，顏色只用來區分法人。
 */
const COLORS = {
  foreign: '#f59e0b',
  trust: '#38bdf8',
  dealer: '#a78bfa',
};

/**
 * 三大法人買賣超走勢。
 *
 * 三個法人別堆疊在同一根柱子上，正負分別往上下堆疊，
 * 整根柱子的高度即為三大法人合計，同時看得出是誰在買、誰在賣。
 *
 * @param {{ series: object[] }} props
 */
export default function InstitutionalChart({ series }) {
  const stats = useMemo(() => summarize(series), [series]);

  const chartData = useMemo(
    () =>
      (series ?? []).map((row) => ({
        // 圖表上只顯示月日，年份在這個時間尺度沒有意義。
        date: row.date.slice(5),
        外資: row.foreign,
        投信: row.trust,
        自營商: row.dealer,
      })),
    [series]
  );

  if (!series?.length) {
    return <div className="py-6 text-center text-sm text-slate-500">無法人歷史資料</div>;
  }

  const streaks = INVESTORS.map(({ key, label }) => ({
    key,
    label,
    text: streakText(stats.streaks[key], label),
    direction: stats.streaks[key].direction,
  })).filter((s) => s.text);

  return (
    <div className="space-y-3">
      {/* 連續買賣超 */}
      {streaks.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {streaks.map((s) => (
            <span
              key={s.key}
              className={`rounded border px-1.5 py-0.5 text-[11px] ${
                s.direction === 'buy'
                  ? 'border-rose-500/30 bg-rose-500/10 text-rose-400'
                  : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
              }`}
            >
              {s.text}
            </span>
          ))}
        </div>
      )}

      {/* 區間累計 */}
      <div className="grid grid-cols-3 gap-2">
        {INVESTORS.map(({ key, label }) => (
          <div key={key} className="rounded-lg border border-slate-800 bg-slate-900/50 p-2">
            <div className="flex items-center gap-1.5">
              <span className="size-2 rounded-sm" style={{ backgroundColor: COLORS[key] }} />
              {/* 以實際交易日數標示，不用查詢時指定的日曆天數。
                  查 30 個日曆天只會拿到約 22 個交易日，寫 30 日會誤導。 */}
              <span className="text-[11px] text-slate-500">
                {label} {stats.days} 日累計
              </span>
            </div>
            <div className={`tabular mt-0.5 text-sm ${changeColor(stats.totals[key])}`}>
              {int(stats.totals[key])} 張
            </div>
            <div className="text-[10px] text-slate-600">買超 {stats.buyDays[key]} 日</div>
          </div>
        ))}
      </div>

      {/* 每日買賣超堆疊圖 */}
      <div className="h-44 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: 4 }} stackOffset="sign">
            <CartesianGrid stroke="#1e293b" vertical={false} />
            <XAxis dataKey="date" tick={{ fill: '#64748b', fontSize: 10 }} minTickGap={28} />
            <YAxis
              tick={{ fill: '#64748b', fontSize: 10 }}
              width={44}
              tickFormatter={(v) => (Math.abs(v) >= 1000 ? `${Math.round(v / 1000)}k` : v)}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: '#0f172a',
                border: '1px solid #334155',
                borderRadius: 8,
                fontSize: 12,
              }}
              labelStyle={{ color: '#94a3b8' }}
              formatter={(value, name) => [`${num(value, 0)} 張`, name]}
            />
            <Legend wrapperStyle={{ fontSize: 11, color: '#94a3b8' }} iconSize={8} />
            <ReferenceLine y={0} stroke="#475569" />
            {/* stackOffset="sign" 讓正值往上堆、負值往下堆，兩者不會互相抵銷成單一淨值 */}
            <Bar dataKey="外資" stackId="a" fill={COLORS.foreign} />
            <Bar dataKey="投信" stackId="a" fill={COLORS.trust} />
            <Bar dataKey="自營商" stackId="a" fill={COLORS.dealer} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <p className="text-[11px] text-slate-600">資料來源 FinMind，單位為張，正值為買超。</p>
    </div>
  );
}
