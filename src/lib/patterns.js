/**
 * 價格型態判定。
 *
 * **不經過語言模型。** 型態由擺盪轉折點的相對位置推得，每一個結論都附上
 * 構成它的實際轉折點與日期，使用者可以自己在圖上核對，也可以不同意。
 *
 * 交給模型判型態的問題不只是慢與貴：模型會為了回答而硬套一個名稱，
 * 而且同一份資料每次跑可能給出不同答案，無從查核。
 *
 * **型態判讀本質上主觀，誤判率高。** 因此這裡刻意保守：
 * 條件不明確就回傳「型態未明」，不硬湊。一個誠實的「看不出來」
 * 比一個似是而非的「頭肩頂」有用得多。
 */

import { findSwingPivots } from './levels.js';

/**
 * 判定門檻。集中於此，調整時不必翻遍整個檔案。
 *
 * 這些數字決定了「多接近算相同高度」「差多少算更高」，
 * 放寬會讓型態變多但誤判也變多，收緊則多數標的都會是「型態未明」。
 */
export const PATTERN_THRESHOLDS = {
  /** 兩個轉折點價格相差在此比例內視為同一水平（%） */
  samePricePercent: 3,
  /** 頭部要高出肩部多少才算「頭」（%） */
  headProminencePercent: 4,
  /** 通道或三角形要成立，相鄰轉折點至少要差這麼多（%），否則視為水平整理 */
  trendStepPercent: 2,
  /**
   * 至少要有幾個轉折點才判定。
   *
   * 三個就夠：雙重頂底正是「高、低、高」這樣的三點結構。
   * 設成四個會讓最典型的 W 底與 M 頭永遠判不出來。
   * 需要更多點的型態（通道、三角形要各兩個高低點）由各自的判定函式自行把關。
   */
  minPivots: 3,
  /** 只看最近這幾個轉折點。太久以前的型態已經不影響現在 */
  maxPivots: 6,
  /** 轉折點偵測的左右比較範圍 */
  pivotLookback: 4,
};

/** 兩個價格是否可視為同一水平。 */
function samePrice(a, b) {
  const base = (a + b) / 2;
  return base === 0 ? false : (Math.abs(a - b) / base) * 100 <= PATTERN_THRESHOLDS.samePricePercent;
}

/** b 相對 a 高出的百分比。 */
function gainPercent(a, b) {
  return a === 0 ? 0 : ((b - a) / a) * 100;
}

/** 產生描述用的「日期＋價格」字串。 */
function at(pivot) {
  return `${pivot.date} 的 ${pivot.price.toFixed(2)}`;
}

/**
 * 判定價格型態。
 *
 * 作法是取最近數個擺盪轉折點，看高點與低點各自的走向：
 *
 * ```
 * 高點抬高 ＋ 低點墊高  → 上升通道
 * 高點降低 ＋ 低點下移  → 下降通道
 * 高點降低 ＋ 低點墊高  → 收斂三角
 * 高點抬高 ＋ 低點下移  → 擴散喇叭
 * 高點齊平 ＋ 低點齊平  → 箱型整理
 * ```
 *
 * 雙重頂底與頭肩型態另外判定，因為它們看的是特定幾個點的相對高度，
 * 不是整體走向。
 *
 * @param {object[]} candles 需含 date、high、low
 * @returns {object|null} 資料不足時回傳 null
 */
export function detectPattern(candles) {
  if (!Array.isArray(candles) || candles.length < 40) return null;

  const all = findSwingPivots(candles, PATTERN_THRESHOLDS.pivotLookback);
  if (all.length < PATTERN_THRESHOLDS.minPivots) {
    return { name: '型態未明', evidence: '擺盪轉折點不足，無法判定型態', pivots: [] };
  }

  // 同一根 K 棒可能同時是高點與低點，依索引排序後只保留交替出現的序列，
  // 否則「高、高、低」這種連續同型會讓後面的比較失去意義。
  const ordered = [...all].sort((a, b) => a.index - b.index);
  const alternating = [];
  for (const p of ordered) {
    const prev = alternating[alternating.length - 1];
    if (!prev || prev.type !== p.type) {
      alternating.push(p);
    } else if (
      // 同型相鄰時保留較極端的那一個：高點取更高、低點取更低。
      (p.type === 'high' && p.price > prev.price) ||
      (p.type === 'low' && p.price < prev.price)
    ) {
      alternating[alternating.length - 1] = p;
    }
  }

  const pivots = alternating.slice(-PATTERN_THRESHOLDS.maxPivots);
  if (pivots.length < PATTERN_THRESHOLDS.minPivots) {
    return { name: '型態未明', evidence: '交替出現的轉折點不足，無法判定型態', pivots };
  }

  const highs = pivots.filter((p) => p.type === 'high');
  const lows = pivots.filter((p) => p.type === 'low');

  return (
    headAndShoulders(highs, lows, pivots) ??
    doubleTopBottom(highs, lows, pivots) ??
    channelOrTriangle(highs, lows, pivots) ?? {
      name: '型態未明',
      evidence: `近 ${pivots.length} 個轉折點未形成明確型態`,
      pivots,
    }
  );
}

