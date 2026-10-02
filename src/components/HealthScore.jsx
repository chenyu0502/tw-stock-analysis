import { MIN_COVERAGE } from '../lib/health.js';

/**
 * 體質評分。
 *
 * **燈號描述體質強弱，不是買賣建議。** 這是刻意的區分：本站不給買賣指令
 * （見 stance.js 的說明），而「體質強健」與「現在該買」是兩件事——
 * 一家好公司可以買在很差的價位。
 *
 * 顏色刻意避開紅綠。台股紅漲綠跌，用紅色標「偏弱」會被讀成「下跌」，
 * 用綠色標「強健」會被讀成「跌」。沿用估值面板那套中性的天藍與琥珀。
 */
const LIGHT_STYLE = {
  strong: 'border-sky-500/40 bg-sky-500/10 text-sky-300',
  steady: 'border-indigo-500/40 bg-indigo-500/10 text-indigo-300',
  fair: 'border-slate-600/50 bg-slate-700/20 text-slate-300',
  weak: 'border-amber-500/40 bg-amber-500/10 text-amber-400',
};

/** 進度條顏色沿用同一套分級，讓條與燈號讀起來是同一個尺度。 */
function barColor(score) {
  if (score === null) return 'bg-slate-800';
  if (score >= 75) return 'bg-sky-400/80';
  if (score >= 60) return 'bg-indigo-400/70';
  if (score >= 45) return 'bg-slate-500/70';
  return 'bg-amber-500/70';
}

/**
 * @param {{ health: object|null, loading?: boolean }} props
 */
export default function HealthScore({ health, loading = false }) {
  // 財報還在載入時一律顯示載入中，不先把只評得出趨勢的薄分數端上來。
  // 那個分數會在財報到齊後整個換掉，中間那一瞬的「涵蓋率 20%」只會造成誤解。
  if (loading) {
    return <div className="py-6 text-center text-sm text-slate-500">載入體質資料中…</div>;
  }
  if (!health) {
    return (
      <div className="py-6 text-center text-sm text-slate-500">
        可評項目不足，無法計算體質評分。歷史股價不足 120 個交易日且無財報時會出現這個情形。
      </div>
    );
  }

  const { total, coverage, light, dimensions } = health;
  const thin = coverage < MIN_COVERAGE;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-x-3 gap-y-1">
        <div>
          {/* 涵蓋率不足時改稱「可評項目得分」。
              那個數字本身是對的，但標成「總分」會讓人以為它衡量了全部面向——
              ETF 只評到趨勢那一項，叫總分就是誤導。 */}
          <div className="text-[12px] text-slate-500">{thin ? '可評項目得分' : '體質總分'}</div>
          <div className="tabular text-2xl font-semibold leading-none text-slate-100">
            {total}
            <span className="ml-1 text-sm font-normal text-slate-500">/ 100</span>
          </div>
        </div>

        <span
          className={`rounded border px-2 py-0.5 text-xs ${
            light ? LIGHT_STYLE[light.key] : 'border-slate-700/50 bg-slate-800/40 text-slate-500'
          }`}
        >
          {light ? light.label : '資料不足'}
        </span>

        <span className={`text-[12px] ${thin ? 'text-amber-400' : 'text-slate-600'}`}>
          涵蓋率 {coverage}%
        </span>
      </div>

      {thin && (
        <p className="rounded-lg border border-amber-900/60 bg-amber-950/30 px-2.5 py-2 text-[12px] leading-relaxed text-amber-400">
          可評面向的權重只占 {coverage}%，不給體質等級。ETF 與受益證券沒有財報，
          只評得出趨勢與配息，用那樣的分數標一個等級讀起來像「體質強健」，
          實際上只是「股價在長期均線之上」。下方各面向的得分仍然有效。
        </p>
      )}

      <div className="space-y-2.5">
        {dimensions.map((d) => (
          <Dimension key={d.key} data={d} />
        ))}
      </div>

      <p className="text-[12px] leading-relaxed text-slate-600">
        等級描述的是<span className="text-slate-400">體質強弱，不是買賣建議</span>
        ——好公司也可能買在很差的價位。
        分數由固定門檻計算，輸入相同就得到相同結果，不經過 AI。
        每一項都附上觸發它的實際數值，可自行驗證也可以不同意。
        權重刻意偏向中長期：KD、MACD、RSI 完全不計入，那些回答的是「現在在什麼位置」，
        不是「這家公司好不好」。
      </p>
    </div>
  );
}

function Dimension({ data }) {
  const { label, note, weight, score, details, reason } = data;

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-2">
        <span className="text-xs text-slate-300">
          {label}
          <span className="ml-1.5 text-[11px] text-slate-600">權重 {weight}</span>
        </span>
        <span className="tabular text-xs text-slate-100">
          {score === null ? <span className="text-slate-600">不適用</span> : score}
        </span>
      </div>

      <div className="mt-1 h-1.5 overflow-hidden rounded bg-slate-800">
        <div
          className={`h-full rounded ${barColor(score)}`}
          style={{ width: `${score === null ? 0 : score}%` }}
        />
      </div>

      {score === null ? (
        <p className="mt-0.5 text-[11px] text-slate-600">{reason}</p>
      ) : (
        <ul className="tabular mt-1 space-y-0.5">
          {details.map((item) => (
            <li key={item.label} className="flex justify-between gap-2 text-[11px] text-slate-500">
              <span className="min-w-0">
                {item.label}
                <span className="ml-1.5 text-slate-400">{item.value}</span>
              </span>
              <span className="shrink-0 text-slate-600">{item.score ?? '—'}</span>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-0.5 text-[11px] leading-relaxed text-slate-700">{note}</p>
    </div>
  );
}
