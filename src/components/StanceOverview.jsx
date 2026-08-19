import { useMemo } from 'react';
import { useSelector } from 'react-redux';
import { maStances, STANCE_LABEL } from '../lib/stance.js';
import { detectPattern } from '../lib/patterns.js';
import { DEFAULT_MA } from '../store/portfolioSlice.js';
import { num, pct } from '../lib/format.js';

/**
 * 型態與攻守的全部位總覽。
 *
 * 個股卡片上已經有這兩項，這裡要回答的是不同的問題：
 * **整個投資組合現在偏向哪一邊。** 二十幾檔逐一點開看不出全貌。
 *
 * 一列一檔的表格：收盤、兩條均線的實際值、各自的二日法則狀態、價格型態。
 * 把均線數值列出來是重點——「均線之上」這四個字沒說相距多遠，
 * 貼著均線走與拉開一成完全是兩回事，而那個距離只有表格放得下。
 *
 * 表格上方保留一行分布統計，因為「幾檔跌破確認」本身就是結論，
 * 不該逼人自己數。
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
            close: stances.short?.close ?? stances.long?.close ?? null,
            short: stances.short,
            long: stances.long,
            pattern: detectPattern(candles),
          };
        })
        .filter(Boolean)
        // 剛發生的狀態排前面：均線上下是常態，跌破確認才是今天的事。
        .sort(
          (a, b) =>
            eventScore(b) - eventScore(a) ||
            a.code.localeCompare(b.code)
        ),
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
    <div>
      <Tally rows={rows} />

      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-slate-500">
              <th className="pb-2 text-left font-normal">標的</th>
              <th className="pb-2 text-right font-normal">收盤</th>
              <th className="pb-2 text-right font-normal">短期均線</th>
              <th className="pb-2 text-left font-normal">短期狀態</th>
              <th className="pb-2 text-right font-normal">長期均線</th>
              <th className="pb-2 text-left font-normal">長期狀態</th>
              <th className="pb-2 text-left font-normal">價格型態</th>
            </tr>
          </thead>
          <tbody className="tabular">
            {rows.map((r) => (
              <tr key={r.code} className="border-t border-slate-800/60">
                <td className="whitespace-nowrap py-1.5">
                  <span className="text-slate-300">{r.code}</span>
                  {r.name && <span className="ml-1.5 text-slate-500">{r.name}</span>}
                </td>
                <td className="py-1.5 text-right text-slate-300">{num(r.close)}</td>
                <MaCell stance={r.short} />
                <MaCell stance={r.long} />
                <td className="py-1.5 text-left text-slate-400" title={r.pattern?.evidence ?? ''}>
                  {r.pattern?.name ?? '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {pending > 0 && (
        <p className="mt-1.5 text-[10px] text-slate-600">
          另有 {pending} 檔的歷史股價尚未載入或不足，未列入表中。
        </p>
      )}
    </div>
  );
}

/**
 * 均線值與狀態兩格。
 *
 * 均線值後面附上天數，因為每檔的均線參數可以各自設定，欄位標題寫不出固定天數。
 * 距離百分比直接跟在均線值下面，省一個欄位。
 */
function MaCell({ stance }) {
  if (!stance) {
    return (
      <>
        <td className="py-1.5 text-right text-slate-600">—</td>
        <td className="py-1.5 text-left text-slate-600">資料不足</td>
      </>
    );
  }
  const meta = STANCE_LABEL[stance.state] ?? STANCE_LABEL.UNKNOWN;
  return (
    <>
      <td className="whitespace-nowrap py-1.5 text-right">
        <span className="text-slate-300">{num(stance.ma)}</span>
        <span className="ml-1 text-[10px] text-slate-600">{stance.period}日</span>
        <div className="text-[10px] text-slate-500">{pct(stance.distancePercent, 1, true)}</div>
      </td>
      <td className="whitespace-nowrap py-1.5 text-left">
        {/* 持續狀態不給底色，只有剛穿越、剛確認的那幾檔才跳出來。 */}
        <span
          className={
            meta.steady
              ? `text-[11px] ${STATE_TEXT[stance.state]}`
              : `rounded px-1 py-0.5 text-[11px] ${STATE_BADGE[stance.state]}`
          }
          title={stance.description}
        >
          {meta.label}
        </span>
        {stance.daysSince !== null && !meta.steady && (
          <span className="ml-1 text-[10px] text-slate-600">
            {stance.daysSince === 0 ? '今日' : `${stance.daysSince} 日前`}
          </span>
        )}
      </td>
    </>
  );
}

/** 持續狀態的文字色，調暗代表「這是常態，不是訊息」。 */
const STATE_TEXT = {
  ABOVE: 'text-rose-400/70',
  BELOW: 'text-emerald-400/70',
  UNKNOWN: 'text-slate-500',
};

/** 事件狀態的標籤色，沿用台股紅漲綠跌。 */
const STATE_BADGE = {
  BULLISH_CONFIRMED: 'bg-rose-950/60 text-rose-400',
  WATCH_BREAKOUT: 'bg-rose-950/40 text-rose-400',
  BREAKDOWN_FAILED: 'bg-rose-950/40 text-rose-400',
  BEARISH_CONFIRMED: 'bg-emerald-950/60 text-emerald-400',
  WATCH_BREAKDOWN: 'bg-emerald-950/40 text-emerald-400',
  BREAKOUT_FAILED: 'bg-emerald-950/40 text-emerald-400',
};

/** 兩條均線只要有一條處於非持續狀態就往前排，兩條都是則更前面。 */
function eventScore(row) {
  const one = (s) => (s && !(STANCE_LABEL[s.state]?.steady ?? true) ? 1 : 0);
  return one(row.short) + one(row.long);
}

/** 表格上方的一行分布統計，依序列出各狀態的檔數。 */
function Tally({ rows }) {
  const lines = useMemo(() => {
    const count = (pick) => {
      const map = new Map();
      for (const r of rows) {
        const state = pick(r)?.state;
        if (!state) continue;
        map.set(state, (map.get(state) ?? 0) + 1);
      }
      return STATE_ORDER.filter((s) => map.has(s)).map(
        (s) => `${STANCE_LABEL[s].label} ${map.get(s)}`
      );
    };
    const patterns = new Map();
    for (const r of rows) {
      const name = r.pattern?.name ?? '型態未明';
      patterns.set(name, (patterns.get(name) ?? 0) + 1);
    }
    return [
      { label: '短期均線', parts: count((r) => r.short) },
      { label: '長期均線', parts: count((r) => r.long) },
      {
        label: '價格型態',
        parts: [...patterns.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .map(([name, n]) => `${name} ${n}`),
      },
    ];
  }, [rows]);

  return (
    <div className="space-y-0.5">
      {lines.map((line) => (
        <div key={line.label} className="flex gap-2 text-[11px]">
          <span className="w-16 shrink-0 text-slate-500">{line.label}</span>
          <span className="text-slate-400">{line.parts.join('　') || '—'}</span>
        </div>
      ))}
    </div>
  );
}

/** 統計依方向排序：偏空的排前面、偏多的排後面，重心一眼看得出來。 */
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