/**
 * 頭肩頂與頭肩底。
 *
 * 三個同向轉折點，中間那個明顯突出，兩側大致等高。
 * 兩側等高是關鍵條件——少了它，任何一個「中間比較高」的三點都會被誤判成頭肩。
 */
function headAndShoulders(highs, lows, pivots) {
  const check = (points, isTop) => {
    if (points.length < 3) return null;
    const [left, head, right] = points.slice(-3);
    if (!samePrice(left.price, right.price)) return null;

    const prominence = isTop
      ? Math.min(gainPercent(left.price, head.price), gainPercent(right.price, head.price))
      : Math.min(gainPercent(head.price, left.price), gainPercent(head.price, right.price));
    if (prominence < PATTERN_THRESHOLDS.headProminencePercent) return null;

    return {
      name: isTop ? '頭肩頂' : '頭肩底',
      evidence:
        `左肩 ${at(left)}、${isTop ? '頭部' : '頭部'} ${at(head)}、右肩 ${at(right)}；` +
        `兩肩高度相差在 ${PATTERN_THRESHOLDS.samePricePercent}% 內，` +
        `頭部${isTop ? '高出' : '低於'}肩部 ${prominence.toFixed(1)}%`,
      pivots: [left, head, right],
      // 頸線是型態的關鍵價位，但價位一律由 levels.js 計算，這裡只指出它在哪兩點之間。
      note: isTop ? '頸線位於兩肩之間的低點' : '頸線位於兩肩之間的高點',
    };
  };
  return check(highs, true) ?? check(lows, false);
}

/**
 * 雙重頂（M 頭）與雙重底（W 底）。
 *
 * 兩個等高的同向轉折點，中間隔著一個反向轉折點。
 * 中間那個點必須存在——沒有它就只是同一波的兩次觸及，不構成型態。
 */
function doubleTopBottom(highs, lows, pivots) {
  const check = (points, opposite, isTop) => {
    if (points.length < 2) return null;
    const [first, second] = points.slice(-2);
    if (!samePrice(first.price, second.price)) return null;

    const middle = opposite.find((p) => p.index > first.index && p.index < second.index);
    if (!middle) return null;

    const depth = isTop
      ? gainPercent(middle.price, first.price)
      : gainPercent(first.price, middle.price);
    // 中間的回檔太淺就只是盤整，不是雙重型態。
    if (depth < PATTERN_THRESHOLDS.headProminencePercent) return null;

    return {
      name: isTop ? '雙重頂（M 頭）' : '雙重底（W 底）',
      evidence:
        `兩個${isTop ? '高' : '低'}點 ${at(first)} 與 ${at(second)} 幾乎等高` +
        `（相差 ${Math.abs(gainPercent(first.price, second.price)).toFixed(1)}%），` +
        `中間的${isTop ? '低' : '高'}點在 ${at(middle)}`,
      pivots: [first, middle, second],
      note: isTop ? `跌破中間低點 ${middle.price.toFixed(2)} 才算型態成立` : `突破中間高點 ${middle.price.toFixed(2)} 才算型態成立`,
    };
  };
  return check(highs, lows, true) ?? check(lows, highs, false);
}

/**
 * 通道、三角與箱型。
 *
 * 由高點與低點各自的走向組合而成。走向以「最後一個相對第一個」判定，
 * 幅度不足門檻就視為齊平——否則任何微小的差距都會被讀成趨勢。
 */
function channelOrTriangle(highs, lows, pivots) {
  if (highs.length < 2 || lows.length < 2) return null;

  const step = PATTERN_THRESHOLDS.trendStepPercent;
  const highTrend = gainPercent(highs[0].price, highs[highs.length - 1].price);
  const lowTrend = gainPercent(lows[0].price, lows[lows.length - 1].price);

  const dir = (v) => (v > step ? 'up' : v < -step ? 'down' : 'flat');
  const h = dir(highTrend);
  const l = dir(lowTrend);

  const detail =
    `高點由 ${at(highs[0])} 到 ${at(highs[highs.length - 1])}（${highTrend >= 0 ? '+' : ''}${highTrend.toFixed(1)}%），` +
    `低點由 ${at(lows[0])} 到 ${at(lows[lows.length - 1])}（${lowTrend >= 0 ? '+' : ''}${lowTrend.toFixed(1)}%）`;

  const table = {
    'up|up': { name: '上升通道', note: '高點與低點同步墊高' },
    'down|down': { name: '下降通道', note: '高點與低點同步下移' },
    'down|up': { name: '收斂三角', note: '高點降低、低點墊高，區間收窄，方向待突破' },
    'up|down': { name: '擴散喇叭', note: '高點抬高、低點下移，波動放大' },
    'flat|flat': { name: '箱型整理', note: '高低點皆無明顯方向' },
  };
  const hit = table[`${h}|${l}`];
  if (!hit) return null;

  return { name: hit.name, evidence: detail, note: hit.note, pivots };
}
