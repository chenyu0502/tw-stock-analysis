import { useMemo } from 'react';
import { useSelector } from 'react-redux';
import { maStances, STANCE_LABEL } from '../lib/stance.js';
import { detectPattern } from '../lib/patterns.js';
import { DEFAULT_MA } from '../store/portfolioSlice.js';

/**
 * 型態與攻守的全部位總覽。
 *
 * 個股卡片上已經有這兩項，這裡要回答的是不同的問題：
 * **整個投資組合現在偏向哪一邊。** 二十幾檔逐一看標籤看不出全貌，
 * 「五檔跌破確認、兩檔突破確認」才是有意義的資訊。
 *
 * 用堆疊長條而不是圓餅圖：要比較的是各狀態的多寡，長度比角度好判讀，
 * 而且狀態有天然的方向順序（偏空到偏多），排成一條才看得出重心偏哪邊。
 */
export default function StanceOverview({ holdings }) {
  const history = useSelector((s) => s.market.history);
  const quotes = useSelector((s) => s.market.quotes);

  const rows = useMemo(
    () =>
      holdings
        .map((h) => {
          const candles = history[h.code]?.candles ?? [];
          if (candles.length < 40) return null;
          const stances = maStances(
            candles,
            h.maShort ?? DEFAULT_MA.short,
            h.maLong ?? DEFAULT_MA.long
          );
          return {
            code: h.code,
            name: quotes[h.code]?.name || '',
            short: stances.short,
            long: stances.long,
            pattern: detectPattern(candles),
          };
        })
        .filter(Boolean),
    [holdings, history, quotes]
  );

  const pending = holdings.length - rows.length;

  if (rows.length === 0) {
    return (
      <p className="py-4 text-center text-sm text-slate-500">
        {pending > 0 ? '歷史股價載入中…' : '沒有足夠的歷史股價可判定狀態'}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <StateBar title="短期均線攻守" rows={rows} pick={(r) => r.short} />
      <StateBar title="長期均線攻守" rows={rows} pick={(r) => r.long} />
      <PatternBar rows={rows} />

      {pending > 0 && (
        <p className="text-[10px] text-slate-600">
          另有 {pending} 檔的歷史股價尚未載入或不足，未計入統計。
        </p>
      )}
    </div>
  );
}

/** 依方向排序：偏空的排左邊、偏多的排右邊，重心一眼看得出來。 */
const STATE_ORDER = [
  'BEARISH_CONFIRMED',
  'WATCH_BREAKDOWN',
  'BELOW',
  'BREAKOUT_FAILED',
  'BREAKDOWN_FAILED',
  'ABOVE',
  'WATCH_BREAKOUT',
  'BULLISH_CONFIRMED',
];

const STATE_FILL = {
  BEARISH_CONFIRMED: '#059669',
  WATCH_BREAKDOWN: '#34d399',
  BELOW: '#065f46',
  BREAKOUT_FAILED: '#34d399',
  BREAKDOWN_FAILED: '#fb7185',
  ABOVE: '#9f1239',
  WATCH_BREAKOUT: '#fb7185',
  BULLISH_CONFIRMED: '#e11d48',
};

/**
 * 一列堆疊長條，附各段的標的清單。
 *
 * 不用圖表函式庫：這只是幾個寬度成比例的色塊，用 flex 就夠了。
 * 動用 recharts 反而要處理容器量測與動畫，是先前造成 React 更新深度爆掉的來源。
 */
function StateBar({ title, rows, pick }) {
  const groups = useMemo(() => {
    const map = new Map();
    for (const r of rows) {
      const state = pick(r)?.state;
      if (!state) continue;
      const list = map.get(state) ?? [];
      list.push(r);
      map.set(state, list);
    }
    return STATE_ORDER.filter((s) => map.has(s)).map((s) => ({ state: s, items: map.get(s) }));
  }, [rows, pick]);

  const total = groups.reduce((acc, g) => acc + g.items.length, 0);
  if (total === 0) return null;

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-xs text-slate-400">{title}</span>
        <span className="text-[10px] text-slate-600">共 {total} 檔</span>
      </div>
      <div className="mt-1 flex h-5 w-full overflow-hidden rounded">
        {groups.map((g) => (
          <div
            key={g.state}
            className="flex items-center justify-center text-[10px] text-white/90"
            style={{ width: `${(g.items.length / total) * 100}%`, backgroundColor: STATE_FILL[g.state] }}
            title={`${STANCE_LABEL[g.state].label}：${g.items.map((i) => i.code).join('、')}`}
          >
            {g.items.length}
          </div>
        ))}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
        {groups.map((g) => (
          <span key={g.state} className="flex items-center gap-1 text-[10px] text-slate-500">
            <span
              className="inline-block h-2 w-2 rounded-sm"
              style={{ backgroundColor: STATE_FILL[g.state] }}
            />
            {STANCE_LABEL[g.state].label} {g.items.length}
            <span className="text-slate-600">（{g.items.map((i) => i.code).join('、')}）</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/** 型態沒有方向性，依數量由多到少排列即可。 */
function PatternBar({ rows }) {
  const groups = useMemo(() => {
    const map = new Map();
    for (const r of rows) {
      const name = r.pattern?.name ?? '型態未明';
      const list = map.get(name) ?? [];
      list.push(r);
      map.set(name, list);
    }
    return [...map.entries()]
      .map(([name, items]) => ({ name, items }))
      .sort((a, b) => b.items.length - a.items.length || a.name.localeCompare(b.name));
  }, [rows]);

  const total = rows.length;
  const max = Math.max(...groups.map((g) => g.items.length), 1);

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-xs text-slate-400">價格型態分布</span>
        <span className="text-[10px] text-slate-600">共 {total} 檔</span>
      </div>
      <div className="mt-1 space-y-1">
        {groups.map((g) => (
          <div key={g.name} className="flex items-center gap-2">
            <span className="w-24 shrink-0 text-[11px] text-slate-400">{g.name}</span>
            <div className="h-3 flex-1 overflow-hidden rounded bg-slate-800/60">
              <div
                className={`h-full ${g.name === '型態未明' ? 'bg-slate-600' : 'bg-sky-600'}`}
                style={{ width: `${(g.items.length / max) * 100}%` }}
              />
            </div>
            <span className="tabular w-6 shrink-0 text-right text-[11px] text-slate-400">
              {g.items.length}
            </span>
          </div>
        ))}
      </div>
      <p className="mt-1 text-[10px] leading-relaxed text-slate-600">
        {groups
          .filter((g) => g.name !== '型態未明')
          .map((g) => `${g.name}：${g.items.map((i) => i.code).join('、')}`)
          .join('　') || '目前所有標的皆未形成明確型態'}
      </p>
    </div>
  );
}
