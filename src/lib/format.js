/**
 * 顯示格式化工具。
 *
 * 重要慣例：台股的漲跌顏色與歐美相反，紅色代表上漲、綠色代表下跌。
 * 全站顏色一律透過這裡的函式取得，不要在元件內各自判斷。
 */

/**
 * 數字格式化，null 或非數字回傳破折號。
 * @param {number|null|undefined} value
 * @param {number} [digits=2]
 * @returns {string}
 */
export function num(value, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toLocaleString('zh-TW', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/**
 * 整數格式化，用於張數與股數。
 * @param {number|null|undefined} value
 * @returns {string}
 */
export function int(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return Math.round(value).toLocaleString('zh-TW');
}

/**
 * 百分比格式化。
 *
 * signed 為 true 時正值會補上正號，用於漲跌幅、報酬率、乖離率這類方向有意義的數值。
 * 殖利率、勝率、券資比這類永遠為正的比率不應加正號，維持 signed 為 false。
 * @param {number|null|undefined} value
 * @param {number} [digits=2]
 * @param {boolean} [signed=false]
 * @returns {string}
 */
export function pct(value, digits = 2, signed = false) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const sign = signed && value > 0 ? '+' : '';
  return `${sign}${value.toFixed(digits)}%`;
}

/**
 * 金額格式化，不顯示小數。
 * @param {number|null|undefined} value
 * @returns {string}
 */
export function money(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `NT$ ${Math.round(value).toLocaleString('zh-TW')}`;
}

/**
 * 取得台股慣例的漲跌顏色 class。上漲紅、下跌綠、平盤灰。
 * @param {number|null|undefined} value
 * @returns {string}
 */
export function changeColor(value) {
  if (value === null || value === undefined || !Number.isFinite(value) || value === 0) {
    return 'text-slate-400';
  }
  return value > 0 ? 'text-rose-500' : 'text-emerald-500';
}

/**
 * 依均線交叉狀態取得對應的顏色 class。
 * @param {string} state 來自 indicators.crossState 的 state 值
 * @returns {string}
 */
export function stateColor(state) {
  switch (state) {
    case 'golden':
    case 'bullish':
      return 'text-rose-500 bg-rose-500/10 border-rose-500/30';
    case 'death':
    case 'bearish':
      return 'text-emerald-500 bg-emerald-500/10 border-emerald-500/30';
    case 'pullback':
    case 'rebound':
      return 'text-amber-500 bg-amber-500/10 border-amber-500/30';
    default:
      return 'text-slate-400 bg-slate-500/10 border-slate-500/30';
  }
}
