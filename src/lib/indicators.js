/**
 * 技術指標計算。
 *
 * 設計原則：
 * 1. 所有函式回傳與輸入等長的陣列，資料不足的位置填 null，不做截斷。
 *    這樣指標序列可以直接跟 K 線序列對齊畫圖，不需要在呼叫端補位移。
 * 2. 純函式，不改動輸入陣列。
 * 3. 不做四捨五入，格式化交給顯示層處理，避免誤差在後續計算中累積。
 */

/* ------------------------------------------------------------------ */
/* 移動平均                                                            */
/* ------------------------------------------------------------------ */

/**
 * 簡單移動平均。
 * @param {number[]} values
 * @param {number} period
 * @returns {(number|null)[]}
 */
export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;

  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/**
 * 指數移動平均。前 period 筆以 SMA 作為種子值，避免起始偏差過大。
 * @param {number[]} values
 * @param {number} period
 * @returns {(number|null)[]}
 */
export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;

  const alpha = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i += 1) seed += values[i];
  out[period - 1] = seed / period;

  for (let i = period; i < values.length; i += 1) {
    out[i] = values[i] * alpha + out[i - 1] * (1 - alpha);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* MACD                                                                */
/* ------------------------------------------------------------------ */

/**
 * MACD 指標。
 *
 * dif 為快慢線差值（台股習慣稱 DIF），signal 為 dif 的 EMA（習慣稱 MACD 或 DEA），
 * histogram 為兩者差值（習慣稱 OSC 柱狀體）。
 * @param {number[]} closes
 * @param {number} [fast=12]
 * @param {number} [slow=26]
 * @param {number} [signalPeriod=9]
 * @returns {{ dif:(number|null)[], signal:(number|null)[], histogram:(number|null)[] }}
 */
export function macd(closes, fast = 12, slow = 26, signalPeriod = 9) {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);

  const dif = closes.map((_, i) =>
    emaFast[i] === null || emaSlow[i] === null ? null : emaFast[i] - emaSlow[i]
  );

  // signal 是 dif 的 EMA，但 dif 前段是 null，必須先取出有效區段再計算，
  // 否則 null 會污染整條 EMA。
  const firstValid = dif.findIndex((v) => v !== null);
  const signal = new Array(closes.length).fill(null);
  if (firstValid !== -1) {
    const compact = dif.slice(firstValid);
    const compactSignal = ema(compact, signalPeriod);
    for (let i = 0; i < compactSignal.length; i += 1) {
      signal[firstValid + i] = compactSignal[i];
    }
  }

  const histogram = closes.map((_, i) =>
    dif[i] === null || signal[i] === null ? null : dif[i] - signal[i]
  );

  return { dif, signal, histogram };
}

/* ------------------------------------------------------------------ */
/* KD 隨機指標                                                          */
/* ------------------------------------------------------------------ */

/**
 * KD 隨機指標，台股慣用參數 (9, 3, 3)。
 *
 * RSV = (今日收盤 - 期間最低) / (期間最高 - 期間最低) x 100
 * K = 前一日 K x 2/3 + RSV x 1/3
 * D = 前一日 D x 2/3 + K x 1/3
 * 起始 K 與 D 皆以 50 作為種子，這是台股軟體的通用做法。
 * @param {{high:number, low:number, close:number}[]} candles
 * @param {number} [period=9]
 * @param {number} [kSmooth=3]
 * @param {number} [dSmooth=3]
 * @returns {{ k:(number|null)[], d:(number|null)[], rsv:(number|null)[] }}
 */
export function kd(candles, period = 9, kSmooth = 3, dSmooth = 3) {
  const n = candles.length;
  const rsv = new Array(n).fill(null);
  const k = new Array(n).fill(null);
  const d = new Array(n).fill(null);

  let prevK = 50;
  let prevD = 50;

  for (let i = period - 1; i < n; i += 1) {
    const window = candles.slice(i - period + 1, i + 1);
    const high = Math.max(...window.map((c) => c.high));
    const low = Math.min(...window.map((c) => c.low));

    // 期間內高低相等（一價到底）時分母為零，沿用前一日 RSV 的概念填 50。
    const currentRsv = high === low ? 50 : ((candles[i].close - low) / (high - low)) * 100;

    const currentK = prevK * ((kSmooth - 1) / kSmooth) + currentRsv * (1 / kSmooth);
    const currentD = prevD * ((dSmooth - 1) / dSmooth) + currentK * (1 / dSmooth);

    rsv[i] = currentRsv;
    k[i] = currentK;
    d[i] = currentD;
    prevK = currentK;
    prevD = currentD;
  }

  return { k, d, rsv };
}

/* ------------------------------------------------------------------ */
/* RSI                                                                 */
/* ------------------------------------------------------------------ */

/**
 * 相對強弱指標，採 Wilder 平滑。
 * @param {number[]} closes
 * @param {number} [period=14]
 * @returns {(number|null)[]}
 */
export function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i += 1) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gainSum += diff;
    else lossSum -= diff;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i += 1) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 乖離率與布林通道                                                      */
/* ------------------------------------------------------------------ */

