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
 * @param {object} params
 * @param {string} params.code
 * @param {string} [params.name]
 * @param {object[]} params.candles
 * @param {number} params.maShort
 * @param {number} params.maLong
 * @param {object} [params.valuation] 本益比、股價淨值比、殖利率，長線判斷需要
 * @param {object} [params.institutional] 當日三大法人買賣超
 * @param {object[]} [params.chipSeries] 法人買賣超歷史序列，中線判斷需要
 * @param {object} [params.margin] 融資融券
 * @returns {object|null} 資料不足時回傳 null
 */
export function buildAnalysisInput({
  code,
  name,
  candles,
  maShort,
  maLong,
  valuation,
  institutional,
  chipSeries,
  margin,
}) {
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
  const periodHigh = Math.max(...candles.map((c) => c.high));
  const periodLow = Math.min(...candles.map((c) => c.low));

  // 120 日均線代表長期趨勢方向，與其斜率一併送出，長線立場判斷需要。
  const ma120Series = sma(closes, 120);
  const ma120 = ma120Series[last];
  const ma120Prev = ma120Series[Math.max(0, last - 20)];

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
      ma120,
      // 以近 20 日的變化量表示長期均線是走揚還是走跌。
      ma120Slope: ma120 !== null && ma120Prev ? ((ma120 - ma120Prev) / ma120Prev) * 100 : null,
      crossLabel: cross.label,
      bias5: bias5[last],
      bias20: bias20[last],
      atr: atrSeries[last],
    },
    recent: {
      periodDays: candles.length,
      high: periodHigh,
      low: periodLow,
      change20: base ? ((closes[last] - base) / base) * 100 : null,
      volumeRatio: vol20 ? vol5 / vol20 : null,
      // 現價在期間高低之間的位置，用來判斷是處於相對高檔還是低檔。
      pricePosition:
        periodHigh > periodLow ? ((closes[last] - periodLow) / (periodHigh - periodLow)) * 100 : null,
    },
    valuation: valuation
      ? {
          peRatio: valuation.peRatio,
          pbRatio: valuation.pbRatio,
          dividendYield: valuation.dividendYield,
        }
      : null,
    chips: buildChipSummary({ institutional, chipSeries, margin }),
  };
}

/**
 * 彙整籌碼面摘要。
 *
 * 中線立場很大程度取決於法人的持續動向，單看當日買賣超會被單日的異常值誤導，
 * 因此同時提供近 5 日與近 20 日的累計。
 *
 * @param {{ institutional?: object, chipSeries?: object[], margin?: object }} params
 * @returns {object|null}
 */
function buildChipSummary({ institutional, chipSeries, margin }) {
  if (!institutional && !chipSeries && !margin) return null;

  const sum = (series, key) => series.reduce((acc, row) => acc + (row[key] ?? 0), 0);
  const series = Array.isArray(chipSeries) ? chipSeries : [];

  return {
    today: institutional
      ? { foreign: institutional.foreign, trust: institutional.trust, dealer: institutional.dealer }
      : null,
    last5:
      series.length > 0
        ? {
            foreign: sum(series.slice(-5), 'foreign'),
            trust: sum(series.slice(-5), 'trust'),
            dealer: sum(series.slice(-5), 'dealer'),
          }
        : null,
    last20:
      series.length > 0
        ? {
            foreign: sum(series.slice(-20), 'foreign'),
            trust: sum(series.slice(-20), 'trust'),
            dealer: sum(series.slice(-20), 'dealer'),
          }
        : null,
    margin: margin
      ? {
          marginChange: margin.marginChange,
          shortChange: margin.shortChange,
          shortMarginRatio: margin.shortMarginRatio,
        }
      : null,
  };
}
