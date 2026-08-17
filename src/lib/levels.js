/**
 * 支撐壓力價位計算。
 *
 * 設計原則：價位一律由歷史資料推導，不交給語言模型產生。
 *
 * 語言模型對長數列做精確數值推理並不可靠，它可能回一個看起來合理、
 * 但實際上不落在任何轉折點或量能密集區的價位。那種數字拿來設停損毫無根據。
 * 這個模組算出的每一個價位都對應到真實的價格結構，可以逐項驗證。
 *
 * 三個來源：
 * 1. 擺盪高低點：價格實際反轉過的位置
 * 2. 成交量密集區：大量籌碼換手的價位，套牢或解套壓力集中處
 * 3. 移動平均線：市場廣泛觀察的動態支撐壓力
 */

import { sma } from './indicators.js';

/**
 * 找出擺盪高低點。
 *
 * 採用碎形定義：某根 K 棒的高點若是前後各 lookback 根之內的最高，即為擺盪高點。
 * lookback 越大，找出的轉折越重要但數量越少。
 *
 * @param {{date:string, high:number, low:number}[]} candles
 * @param {number} [lookback=3]
 * @returns {{index:number, date:string, price:number, type:'high'|'low'}[]}
 */
export function findSwingPivots(candles, lookback = 3) {
  const pivots = [];

  for (let i = lookback; i < candles.length - lookback; i += 1) {
    const window = candles.slice(i - lookback, i + lookback + 1);
    const highs = window.map((c) => c.high);
    const lows = window.map((c) => c.low);

    if (candles[i].high === Math.max(...highs)) {
      pivots.push({ index: i, date: candles[i].date, price: candles[i].high, type: 'high' });
    }
    if (candles[i].low === Math.min(...lows)) {
      pivots.push({ index: i, date: candles[i].date, price: candles[i].low, type: 'low' });
    }
  }

  return pivots;
}

/**
 * 建立成交量分布。
 *
 * 把價格區間切成等寬的價格帶，把每根 K 棒的成交量計入其典型價所在的價格帶。
 * 成交量集中的價格帶代表大量籌碼在該價位換手，日後往往形成支撐或壓力。
 *
 * @param {{high:number, low:number, close:number, volume:number}[]} candles
 * @param {number} [bins=24]
 * @returns {{low:number, high:number, mid:number, volume:number}[]} 依成交量由大到小排序
 */
export function volumeProfile(candles, bins = 24) {
  const valid = candles.filter((c) => Number.isFinite(c.volume) && c.volume > 0);
  if (valid.length === 0) return [];

  const lowest = Math.min(...valid.map((c) => c.low));
  const highest = Math.max(...valid.map((c) => c.high));
  const span = highest - lowest;
  if (span <= 0) return [];

  const width = span / bins;
  const buckets = Array.from({ length: bins }, (_, i) => ({
    low: lowest + i * width,
    high: lowest + (i + 1) * width,
    mid: lowest + (i + 0.5) * width,
    volume: 0,
  }));

  for (const candle of valid) {
    // 以典型價（高低收平均）代表該日成交的價格重心，比單用收盤價更貼近實際換手位置。
    const typical = (candle.high + candle.low + candle.close) / 3;
    const index = Math.min(bins - 1, Math.max(0, Math.floor((typical - lowest) / width)));
    buckets[index].volume += candle.volume;
  }

  return buckets.filter((b) => b.volume > 0).sort((a, b) => b.volume - a.volume);
}

/**
 * 計算某個價位在歷史上被觸及的次數。
 *
 * 觸及的定義是當日的高低區間涵蓋該價位的容許範圍。
 * 觸及次數越多，代表市場在該價位反覆攻防，價位越有意義。
 *
 * @param {{high:number, low:number}[]} candles
 * @param {number} price
 * @param {number} tolerance 容許範圍，以價格比例表示
 * @returns {{ touches:number, lastIndex:number }}
 */
function countTouches(candles, price, tolerance) {
  const band = price * tolerance;
  let touches = 0;
  let lastIndex = -1;

  for (let i = 0; i < candles.length; i += 1) {
    if (candles[i].low <= price + band && candles[i].high >= price - band) {
      touches += 1;
      lastIndex = i;
    }
  }
  return { touches, lastIndex };
}

/**
 * 把相近的候選價位合併成群。
 *
 * 不合併的話，同一個價格區域的多個擺盪點會被當成好幾個獨立價位，
 * 使用者看到的是四五個只差 0.5% 的「支撐」，那是雜訊不是資訊。
 *
 * @param {{price:number, source:string, date?:string}[]} candidates
 * @param {number} tolerance 合併門檻，以價格比例表示
 * @returns {{price:number, sources:string[], members:number, latestDate:string|null}[]}
 */
