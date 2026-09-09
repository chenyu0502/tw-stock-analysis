import { useEffect, useMemo, useState } from 'react';
import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts';
import { sma } from '../lib/indicators.js';
import { num, pct } from '../lib/format.js';

/** 三條均線的天數與顏色。台股看盤軟體的慣例是 5 白、10 黃、20 紫。 */
const MA_LINES = [
  { period: 5, key: 'ma5', color: '#e2e8f0', label: '5MA' },
  { period: 10, key: 'ma10', color: '#fbbf24', label: '10MA' },
  { period: 20, key: 'ma20', color: '#c084fc', label: '20MA' },
];

/** 可切換的顯示天數。由短到長排列，與看盤軟體的慣例一致。 */
const RANGE_OPTIONS = [5, 10, 30, 60];

/**
 * 未指定時的顯示天數，依螢幕寬度調整。
 *
 * 手機寬度下 60 根 K 棒的實體只剩約兩像素，紅綠幾乎分不出來，
 * 因此預設給 30 根。桌機維持 60 根，看得到完整的波段。
 * 兩個值都取自 RANGE_OPTIONS，按鈕才有辦法標示出目前是哪一段。
 */
const DEFAULT_BARS = { narrow: 30, wide: 60 };
const NARROW_QUERY = '(max-width: 639px)';

/** 訂閱螢幕寬度，回傳預設該顯示幾根 K 棒。 */
function useDefaultBars() {
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(NARROW_QUERY).matches
  );

  useEffect(() => {
    const mq = window.matchMedia(NARROW_QUERY);
    const onChange = (e) => setNarrow(e.matches);
    mq.addEventListener('change', onChange);
    // 掛載時再同步一次：初始值是在第一次 render 時取的，之後可能已經轉向。
    setNarrow(mq.matches);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return narrow ? DEFAULT_BARS.narrow : DEFAULT_BARS.wide;
}

/**
 * 指數日 K 線圖，疊加 5／10／20 日均線。
 *
 * 這裡畫真正的 K 棒，與個股卡片的收盤線圖不同。個股那邊刻意只畫收盤線，
 * 是因為手機寬度下兩百多根 K 棒會糊成一片；大盤只顯示最近數十根，
 * 每根有足夠寬度，K 棒能表達的開盤與最高最低才有意義。
 *
 * **均線一律用完整序列計算，只在顯示時截斷。** 若先截成 N 根再算 20 日均線，
 * 畫面最左邊 19 根會沒有均線值，看起來像資料缺漏——切到 5 日或 10 日時
 * 更是整段都算不出來。截斷放在最後一步，短天期一樣看得到三條均線。
 *
 * recharts 沒有 K 棒圖元。作法是給 Bar 一個 [最低, 最高] 的區間值，
 * 讓它算出這根的像素範圍，再用自訂 shape 在裡面畫影線與實體。
 *
 * 天期由呼叫端保管，因此在加權與櫃買之間切換時不會被重設回預設值——
 * 想比較兩個指數的同一段期間時，那個重設會讓人每次都要重按一次。
 *
 * @param {{ candles: object[], days: number|null, onDaysChange: (days: number) => void }} props
 *        days 為 null 代表跟隨螢幕寬度
 */
export default function IndexKChart({ candles, days = null, onDaysChange }) {
  const defaultBars = useDefaultBars();
  // 使用者一旦自己選過，轉向就不該再蓋掉他的選擇。
  const visibleBars = days ?? defaultBars;

  const data = useMemo(() => {
    const closes = candles.map((c) => c.close);
    const lines = MA_LINES.map((m) => sma(closes, m.period));
    const rows = candles.map((c, i) => {
      const row = {
        date: c.date,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        // Bar 的區間值：recharts 會依此算出這根 K 棒的上下邊界像素。
        range: [c.low, c.high],
      };
      MA_LINES.forEach((m, n) => {
        row[m.key] = lines[n][i];
      });
      return row;
    });
    return rows.slice(-visibleBars);
  }, [candles, visibleBars]);

  const domain = useMemo(() => {
    const values = [];
    for (const row of data) {
      values.push(row.low, row.high);
      for (const m of MA_LINES) if (Number.isFinite(row[m.key])) values.push(row[m.key]);
    }
    if (values.length === 0) return ['auto', 'auto'];
    const min = Math.min(...values);
    const max = Math.max(...values);
    // 上下各留一點空間，K 棒與均線才不會貼到圖框。
    const pad = (max - min) * 0.06 || 1;
    return [min - pad, max + pad];
  }, [data]);

  if (data.length === 0) {
    return <div className="py-8 text-center text-sm text-slate-500">尚無指數歷史資料</div>;
  }

  return (
    <div>
      <div className="h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: 4 }}>
            <CartesianGrid stroke="#1e293b" vertical={false} />
            <XAxis
              dataKey="date"
              tick={{ fill: '#64748b', fontSize: 11 }}
              minTickGap={40}
              tickFormatter={(d) => d.slice(5)}
            />
            <YAxis
              domain={domain}
              tick={{ fill: '#64748b', fontSize: 11 }}
              width={52}
              tickFormatter={(v) => (v >= 10000 ? Math.round(v).toLocaleString('zh-TW') : v.toFixed(0))}
            />
            <Tooltip
              cursor={{ stroke: '#475569', strokeDasharray: '3 3' }}
              content={<KTooltip />}
            />
            {/* 動畫關閉：recharts 的 Bar 動畫曾在這個專案造成 React 更新深度爆掉。 */}
            <Bar dataKey="range" shape={<Candle />} isAnimationActive={false} />
            {MA_LINES.map((m) => (
              <Line
                key={m.key}
                type="monotone"
                dataKey={m.key}
                stroke={m.color}
                strokeWidth={1.2}
                dot={false}
                // 均線在資料不足的前段是 null，連起來會拉出一條假線。
                connectNulls={false}
                isAnimationActive={false}
              />
            ))}
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
        {MA_LINES.map((m) => (
          <span key={m.key} className="flex items-center gap-1">
            <span className="inline-block h-0.5 w-3" style={{ backgroundColor: m.color }} />
            {m.label}
          </span>
        ))}

        {/* 天期切換。靠右擺，與左側的均線圖例分開，不會被誤認成圖例的一部分。 */}
        <span className="ml-auto flex items-center gap-1">
          {RANGE_OPTIONS.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => onDaysChange?.(option)}
              aria-pressed={visibleBars === option}
              title={`顯示近 ${option} 個交易日`}
              className={`tabular rounded border px-1.5 py-0.5 transition ${
                visibleBars === option
                  ? 'border-sky-500 bg-sky-600 text-white'
                  : 'border-slate-700 text-sky-400 hover:border-sky-600 hover:text-sky-300'
              }`}
            >
              {option}
            </button>
          ))}
          <span className="text-slate-600">日</span>
        </span>
      </div>

      {/* 資料不足時要說出來，否則按了 60 卻只畫出 20 根會像是壞掉。 */}
      {data.length < visibleBars && (
        <div className="mt-1 text-[11px] text-slate-600">
          目前只有 {data.length} 個交易日的資料
        </div>
      )}
    </div>
  );
}

