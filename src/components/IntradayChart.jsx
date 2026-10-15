import { useMemo } from 'react';
import {
  ComposedChart,
  Area,
  Bar,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts';
import { num, int, pct } from '../lib/format.js';

/**
 * 當日分時走勢圖。
 *
 * 與 PriceChart（日 K）是兩套視覺語彙，不能共用：分時圖的重點是「相對昨收走到哪」，
 * 因此以昨收為水平基準線、Y 軸對稱於昨收、線色依當下相對昨收決定。
 * 日 K 的重點是價格結構與均線關係，兩者放在一起看才完整，所以卡片上做成切換。
 *
 * @param {{ data: object|null, loading?: boolean, error?: string|null }} props
 */
export default function IntradayChart({ data, loading = false, error = null }) {
  const { rows, domain, ticks } = useMemo(() => prepare(data), [data]);

  if (loading && !data) {
    return <div className="py-12 text-center text-sm text-slate-500">載入分時資料中…</div>;
  }
  if (error) {
    return (
      <div className="rounded-lg border border-amber-900/60 bg-amber-950/30 p-3 text-xs leading-relaxed text-amber-400">
        {error}
      </div>
    );
  }
  if (!data || rows.length === 0) {
    return (
      <div className="py-12 text-center text-sm text-slate-500">
        今日尚無分時資料。開盤前與休市日屬正常情形。
      </div>
    );
  }

  const { prevClose, latest, totalVolume, points } = data;
  const up = prevClose !== null && latest.price >= prevClose;
  // 沿用台股紅漲綠跌。
  const color = up ? '#f43f5e' : '#10b981';
  const tradeDay = points.length > 0 ? isoDay(points[0].time) : null;

  return (
    <div>
      <div className="mb-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="tabular text-lg font-semibold" style={{ color }}>
          {num(latest.price)}
        </span>
        <span className="tabular text-xs" style={{ color }}>
          {latest.change === null
            ? '—'
            : `${latest.change > 0 ? '+' : ''}${num(latest.change)}　${pct(latest.changePercent, 2, true)}`}
        </span>
        {prevClose !== null && (
          <span className="tabular text-[11px] text-slate-600">昨收 {num(prevClose)}</span>
        )}
        <span className="tabular text-[11px] text-slate-600">
          量 {int(totalVolume)} 張
        </span>
        {/* 日期一定要標。收盤後到隔天開盤前、週末與連假，這張圖都是最後一個交易日的
            走勢；少了日期會被當成即時行情。 */}
        {tradeDay && <span className="text-[11px] text-slate-600">{tradeDay} 收</span>}
      </div>

      <div className="h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 8, right: 4, bottom: 0, left: 4 }}>
            <defs>
              <linearGradient id="intradayFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.28} />
                <stop offset="100%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="#1e293b" vertical={false} />
            {/* X 軸一定要用盤中區間當定義域，不能貼著資料走。
                起點不固定（實測 2330 從 09:00、00919 從 09:02），而且若讓軸隨資料
                伸縮，11:00 看到的斜率與 13:30 看到的無法互相比較。 */}
            <XAxis
              dataKey="time"
              type="number"
              scale="time"
              domain={domain.x}
              ticks={ticks}
              tick={{ fill: '#64748b', fontSize: 11 }}
              tickFormatter={hhmm}
            />
            <YAxis
              yAxisId="price"
              domain={domain.y}
              tick={{ fill: '#64748b', fontSize: 11 }}
              width={52}
              tickFormatter={(v) => num(v, domain.digits)}
            />
            {/* 成交量另立一軸並壓到底部四分之一，與 PriceChart 同一個做法。 */}
            <YAxis yAxisId="volume" hide domain={[0, (max) => max * 4]} />
            <Tooltip
              contentStyle={{
                backgroundColor: '#0f172a',
                border: '1px solid #334155',
                borderRadius: 8,
                fontSize: 13,
              }}
              labelStyle={{ color: '#94a3b8' }}
              labelFormatter={hhmm}
              formatter={(value, name) =>
                name === '成交量' ? [`${int(value)} 張`, name] : [num(value), name]
              }
            />
            {prevClose !== null && (
              <ReferenceLine
                yAxisId="price"
                y={prevClose}
                stroke="#64748b"
                strokeDasharray="3 3"
              />
            )}
            <Bar yAxisId="volume" dataKey="volume" name="成交量" fill="#1e40af" opacity={0.35} />
            <Area
              yAxisId="price"
              type="linear"
              dataKey="close"
              name="成交價"
              stroke={color}
              strokeWidth={1.6}
              fill="url(#intradayFill)"
              dot={false}
              isAnimationActive={false}
            />
            {/* Area 已經畫了線，這條 Line 只是把線蓋回最上層，不讓量柱壓過去。 */}
            <Line
              yAxisId="price"
              type="linear"
              dataKey="close"
              name="成交價"
              stroke={color}
              strokeWidth={1.6}
              dot={false}
              legendType="none"
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <p className="mt-1 text-[11px] leading-relaxed text-slate-600">
        分時資料來自 Yahoo，
        <span className="text-slate-500">沒有官方逐分鐘資料可以校正</span>。
        日 K 的收盤價會改用證交所與櫃買的官方行情，分時只能照上游給的呈現，可靠性不同級。
        沒有成交的那一分鐘整筆略過，不以零或前一價充數，因此線段會直接跨過那段時間。
      </p>
    </div>
  );
}

/** 時間戳（秒）轉台北時間的 HH:MM。 */
function hhmm(ts) {
  return new Date(ts * 1000).toLocaleTimeString('zh-TW', {
    timeZone: 'Asia/Taipei',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** 時間戳（秒）轉台北時間的 MM-DD。 */
function isoDay(ts) {
  return new Date(ts * 1000).toLocaleDateString('zh-TW', {
    timeZone: 'Asia/Taipei',
    month: '2-digit',
    day: '2-digit',
  });
}

/**
 * 算出繪圖用的資料列、軸定義域與刻度。
 *
 * **Y 軸刻意對稱於昨收。** 若讓它貼著資料的最高最低，一檔只漲了 0.2% 的股票
 * 會畫出一條看起來很陡的線——那是視覺上的謊話。以昨收為中線、上下取相同幅度，
 * 斜率才與實際漲跌幅成比例。
 */
function prepare(data) {
  const empty = { rows: [], domain: { x: [0, 1], y: [0, 1], digits: 2 }, ticks: [] };
  if (!data?.points?.length) return empty;

  const rows = data.points;
  const start = data.session?.start ?? rows[0].time;
  const end = data.session?.end ?? rows[rows.length - 1].time;

  const prices = rows.map((r) => r.close);
  const prevClose = data.prevClose;

  let y;
  if (Number.isFinite(prevClose) && prevClose > 0) {
    const span = Math.max(...prices.map((p) => Math.abs(p - prevClose)));
    // 整天完全沒動時 span 為零，留一個最小幅度免得軸塌成一條線。
    const half = (span || prevClose * 0.002) * 1.15;
    y = [prevClose - half, prevClose + half];
  } else {
    const lo = Math.min(...prices);
    const hi = Math.max(...prices);
    const pad = (hi - lo || hi * 0.002) * 0.1;
    y = [lo - pad, hi + pad];
  }

  // 低價股的 0.05 跳動在整數刻度下會看不出來，依價位決定小數位數。
  const digits = (prevClose ?? prices[0]) < 100 ? 2 : 0;

  // 每小時一個刻度，加上收盤那一刻。讓 recharts 自行決定會得到不規則的時間點。
  const ticks = [];
  for (let t = start; t < end; t += 3600) ticks.push(t);
  ticks.push(end);

  return { rows, domain: { x: [start, end], y, digits }, ticks };
}