function clusterLevels(candidates, tolerance) {
  const sorted = [...candidates].sort((a, b) => a.price - b.price);
  const clusters = [];

  for (const item of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && Math.abs(item.price - last.price) <= last.price * tolerance) {
      last.items.push(item);
      // 群心採算術平均，讓群內每個候選價位有相同權重。
      last.price = last.items.reduce((acc, x) => acc + x.price, 0) / last.items.length;
    } else {
      clusters.push({ price: item.price, items: [item] });
    }
  }

  return clusters.map((c) => ({
    price: c.price,
    sources: [...new Set(c.items.map((x) => x.source))],
    members: c.items.length,
    latestDate: c.items.map((x) => x.date).filter(Boolean).sort().pop() ?? null,
  }));
}

/** 各來源的基礎分數。擺盪點是實際反轉過的位置，權重最高。 */
const SOURCE_WEIGHT = { swing: 3, volume: 2, ma: 2, extreme: 2 };

/**
 * 計算支撐與壓力價位。
 *
 * @param {{date:string, open:number, high:number, low:number, close:number, volume:number}[]} candles
 * @param {object} [options]
 * @param {number} [options.lookback=3] 擺盪點的判定範圍
 * @param {number} [options.tolerance=0.015] 價位合併與觸及判定的容許比例
 * @param {number} [options.count=2] 支撐與壓力各取幾個
 * @returns {{
 *   price: number,
 *   supports: object[],
 *   resistances: object[],
 *   volumeNodes: object[]
 * } | null}
 */
export function computeLevels(candles, options = {}) {
  const { lookback = 3, tolerance = 0.015, count = 2 } = options;
  if (!candles || candles.length < 40) return null;

  const current = candles[candles.length - 1].close;
  const candidates = [];

  // 來源一：擺盪高低點
  for (const pivot of findSwingPivots(candles, lookback)) {
    candidates.push({ price: pivot.price, source: 'swing', date: pivot.date });
  }

  // 來源二：成交量密集區，只取量能前六的價格帶，再多就變成把整張圖都標成支撐
  const profile = volumeProfile(candles);
  const topNodes = profile.slice(0, 6);
  for (const node of topNodes) {
    candidates.push({ price: node.mid, source: 'volume' });
  }

  // 來源三：均線。只取目前有值的均線，資料不足時不硬湊。
  const closes = candles.map((c) => c.close);
  for (const period of [20, 60, 120]) {
    const line = sma(closes, period);
    const value = line[line.length - 1];
    if (value !== null) candidates.push({ price: value, source: 'ma' });
  }

  // 來源四：區間極值。這兩個價位在突破或跌破時特別關鍵。
  candidates.push({ price: Math.max(...candles.map((c) => c.high)), source: 'extreme' });
  candidates.push({ price: Math.min(...candles.map((c) => c.low)), source: 'extreme' });

  const clusters = clusterLevels(candidates, tolerance).map((cluster) => {
    const { touches, lastIndex } = countTouches(candles, cluster.price, tolerance);
    // 近期仍被觸及的價位比半年前的舊價位更有參考價值，給予遞增的時間權重。
    const recency = lastIndex < 0 ? 0 : lastIndex / (candles.length - 1);
    const sourceScore = cluster.sources.reduce((acc, s) => acc + (SOURCE_WEIGHT[s] ?? 1), 0);

    return {
      price: cluster.price,
      sources: cluster.sources,
      touches,
      lastTouchDate: lastIndex >= 0 ? candles[lastIndex].date : null,
      strength: sourceScore + Math.min(touches, 12) * 0.5 + recency * 3,
      distancePercent: ((cluster.price - current) / current) * 100,
    };
  });

  // 位於現價容許範圍之內的價位既非支撐也非壓力，歸類任一邊都會誤導。
  const band = current * tolerance;
  const supports = clusters
    .filter((c) => c.price < current - band)
    .sort((a, b) => b.price - a.price)
    .slice(0, count)
    .map((c, i) => ({ ...c, rank: i + 1, type: 'support' }));

  const resistances = clusters
    .filter((c) => c.price > current + band)
    .sort((a, b) => a.price - b.price)
    .slice(0, count)
    .map((c, i) => ({ ...c, rank: i + 1, type: 'resistance' }));

  return {
    price: current,
    supports,
    resistances,
    volumeNodes: topNodes.slice(0, 3),
  };
}

/** 來源代碼對應的中文說明，供介面顯示。 */
export const SOURCE_LABEL = {
  swing: '轉折點',
  volume: '量能密集',
  ma: '均線',
  extreme: '區間極值',
};
