/**
 * 台股交易成本計算。
 *
 * 費率為現行法定與市場慣例值，實際折扣依券商而異，
 * 因此 discount 開放調整，預設 0.6 折是目前線上下單的常見水準。
 */

/** 券商手續費率。 */
export const BROKER_FEE_RATE = 0.001425;
/** 手續費最低收取金額。 */
export const MIN_BROKER_FEE = 20;
/** 一般股票賣出時的證券交易稅率。 */
export const TAX_RATE = 0.003;
/** ETF 賣出時的證券交易稅率，低於一般股票。 */
export const ETF_TAX_RATE = 0.001;

/**
 * 判斷代號是否為 ETF。
 *
 * 台股 ETF 代號以 00 開頭（例如 0050、00878、00940），
 * 賣出稅率與一般股票不同，計算成本時必須分開處理。
 * @param {string} code
 * @returns {boolean}
 */
export function isEtf(code) {
  return /^00/.test(String(code));
}

/**
 * 計算單筆交易的成本。
 *
 * @param {{ code: string, shares: number, price: number, discount?: number }} trade
 *   shares 正為買進、負為賣出；discount 為手續費折扣，0.6 代表六折
 * @returns {{ brokerFee: number, tax: number, total: number }}
 */
export function tradeCost({ code, shares, price, discount = 0.6 }) {
  const amount = Math.abs(shares) * price;
  if (!Number.isFinite(amount) || amount <= 0) {
    return { brokerFee: 0, tax: 0, total: 0 };
  }

  // 手續費有最低收取金額，小額交易的實際費率會遠高於名目費率。
  const rawFee = amount * BROKER_FEE_RATE * discount;
  const brokerFee = Math.max(Math.round(rawFee), MIN_BROKER_FEE);

  // 證交稅只在賣出時課徵。
  const tax = shares < 0 ? Math.round(amount * (isEtf(code) ? ETF_TAX_RATE : TAX_RATE)) : 0;

  return { brokerFee, tax, total: brokerFee + tax };
}