/**
 * 乖離率：股價偏離均線的百分比，用於判斷是否過熱或超跌。
 * @param {number[]} closes
 * @param {number} period
 * @returns {(number|null)[]}
 */
export function bias(closes, period) {
  const line = sma(closes, period);
  return closes.map((c, i) => (line[i] === null || line[i] === 0 ? null : ((c - line[i]) / line[i]) * 100));
}

/**
 * 布林通道。
 * @param {number[]} closes
 * @param {number} [period=20]
 * @param {number} [multiplier=2]
 * @returns {{ middle:(number|null)[], upper:(number|null)[], lower:(number|null)[], bandwidth:(number|null)[] }}
 */
export function bollinger(closes, period = 20, multiplier = 2) {
  const middle = sma(closes, period);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  const bandwidth = new Array(closes.length).fill(null);

  for (let i = period - 1; i < closes.length; i += 1) {
    const window = closes.slice(i - period + 1, i + 1);
    const mean = middle[i];
    const variance = window.reduce((acc, v) => acc + (v - mean) ** 2, 0) / period;
    const sd = Math.sqrt(variance);
    upper[i] = mean + multiplier * sd;
    lower[i] = mean - multiplier * sd;
    // 帶寬收窄代表波動壓縮，常見於變盤前，是實用的觀察值。
    bandwidth[i] = mean === 0 ? null : ((upper[i] - lower[i]) / mean) * 100;
  }

  return { middle, upper, lower, bandwidth };
}

/* ------------------------------------------------------------------ */
/* ATR                                                                 */
/* ------------------------------------------------------------------ */

/**
 * 平均真實區間，用於以波動度設定停損距離。
 * @param {{high:number, low:number, close:number}[]} candles
 * @param {number} [period=14]
 * @returns {(number|null)[]}
 */
