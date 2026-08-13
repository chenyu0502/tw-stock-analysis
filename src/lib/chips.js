/**
 * 籌碼面計算。
 *
 * 輸入為 /api/institutional?days=N 回傳的每日買賣超序列，單位為張。
 * 序列已由伺服器端依日期升冪排序，最後一筆為最近的交易日。
 */

/** 法人別的鍵名與顯示名稱。順序即為介面上的顯示順序。 */
export const INVESTORS = [
  { key: 'foreign', label: '外資' },
  { key: 'trust', label: '投信' },
  { key: 'dealer', label: '自營商' },
];

/**
 * 計算連續買超或賣超的天數。
 *
 * 從最近一個交易日往回數，方向相同才續計。買賣超為零的當天視為中斷，
 * 因為「當天沒有動作」不能算進連買或連賣，那會虛增天數。
 *
 * @param {object[]} series 每日買賣超序列
 * @param {string} key 法人別鍵名
 * @returns {{ direction: 'buy'|'sell'|'none', days: number, amount: number }}
 *   amount 為這段連續期間的累計買賣超張數
 */
export function streak(series, key) {
  if (!series?.length) return { direction: 'none', days: 0, amount: 0 };

  const last = series[series.length - 1][key] ?? 0;
  if (last === 0) return { direction: 'none', days: 0, amount: 0 };

  const direction = last > 0 ? 'buy' : 'sell';
  let days = 0;
  let amount = 0;

  for (let i = series.length - 1; i >= 0; i -= 1) {
    const value = series[i][key] ?? 0;
    if (value === 0) break;
    if (value > 0 !== (direction === 'buy')) break;
    days += 1;
    amount += value;
  }

  return { direction, days, amount };
}

/**
 * 彙總一段期間的籌碼面狀況。
 *
 * @param {object[]} series
 * @returns {{
 *   days: number,
 *   totals: Record<string, number>,
 *   streaks: Record<string, {direction:string, days:number, amount:number}>,
 *   buyDays: Record<string, number>
 * }}
 */
export function summarize(series) {
  const totals = {};
  const streaks = {};
  const buyDays = {};

  for (const { key } of INVESTORS) {
    totals[key] = (series ?? []).reduce((acc, row) => acc + (row[key] ?? 0), 0);
    streaks[key] = streak(series, key);
    buyDays[key] = (series ?? []).filter((row) => (row[key] ?? 0) > 0).length;
  }

  return { days: series?.length ?? 0, totals, streaks, buyDays };
}

/**
 * 把連續天數轉為可讀敘述。
 * @param {{direction:string, days:number}} s
 * @param {string} label
 * @returns {string|null} 無連續動作時回傳 null
 */
export function streakText(s, label) {
  if (!s || s.direction === 'none' || s.days === 0) return null;
  return `${label}連${s.direction === 'buy' ? '買' : '賣'} ${s.days} 日`;
}
