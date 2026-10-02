/**
 * 個股體質評分。
 *
 * **完全不經過語言模型**，理由與 levels.js、risks.js、peers.js 相同：
 * 這是可逐項查核的算術，交給模型只會得到每次都不一樣、也無從驗證的分數。
 *
 * 三個設計前提，都與本站既有原則一致：
 *
 * 1. **分數必須可拆解。** 回傳的不只是總分，而是每個面向的得分、權重，
 *    以及觸發那個得分的**原始數值**。一個把十幾項壓成單一數字卻不能展開的分數，
 *    就是另一個黑箱——那正是這個專案一路在避開的東西。
 * 2. **燈號描述體質強弱，不是買賣建議。** 本站不給買賣指令（見 stance.js 的說明），
 *    這條規則同樣適用於燈號。「體質強健」與「現在該買」是兩件事。
 * 3. **缺資料不等於體質差。** 缺項不給零分，而是從分母裡移除，另外回報涵蓋率。
 *    ETF 沒有財報，把它的獲利能力算成零分是錯的；那是資料不適用，不是體質不好。
 *
 * 下面所有門檻都是本站自訂的校準值，不是什麼公認標準。集中在 RUBRIC 裡，
 * 要調整時不必翻動計分邏輯。
 */

import { sma } from './indicators.js';

/* ------------------------------------------------------------------ */
/* 計分工具                                                            */
/* ------------------------------------------------------------------ */

/**
 * 分段線性映射。
 *
 * 用插值而不是跳階，是為了避免門檻邊緣的劇烈跳動：ROE 從 9.9% 變成 10.1%
 * 不該讓總分跳好幾分，否則分數會隨著每季財報無意義地大幅震盪。
 *
 * @param {number} value
 * @param {[number, number][]} points 由小到大排列的 [輸入值, 得分]
 * @returns {number} 0 到 100
 */
export function interpolate(value, points) {
  if (!Number.isFinite(value)) return null;
  if (value <= points[0][0]) return points[0][1];
  const last = points[points.length - 1];
  if (value >= last[0]) return last[1];

  for (let i = 1; i < points.length; i += 1) {
    const [x1, y1] = points[i - 1];
    const [x2, y2] = points[i];
    if (value <= x2) {
      const ratio = x2 === x1 ? 0 : (value - x1) / (x2 - x1);
      return y1 + (y2 - y1) * ratio;
    }
  }
  return last[1];
}

/** 取平均，忽略 null。全部為 null 時回傳 null。 */
function average(values) {
  const valid = values.filter((v) => Number.isFinite(v));
  if (valid.length === 0) return null;
  return valid.reduce((a, b) => a + b, 0) / valid.length;
}

/** 加權平均，忽略 null。 */
function weightedAverage(pairs) {
  const valid = pairs.filter(([v]) => Number.isFinite(v));
  if (valid.length === 0) return null;
  const totalWeight = valid.reduce((acc, [, w]) => acc + w, 0);
  return valid.reduce((acc, [v, w]) => acc + v * w, 0) / totalWeight;
}

/* ------------------------------------------------------------------ */
/* 計分標準                                                            */
/* ------------------------------------------------------------------ */

/**
 * 各項的計分曲線。
 *
 * 全部是本站自訂的校準值。挑選原則是「讓台股多數標的落在中段」，
 * 而不是讓分數好看——一份人人都 90 分的評分表沒有鑑別力。
 */