/**
 * 單根 K 棒。
 *
 * recharts 傳進來的 x/y/width/height 對應 [最低, 最高] 這個區間的像素位置，
 * 因此可以由 y（最高價的位置）與 height（整段高低差）換算出開收盤的位置。
 *
 * 台股慣例：收盤高於開盤為紅（實心），低於開盤為綠（實心），平盤用線。
 */
function Candle({ x, y, width, height, payload }) {
  if (!payload || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  const { open, high, low, close } = payload;
  if (![open, high, low, close].every(Number.isFinite)) return null;

  const up = close >= open;
  const color = close === open ? '#94a3b8' : up ? '#f43f5e' : '#10b981';

  // 一字線（開高低收全等）時高低差為零，換算比例會是無限大，直接畫一條橫線。
  const span = high - low;
  const scale = span > 0 ? height / span : 0;
  const yOf = (value) => y + (high - value) * scale;

  const centre = x + width / 2;
  const bodyTop = yOf(Math.max(open, close));
  const bodyBottom = yOf(Math.min(open, close));
  // 開收盤極接近時實體會變成零高度而消失，至少保留一像素。
  const bodyHeight = Math.max(bodyBottom - bodyTop, 1);
  // 太窄的實體看不出顏色，太寬會黏在一起，留一點間隙。
  const bodyWidth = Math.max(width * 0.7, 1);

  return (
    <g>
      <line x1={centre} x2={centre} y1={y} y2={y + height} stroke={color} strokeWidth={1} />
      <rect
        x={centre - bodyWidth / 2}
        y={bodyTop}
        width={bodyWidth}
        height={bodyHeight}
        fill={color}
      />
    </g>
  );
}

/** 停留時顯示該日的開高低收與三條均線。 */
function KTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  const change = row.close - row.open;

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-950 p-2 text-[12px]">
      <div className="tabular font-medium text-slate-200">{row.date}</div>
      <div className="tabular mt-1 grid grid-cols-2 gap-x-3 text-slate-400">
        <span>開 {num(row.open)}</span>
        <span>高 {num(row.high)}</span>
        <span>低 {num(row.low)}</span>
        <span className={change >= 0 ? 'text-rose-400' : 'text-emerald-400'}>
          收 {num(row.close)}
        </span>
      </div>
      <div className="tabular mt-1 flex flex-wrap gap-x-2 border-t border-slate-800 pt-1">
        {MA_LINES.map((m) => (
          <span key={m.key} style={{ color: m.color }}>
            {m.label} {Number.isFinite(row[m.key]) ? num(row[m.key]) : '—'}
          </span>
        ))}
      </div>
      <div className="tabular mt-1 text-slate-500">
        當日振幅 {pct(row.low ? ((row.high - row.low) / row.low) * 100 : null, 2)}
      </div>
    </div>
  );
}
