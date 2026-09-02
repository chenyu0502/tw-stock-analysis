import { useMemo } from 'react';
import {
  ComposedChart,
  Line,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts';
import { sma } from '../lib/indicators.js';
import { num, int } from '../lib/format.js';

/**
 * 收盤價與雙均線走勢圖，下方疊加成交量。
 *
 * 不畫真正的 K 棒，因為在手機寬度下 K 棒會擠成無法辨識的色塊，
 * 收盤線加均線在小螢幕上判讀趨勢的效果更好。
 *
 * @param {{ candles: object[], shortPeriod: number, longPeriod: number }} props
 */
export default function PriceChart({ candles, shortPeriod, longPeriod }) {
  const data = useMemo(() => {
    const closes = candles.map((c) => c.close);
    const shortLine = sma(closes, shortPeriod);
    const longLine = sma(closes, longPeriod);
    return candles.map((c, i) => ({
      date: c.date,
      close: c.close,
      volume: c.volume,
      shortMa: shortLine[i],
      longMa: longLine[i],
    }));
  }, [candles, shortPeriod, longPeriod]);

  if (data.length === 0) {
    return <div className="py-8 text-center text-sm text-slate-500">無歷史資料</div>;
  }

  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: 4 }}>
          <CartesianGrid stroke="#1e293b" vertical={false} />
          <XAxis
            dataKey="date"
            tick={{ fill: '#64748b', fontSize: 11 }}
            // 資料點多達兩百餘筆，讓 recharts 自行決定刻度密度會過於擁擠。
            minTickGap={48}
            tickFormatter={(d) => d.slice(5)}
          />
          <YAxis
            yAxisId="price"
            domain={['dataMin - 2', 'dataMax + 2']}
            tick={{ fill: '#64748b', fontSize: 11 }}
            width={44}
            tickFormatter={(v) => v.toFixed(0)}
          />
          {/* 成交量獨立軸並限制高度佔比，避免量能柱蓋掉價格走勢。 */}
          <YAxis yAxisId="volume" hide domain={[0, (max) => max * 4]} />
          <Tooltip
            contentStyle={{
              backgroundColor: '#0f172a',
              border: '1px solid #334155',
              borderRadius: 8,
              fontSize: 14,
            }}
            labelStyle={{ color: '#94a3b8' }}
            formatter={(value, name) => {
              if (name === '成交量') return [int(value), name];
              return [num(value), name];
            }}
          />
          <Bar yAxisId="volume" dataKey="volume" name="成交量" fill="#1e40af" opacity={0.35} />
          <Line
            yAxisId="price"
            type="monotone"
            dataKey="close"
            name="收盤"
            stroke="#e2e8f0"
            strokeWidth={1.6}
            dot={false}
          />
          <Line
            yAxisId="price"
            type="monotone"
            dataKey="shortMa"
            name={`${shortPeriod}MA`}
            stroke="#f43f5e"
            strokeWidth={1.4}
            dot={false}
            connectNulls
          />
          <Line
            yAxisId="price"
            type="monotone"
            dataKey="longMa"
            name={`${longPeriod}MA`}
            stroke="#38bdf8"
            strokeWidth={1.4}
            dot={false}
            connectNulls
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