export const RUBRIC = {
  /** 股東權益報酬率（%）。長期 15% 以上在台股屬於相當好的水準。 */
  roe: [
    [0, 0],
    [5, 30],
    [10, 55],
    [15, 75],
    [20, 90],
    [30, 100],
  ],
  /** 淨利率（%）。產業差異極大，因此權重不高，與 ROE、改善幅度一起平均。 */
  netMargin: [
    [0, 0],
    [3, 30],
    [8, 55],
    [15, 80],
    [25, 100],
  ],
  /** 淨利率相對去年同期的變化（百分點）。看的是獲利品質在改善還是惡化。 */
  marginTrend: [
    [-5, 0],
    [-2, 25],
    [0, 50],
    [3, 80],
    [8, 100],
  ],
  /** 月營收年增率（%）。 */
  revenueYoy: [
    [-20, 0],
    [-5, 30],
    [0, 40],
    [10, 60],
    [25, 80],
    [50, 100],
  ],
  /**
   * 負債比（%）。越低越好。
   *
   * **這一項對金融業會嚴重失真**：銀行與保險公司的負債比天然在 90% 以上，
   * 那是業務模式而不是財務風險。權重因此刻意壓到最低（10 分），
   * 介面也會註明。要正確處理得引入產業分類另立標準，成本與效益不成比例。
   */
  debtRatio: [
    [30, 100],
    [50, 70],
    [65, 45],
    [80, 20],
    [90, 0],
  ],
  /** 連續配發現金股利年數。 */
  dividendYears: [
    [0, 0],
    [1, 20],
    [3, 45],
    [5, 65],
    [10, 90],
    [15, 100],
  ],
  /**
   * 現金股利配發率（%）。
   *
   * 這是唯一「中間最好」的曲線，不能用單調映射：配太少代表股東拿不到，
   * 配超過 100% 代表配的比賺的多、動用保留盈餘，兩端都不是好事。
   */
  payoutRatio: [
    [0, 20],
    [20, 70],
    [30, 100],
    [70, 100],
    [90, 70],
    [120, 30],
    [150, 10],
  ],
  /** 120 日均線近 20 日的變化率（%）。長期趨勢的方向。 */
  ma120Slope: [
    [-5, 0],
    [-2, 25],
    [0, 45],
    [2, 65],
    [5, 85],
    [10, 100],
  ],
  /** 現價相對 120 日均線的乖離（%）。站上長期均線是趨勢健全的基本條件。 */
  ma120Bias: [
    [-30, 0],
    [-10, 35],
    [0, 60],
    [10, 80],
    [30, 100],
  ],
  /**
   * 本益比或股價淨值比的分位（%）。分位越低代表越便宜，得分越高。
   *
   * 注意這一項衡量的是「目前價格相對貴不貴」，與公司好不好是兩回事。
   * 它放在總分裡是因為「體質」包含「現在的價格有沒有把好處都反映完」。
   */
  cheapPercentile: [
    [0, 100],
    [20, 85],
    [50, 60],
    [80, 30],
    [100, 10],
  ],
  /** 殖利率分位（%）。方向與上面相反，分位越高代表相對便宜。 */
  yieldPercentile: [
    [0, 20],
    [20, 35],
    [50, 60],
    [80, 85],
    [100, 100],
  ],
};

/**
 * 六個面向與權重，合計 100。
 *
 * 權重分配刻意偏向「中長期體質」而非短線訊號：KD、MACD、RSI 這些完全不計入。
 * 那些指標回答的是「現在是什麼位置」，不是「這家公司好不好」，
 * 把它們放進體質分數會讓分數每天跳動，失去體質該有的穩定性。
 */
export const WEIGHTS = {
  profitability: 20,
  growth: 20,
  financial: 10,
  dividend: 10,
  trend: 20,
  valuation: 20,
};

/** 面向的顯示名稱與說明。 */
export const DIMENSIONS = [
  { key: 'profitability', label: '獲利能力', note: '股東權益報酬率、淨利率與其年變化' },
  { key: 'growth', label: '成長動能', note: '月營收年增率，近三月權重高於單月' },
  { key: 'financial', label: '財務結構', note: '負債比。金融業天然偏高，此項會失真' },
  { key: 'dividend', label: '股利政策', note: '連續配發年數與配發率是否落在合理區間' },
  { key: 'trend', label: '趨勢位置', note: '120 日均線方向與現價相對長期均線的位置' },
  { key: 'valuation', label: '估值水位', note: '自身歷史分位與同業分位，越便宜得分越高' },
];

/**
 * 燈號。**描述體質強弱，不是買賣建議。**
 *
 * 四級而不是三級：三級會讓絕大多數標的擠在中間那一格，失去鑑別力。
 */
export const LIGHTS = [
  { key: 'strong', label: '強健', min: 75 },
  { key: 'healthy', label: '健康', min: 60 },
  { key: 'fair', label: '普通', min: 45 },
  { key: 'weak', label: '偏弱', min: 0 },
];

/**
 * 涵蓋率低於此值就不給燈號。
 *
 * ETF 沒有財報，可評項目只剩趨勢與股利，涵蓋率約三成。用那樣的分數點一顆綠燈，
 * 讀起來像「這檔體質強健」，實際上只是「它的股價在長期均線之上」——
 * 那是誤導。分數與各項得分照樣顯示，但等級改為「資料不足」。
 */
export const MIN_COVERAGE = 50;

/* ------------------------------------------------------------------ */
/* 趨勢面輸入                                                          */
/* ------------------------------------------------------------------ */

/**
 * 從 K 線取出趨勢面評分需要的最小輸入。
 *
 * AI 頁走 buildAnalysisInput，它會一併算出十幾個指標；清單上只需要現價與
 * 120 日均線兩樣，為了一顆燈號跑整套指標是浪費。
 *
 * **公式必須與 buildAnalysisInput 完全相同**，否則同一檔在清單與 AI 頁會算出
 * 不同的分數——那正是這個專案一路在修的那種「兩頁數字對不上」。
 * 現價取最後一根收盤價，與 computeLevels 的 price 同源；均線斜率取近 20 日變化率。
 *
 * @param {object[]} candles
 * @returns {{ price: number|null, indicators: { ma120: number|null, ma120Slope: number|null } }}
 */
