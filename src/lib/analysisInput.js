/**
 * 組出送給 AI 分析端點的請求內容。
 *
 * 這裡負責把 K 線轉成模型需要的摘要：價位結構、指標快照、近期走勢。
 * 刻意不送完整 K 線序列，理由有二：
 * 1. 模型不需要逐日資料就能做型態判讀。
 * 2. 送整串會誘使模型自行從數列裡挑價格，違反「價位一律由程式計算」的原則。
 */

import { computeLevels } from './levels.js';
import { crossState, kd, macd, rsi, bias, atr, sma } from './indicators.js';

/** 用於計算近期漲跌幅的區間長度。 */
const RECENT_WINDOW = 20;

/**
 * @param {{ code: string, name?: string, candles: object[], maShort: number, maLong: number }} params
 * @returns {object|null} 資料不足時回傳 null
 */
export function buildAnalysisInput({ code, name, candles, maShort, maLong }) {
  if (!candles || candles.length < 60) return null;

  const levels = computeLevels(candles);
  if (!levels) return null;

  const closes = candles.map((c) => c.close);
  const last = candles.length - 1;

  const { k, d } = kd(candles);
  const { dif, histogram } = macd(closes);
  const rsiSeries = rsi(closes);
  const bias5 = bias(closes, 5);
  const bias20 = bias(closes, 20);
  const atrSeries = atr(candles);
  const cross = crossState(closes, maShort, maLong);

  // 量能比反映近期是否有增溫或萎縮，是判斷突破真假的重要輔助。
  const volumes = candles.map((c) => c.volume ?? 0);
  const avg = (arr) => (arr.length === 0 ? null : arr.reduce((a, b) => a + b, 0) / arr.length);
  const vol5 = avg(volumes.slice(-5));
  const vol20 = avg(volumes.slice(-20));

  const base = closes[Math.max(0, last - RECENT_WINDOW)];

  return {
    code,
    name,
    price: levels.price,
    levels: {
      supports: levels.supports,
      resistances: levels.resistances,
    },
    indicators: {
      k: k[last],
      d: d[last],
      rsi: rsiSeries[last],
      dif: dif[last],
      histogram: histogram[last],
      maShort,
      maLong,
      shortMa: sma(closes, maShort)[last],
      longMa: sma(closes, maLong)[last],
      crossLabel: cross.label,
      bias5: bias5[last],
      bias20: bias20[last],
      atr: atrSeries[last],
    },
    recent: {
      periodDays: candles.length,
      high: Math.max(...candles.map((c) => c.high)),
      low: Math.min(...candles.map((c) => c.low)),
      change20: base ? ((closes[last] - base) / base) * 100 : null,
      volumeRatio: vol20 ? vol5 / vol20 : null,
    },
  };
}
