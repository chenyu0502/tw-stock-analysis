import { useMemo } from 'react';
import {
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  ZAxis,
  ReferenceLine,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Cell,
} from 'recharts';
import { num, pct, int } from '../lib/format.js';
import { THRESHOLDS } from '../lib/risks.js';

/**
 * 融資融券四象限。
 *
 * 橫軸融資增幅、縱軸融券增幅，把整個投資組合一次畫出來。
 * 象限與五條規則是同一件事的兩種表達：
 *
 * ```
 *            融券增加
 *   資減券增  │  資券同增
 *   ─────────┼─────────  融資增加
 *   資券同減  │  資增券減
 *            融券減少
 * ```
 *
 * 用散佈圖而不是逐檔列數字，是因為**位置本身就是資訊**：
 * 離原點越遠代表變動越劇烈，聚在中間的那群就是今天沒事的。
 * 二十幾檔用表格看不出誰是離群值，用散佈圖一眼就知道。
 */
export default function MarginQuadrant({ holdings, marginMap, quotes }) {
  const points = useMemo(
    () =>
      holdings
        .map((h) => {
          const m = marginMap[h.code];
          if (!m || !Number.isFinite(m.marginChangePercent) || !Number.isFinite(m.shortChangePercent)) {
            return null;
          }
          return {
            code: h.code,
            name: quotes[h.code]?.name || m.name || '',
            x: m.marginChangePercent,
            y: m.shortChangePercent,
            marginChange: m.marginChange,
            shortChange: m.shortChange,
            marginBalance: m.marginBalance,
            shortBalance: m.shortBalance,
            // 變動幅度總和決定點的大小，離群值因此更顯眼。
            magnitude: Math.abs(m.marginChangePercent) + Math.abs(m.shortChangePercent),
          };
        })
        .filter(Boolean),
    [holdings, marginMap, quotes]
  );

  const missing = holdings.length - points.length;

  if (points.length === 0) {
    return (
      <p className="py-4 text-center text-sm text-slate-500">
        持股中沒有具融資融券資料的標的。ETF 與非信用交易個股本來就沒有這項資料，屬正常情形。
      </p>
    );
  }

  // 座標範圍取實際資料的極值，並保留邊界，避免點貼在圖框上。
  const span = (key) => {
    const values = points.map((p) => p[key]);
    const max = Math.max(...values.map(Math.abs), 5);
    return [-max * 1.2, max * 1.2];
  };

  return (
    <div>
      <div className="h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 8, right: 12, bottom: 16, left: 4 }}>
            <CartesianGrid stroke="#1e293b" />
            <XAxis
              type="number"
              dataKey="x"
              domain={span('x')}
              tick={{ fill: '#64748b', fontSize: 10 }}
              tickFormatter={(v) => `${v.toFixed(0)}%`}
              label={{ value: '融資增幅', position: 'insideBottom', offset: -8, fill: '#64748b', fontSize: 10 }}
            />
            <YAxis
              type="number"
              dataKey="y"
              domain={span('y')}
              tick={{ fill: '#64748b', fontSize: 10 }}
              tickFormatter={(v) => `${v.toFixed(0)}%`}
              width={44}
              label={{ value: '融券增幅', angle: -90, position: 'insideLeft', fill: '#64748b', fontSize: 10 }}
            />
            <ZAxis type="number" dataKey="magnitude" range={[40, 260]} />
            {/* 原點的十字線就是象限的分界 */}
            <ReferenceLine x={0} stroke="#475569" />
            <ReferenceLine y={0} stroke="#475569" />
            {/* 規則門檻畫成虛線，越過它就是被判定為異常的那些 */}
            <ReferenceLine
              x={THRESHOLDS.marginSurgePercent}
              stroke="#f59e0b"
              strokeDasharray="3 3"
              strokeOpacity={0.6}
            />
            <ReferenceLine
              y={THRESHOLDS.shortSurgePercent}
              stroke="#f59e0b"
              strokeDasharray="3 3"
              strokeOpacity={0.6}
            />
            <Tooltip
              cursor={{ strokeDasharray: '3 3', stroke: '#475569' }}
              contentStyle={{
                backgroundColor: '#0f172a',
                border: '1px solid #334155',
                borderRadius: 8,
                fontSize: 12,
              }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const p = payload[0].payload;
                return (
                  <div className="rounded-lg border border-slate-700 bg-slate-950 p-2 text-xs">
                    <div className="tabular font-medium text-slate-200">
                      {p.code} {p.name}
                    </div>
                    <div className="tabular mt-1 text-slate-400">
                      融資 {pct(p.x, 1, true)}（{int(p.marginChange)} 張，餘額 {int(p.marginBalance)}）
                    </div>
                    <div className="tabular text-slate-400">
                      融券 {pct(p.y, 1, true)}（{int(p.shortChange)} 張，餘額 {int(p.shortBalance)}）
                    </div>
                  </div>
                );
              }}
            />
            <Scatter data={points}>
              {points.map((p) => (
                <Cell key={p.code} fill={quadrantColor(p.x, p.y)} fillOpacity={0.75} />
              ))}
            </Scatter>
          </ScatterChart>
        </ResponsiveContainer>
      </div>

      <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px] text-slate-600 sm:grid-cols-4">
        <span>右上　資券同增</span>
        <span>右下　資增券減</span>
        <span>左上　資減券增</span>
        <span>左下　資券同減</span>
      </div>

      <p className="mt-1.5 text-[10px] leading-relaxed text-slate-600">
        點的大小代表變動幅度，離原點越遠變動越劇烈。琥珀色虛線是「暴增」規則的門檻
        （融資 {THRESHOLDS.marginSurgePercent}%、融券 {THRESHOLDS.shortSurgePercent}%），
        但那兩條規則還要求張數同時達標，越線不等於觸發。
        {/* JSX 不解析 markdown，要強調得用元素，寫星號只會原樣顯示出來。 */}
        象限只描述資金流向，
        <span className="text-slate-500">不代表多空</span>
        ——融資增加有人讀成散戶追高、有人讀成資金流入，沒有共識。
        {missing > 0 && `另有 ${missing} 檔無融資融券資料（ETF 或非信用交易個股），未列入圖中。`}
      </p>
    </div>
  );
}

/**
 * 象限顏色。
 *
 * 刻意不用紅綠：紅漲綠跌在台股是價格方向的慣例，套在資金流向上會被讀成
 * 「紅色＝看多」。融資融券的多空解讀本來就沒有共識，用中性色系。
 */
function quadrantColor(x, y) {
  if (x >= 0 && y >= 0) return '#a78bfa'; // 資券同增
  if (x >= 0 && y < 0) return '#38bdf8'; // 資增券減
  if (x < 0 && y >= 0) return '#fb923c'; // 資減券增
  return '#94a3b8'; // 資券同減
}