export function trendInputFromCandles(candles) {
  if (!Array.isArray(candles) || candles.length === 0) {
    return { price: null, indicators: { ma120: null, ma120Slope: null } };
  }

  const closes = candles.map((c) => c.close);
  const last = closes.length - 1;
  const series = sma(closes, 120);
  const ma120 = series[last];
  const prev = series[Math.max(0, last - 20)];

  return {
    price: closes[last] ?? null,
    indicators: {
      ma120,
      ma120Slope: ma120 !== null && prev ? ((ma120 - prev) / prev) * 100 : null,
    },
  };
}

/* ------------------------------------------------------------------ */
/* 主計算                                                              */
/* ------------------------------------------------------------------ */

/**
 * 計算體質評分。
 *
 * @param {object} params
 * @param {number|null} [params.price] 現價
 * @param {object|null} [params.indicators] buildAnalysisInput 的 indicators
 * @param {object|null} [params.fundamentals] /api/fundamentals 的完整回應
 * @param {object|null} [params.peers] /api/peers 的完整回應
 * @returns {object|null} 資料完全不足時回傳 null
 */
export function computeHealth({ price, indicators, fundamentals, peers }) {
  const f = fundamentals?.available ? fundamentals : null;
  const p = peers?.available ? peers : null;

  const scores = {
    profitability: scoreProfitability(f),
    growth: scoreGrowth(f),
    financial: scoreFinancial(f),
    dividend: scoreDividend(f),
    trend: scoreTrend(price, indicators),
    valuation: scoreValuation(f, p),
  };

  // 可評面向的權重合計占全部權重的比例。缺項從分母移除，不給零分。
  const totalWeight = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
  const scoredWeight = DIMENSIONS.reduce(
    (acc, d) => acc + (scores[d.key]?.score === null ? 0 : WEIGHTS[d.key]),
    0
  );
  if (scoredWeight === 0) return null;

  const total = weightedAverage(
    DIMENSIONS.map((d) => [scores[d.key]?.score ?? null, WEIGHTS[d.key]])
  );
  const coverage = (scoredWeight / totalWeight) * 100;

  return {
    // 總分為「可評面向的加權平均」，不是「得分除以滿分」。
    // 後者會讓缺資料的標的分數天生偏低，把資料不足誤讀成體質差。
    total: Math.round(total),
    coverage: Math.round(coverage),
    light: coverage < MIN_COVERAGE ? null : LIGHTS.find((l) => total >= l.min),
    dimensions: DIMENSIONS.map((d) => ({
      ...d,
      weight: WEIGHTS[d.key],
      score: scores[d.key]?.score === null ? null : Math.round(scores[d.key].score),
      // 觸發這個得分的原始數值，逐項列出供查核。
      details: scores[d.key]?.details ?? [],
      reason: scores[d.key]?.reason ?? null,
    })),
  };
}

/** 一個可查核的細項：名稱、原始數值字串、該細項得分。 */
function detail(label, value, score) {
  return { label, value, score: Number.isFinite(score) ? Math.round(score) : null };
}

/** 缺資料時的統一回傳，附上原因而不是只給 null。 */
function unavailable(reason) {
  return { score: null, details: [], reason };
}

function scoreProfitability(f) {
  if (!f) return unavailable('無財報資料');

  const roe = f.roe?.value ?? null;
  const net = f.income?.margins?.net ?? null;
  const netAgo = f.income?.marginsYearAgo?.net ?? null;
  const trend = Number.isFinite(net) && Number.isFinite(netAgo) ? net - netAgo : null;

  const parts = [
    detail(
      '股東權益報酬率',
      Number.isFinite(roe) ? `${roe.toFixed(1)}%` : '無資料',
      interpolate(roe, RUBRIC.roe)
    ),
    detail(
      '淨利率',
      Number.isFinite(net) ? `${net.toFixed(1)}%` : '無資料',
      interpolate(net, RUBRIC.netMargin)
    ),
    detail(
      '淨利率年變化',
      Number.isFinite(trend) ? `${trend > 0 ? '+' : ''}${trend.toFixed(1)} 個百分點` : '無資料',
      interpolate(trend, RUBRIC.marginTrend)
    ),
  ];

  const score = average(parts.map((d) => d.score));
  return score === null ? unavailable('財報缺少獲利欄位') : { score, details: parts };
}