export function atr(candles, period = 14) {
  const n = candles.length;
  const out = new Array(n).fill(null);
  if (n <= period) return out;

  const trueRanges = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prevClose = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
  });

  let sum = 0;
  for (let i = 1; i <= period; i += 1) sum += trueRanges[i];
  out[period] = sum / period;

  for (let i = period + 1; i < n; i += 1) {
    out[i] = (out[i - 1] * (period - 1) + trueRanges[i]) / period;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 均線交叉狀態判定                                                      */
/* ------------------------------------------------------------------ */

/**
 * 判定短長均線的排列狀態。
 *
 * 回傳的 state 值：
 * - `golden`：黃金交叉（短均線由下方穿越長均線）
 * - `death`：死亡交叉（短均線由上方跌破長均線）
 * - `bullish`：短均線在上且股價在短均線之上，多頭排列
 * - `bearish`：短均線在下且股價在短均線之下，空頭排列
 * - `tangled`：兩線距離在 1% 以內，視為糾結，方向不明
 * - `unknown`：資料不足
 *
 * @param {number[]} closes
 * @param {number} shortPeriod
 * @param {number} longPeriod
 * @param {number} [tangleThreshold=1] 判定糾結的百分比門檻
 * @returns {{ state:string, label:string, shortMa:number|null, longMa:number|null, gapPercent:number|null }}
 */
export function crossState(closes, shortPeriod, longPeriod, tangleThreshold = 1) {
  const shortLine = sma(closes, shortPeriod);
  const longLine = sma(closes, longPeriod);
  const i = closes.length - 1;

  const s = shortLine[i];
  const l = longLine[i];
  const prevS = shortLine[i - 1];
  const prevL = longLine[i - 1];

  if (s === null || l === null) {
    return { state: 'unknown', label: '資料不足', shortMa: s, longMa: l, gapPercent: null };
  }

  const gapPercent = l === 0 ? null : ((s - l) / l) * 100;

  if (prevS !== null && prevL !== null) {
    if (prevS <= prevL && s > l) {
      return { state: 'golden', label: '黃金交叉', shortMa: s, longMa: l, gapPercent };
    }
    if (prevS >= prevL && s < l) {
      return { state: 'death', label: '死亡交叉', shortMa: s, longMa: l, gapPercent };
    }
  }

  if (gapPercent !== null && Math.abs(gapPercent) < tangleThreshold) {
    return { state: 'tangled', label: '均線糾結', shortMa: s, longMa: l, gapPercent };
  }

  const close = closes[i];
  if (s > l) {
    return {
      state: close >= s ? 'bullish' : 'pullback',
      label: close >= s ? '多頭排列' : '多頭回檔',
      shortMa: s,
      longMa: l,
      gapPercent,
    };
  }
  return {
    state: close <= s ? 'bearish' : 'rebound',
    label: close <= s ? '空頭排列' : '空頭反彈',
    shortMa: s,
    longMa: l,
    gapPercent,
  };
}

/* ------------------------------------------------------------------ */
/* 均線參數回測最佳化                                                    */
/* ------------------------------------------------------------------ */

/**
 * 以均線交叉策略回測單一組參數。
 *
 * 交易規則（只做多，不放空）：
 * - 短均線上穿長均線的隔日開盤買進
 * - 短均線下穿長均線的隔日開盤賣出
 * 使用隔日開盤價而非當日收盤價，是為了避免用當日收盤才知道的訊號在當日收盤成交，
 * 那會高估績效（前視偏誤）。
 *
 * @param {{open:number, close:number}[]} candles
 * @param {number} shortPeriod
 * @param {number} longPeriod
 * @param {number} [feeRate=0.004425] 單趟手續費加賣出交易稅的合計估計值
 * @returns {{ shortPeriod:number, longPeriod:number, totalReturn:number, trades:number, wins:number, winRate:number, maxDrawdown:number }}
 */
export function backtestCrossover(candles, shortPeriod, longPeriod, feeRate = 0.004425) {
  const closes = candles.map((c) => c.close);
  const shortLine = sma(closes, shortPeriod);
  const longLine = sma(closes, longPeriod);

  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  let entryPrice = null;
  let trades = 0;
  let wins = 0;

  /**
   * 以當日收盤價逐日結算帳面權益並更新回檔。
   *
   * 只在平倉時取樣是不夠的：一組全部獲利出場的參數會算出零回檔，
   * 但持倉期間可能經歷過三成的帳面虧損。實際交易時真正讓人出場的是帳面回檔，
   * 因此必須逐日結算。
   * @param {number} close
   */
  function markToMarket(close) {
    const value = entryPrice === null ? equity : equity * (close / entryPrice) * (1 - feeRate);
    peak = Math.max(peak, value);
    maxDrawdown = Math.max(maxDrawdown, (peak - value) / peak);
  }

  for (let i = longPeriod; i < candles.length - 1; i += 1) {
    const s = shortLine[i];
    const l = longLine[i];
    const prevS = shortLine[i - 1];
    const prevL = longLine[i - 1];
    if (s === null || l === null || prevS === null || prevL === null) continue;

    const goldenCross = prevS <= prevL && s > l;
    const deathCross = prevS >= prevL && s < l;
    const nextOpen = candles[i + 1].open ?? candles[i + 1].close;

    if (goldenCross && entryPrice === null) {
      entryPrice = nextOpen;
    } else if (deathCross && entryPrice !== null) {
      const netReturn = (nextOpen / entryPrice) * (1 - feeRate);
      equity *= netReturn;
      trades += 1;
      if (netReturn > 1) wins += 1;
      entryPrice = null;
    }

    markToMarket(closes[i]);
  }

  // 回測結束時仍持有部位，以最後收盤價結算，否則會漏掉尚未平倉的盈虧。
  if (entryPrice !== null) {
    const netReturn = (closes[closes.length - 1] / entryPrice) * (1 - feeRate);
    equity *= netReturn;
    trades += 1;
    if (netReturn > 1) wins += 1;
    entryPrice = null;
  }
  markToMarket(closes[closes.length - 1]);

  return {
    shortPeriod,
    longPeriod,
    totalReturn: (equity - 1) * 100,
    trades,
    wins,
    winRate: trades === 0 ? 0 : (wins / trades) * 100,
    maxDrawdown: maxDrawdown * 100,
    // 買進持有作為對照組，策略贏不過它就沒有使用價值。
    buyHoldReturn: (closes[closes.length - 1] / closes[longPeriod] - 1) * 100,
  };
}

/** 回測時掃描的短均線候選天數。 */
const SHORT_CANDIDATES = [3, 5, 8, 10, 12, 15, 18, 20];
/** 回測時掃描的長均線候選天數。 */
const LONG_CANDIDATES = [20, 30, 40, 45, 50, 60, 72, 90, 120];

/**
 * 掃描候選參數組合，找出回測績效最佳的短長均線天數。
 *
 * 這裡刻意不做全範圍暴力搜尋（例如 3 到 120 的所有組合），原因有二：
 * 1. 組合數過多會嚴重過度配適，選出的參數在未來沒有意義。
 * 2. 前端要即時運算，候選集控制在 70 組左右才不會卡住畫面。
 *
 * @param {{open:number, close:number}[]} candles
 * @param {{ minTrades?:number }} [options] minTrades 用於排除交易次數過少、統計上不可信的組合
 * @returns {{ best:object|null, results:object[] }}
 */
export function optimizeMaPeriods(candles, options = {}) {
  const { minTrades = 3 } = options;
  if (candles.length < 60) return { best: null, results: [] };

  const results = [];
  for (const shortPeriod of SHORT_CANDIDATES) {
    for (const longPeriod of LONG_CANDIDATES) {
      if (longPeriod <= shortPeriod * 1.5) continue;
      if (candles.length < longPeriod + 20) continue;
      results.push(backtestCrossover(candles, shortPeriod, longPeriod));
    }
  }

  const eligible = results.filter((r) => r.trades >= minTrades);
  const pool = eligible.length > 0 ? eligible : results;

  // 排序依據為報酬率，勝率僅作為同分時的次要條件。單看勝率會選到
  // 「贏很多次小錢、輸一次大錢」的組合。
  pool.sort((a, b) => b.totalReturn - a.totalReturn || b.winRate - a.winRate);

  return { best: pool[0] ?? null, results };
}