function scoreGrowth(f) {
  if (!f) return unavailable('無財報資料');

  const yoy = f.revenue?.yoy ?? null;
  const yoy3m = f.revenue?.yoy3m ?? null;

  const parts = [
    detail(
      '單月營收年增',
      Number.isFinite(yoy) ? `${yoy > 0 ? '+' : ''}${yoy.toFixed(1)}%` : '無資料',
      interpolate(yoy, RUBRIC.revenueYoy)
    ),
    detail(
      '近三月營收年增',
      Number.isFinite(yoy3m) ? `${yoy3m > 0 ? '+' : ''}${yoy3m.toFixed(1)}%` : '無資料',
      interpolate(yoy3m, RUBRIC.revenueYoy)
    ),
  ];

  // 近三月權重較高：單月營收受出貨節奏影響，容易因為認列時點而大起大落。
  const score = weightedAverage([
    [parts[0].score, 0.4],
    [parts[1].score, 0.6],
  ]);
  return score === null ? unavailable('無月營收資料') : { score, details: parts };
}

function scoreFinancial(f) {
  if (!f) return unavailable('無財報資料');

  const debt = f.balance?.debtRatio ?? null;
  const parts = [
    detail(
      '負債比',
      Number.isFinite(debt) ? `${debt.toFixed(1)}%` : '無資料',
      interpolate(debt, RUBRIC.debtRatio)
    ),
  ];

  const score = average(parts.map((d) => d.score));
  return score === null ? unavailable('無資產負債表資料') : { score, details: parts };
}

function scoreDividend(f) {
  const d = f?.dividend ?? null;
  if (!d) return unavailable('無股利紀錄');

  const years = d.consecutiveCashYears ?? null;
  const payout = d.payoutRatio ?? null;

  const parts = [
    detail(
      '連續配發年數',
      Number.isFinite(years) ? `${years} 年` : '無資料',
      interpolate(years, RUBRIC.dividendYears)
    ),
    detail(
      '配發率',
      Number.isFinite(payout) ? `${payout.toFixed(0)}%` : '無資料',
      interpolate(payout, RUBRIC.payoutRatio)
    ),
  ];

  const score = average(parts.map((d2) => d2.score));
  return score === null ? unavailable('股利紀錄不足') : { score, details: parts };
}

function scoreTrend(price, indicators) {
  const ma120 = indicators?.ma120 ?? null;
  const slope = indicators?.ma120Slope ?? null;
  const bias =
    Number.isFinite(price) && Number.isFinite(ma120) && ma120 > 0
      ? ((price - ma120) / ma120) * 100
      : null;

  const parts = [
    detail(
      '120 日均線方向',
      Number.isFinite(slope) ? `近 20 日 ${slope > 0 ? '+' : ''}${slope.toFixed(2)}%` : '無資料',
      interpolate(slope, RUBRIC.ma120Slope)
    ),
    detail(
      '現價相對 120 日均線',
      Number.isFinite(bias) ? `${bias > 0 ? '+' : ''}${bias.toFixed(1)}%` : '無資料',
      interpolate(bias, RUBRIC.ma120Bias)
    ),
  ];

  const score = average(parts.map((d) => d.score));
  // 歷史股價不足 120 個交易日時算不出長期均線，那是資料長度問題，不是體質問題。
  return score === null ? unavailable('歷史股價不足 120 個交易日') : { score, details: parts };
}

function scoreValuation(f, p) {
  const parts = [];

  const pe = f?.bands?.pe;
  if (pe && Number.isFinite(pe.percentile)) {
    parts.push(
      detail(
        '本益比歷史分位',
        `${pe.percentile.toFixed(1)}%`,
        interpolate(pe.percentile, RUBRIC.cheapPercentile)
      )
    );
  }
  const dy = f?.bands?.dividendYield;
  if (dy && Number.isFinite(dy.percentile)) {
    parts.push(
      detail(
        '殖利率歷史分位',
        `${dy.percentile.toFixed(1)}%`,
        interpolate(dy.percentile, RUBRIC.yieldPercentile)
      )
    );
  }
  // 同業分位只在樣本足夠時採用。家數太少時中位數幾乎等於任一檔的值，沒有資訊量。
  const peerPe = p?.sufficient ? p.metrics?.pe : null;
  if (peerPe && Number.isFinite(peerPe.percentile)) {
    parts.push(
      detail(
        '本益比同業分位',
        `${peerPe.percentile.toFixed(1)}%（${p.industry}，${peerPe.samples} 家）`,
        interpolate(peerPe.percentile, RUBRIC.cheapPercentile)
      )
    );
  }

  if (parts.length === 0) return unavailable('無估值分位資料（ETF 屬正常情形）');
  return { score: average(parts.map((d) => d.score)), details: parts };
}
