/**
 * 基本面與估值的深度指標。
 *
 * **這個檔案完全不經過語言模型。** 本益比分位、營收年增、毛利率、ROE
 * 全都是可逐項驗證的算術，交給模型只會得到看似合理卻對不上的數字——
 * 與 levels.js 不讓模型產生價位是同一個理由。
 *
 * 資料來源為 FinMind，需伺服器設有 FINMIND_TOKEN。
 * 財報為**單季**數值（已實測：2026 Q2 營收等於四至六月的月營收加總），
 * 因此近四季相加即為 TTM，不需要再做累計數的相減。
 */

import { fetchJson } from './http.js';
import { withPartialCache, TTL } from './cache.js';

const FINMIND = 'https://api.finmindtrade.com/api/v4/data';

/** 各資料集要回溯的年數。財報與月營收需要跨年比較，故至少三年。 */
const YEARS = { per: 5, revenue: 3, statement: 3, balance: 3, dividend: 6 };

/* ------------------------------------------------------------------ */
/* 純計算                                                              */
/* ------------------------------------------------------------------ */

/**
 * 數值在一組樣本中的百分位。
 *
 * 定義為「樣本中有多少比例低於這個值」，因此 0 代表歷史最低、100 代表歷史最高。
 * 估值的意義幾乎完全來自這個相對位置：本益比 27 倍是貴是便宜，
 * 要看它在這檔自己的歷史區間裡落在哪裡，而不是跟其他股票比。
 *
 * @param {number[]} sorted 已由小到大排序的樣本
 * @param {number} value
 * @returns {number|null}
 */
export function percentileRank(sorted, value) {
  if (!sorted.length || !Number.isFinite(value)) return null;
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (sorted[mid] < value) low = mid + 1;
    else high = mid;
  }
  return (low / sorted.length) * 100;
}

/** 取排序後樣本的分位數值。 */
function quantile(sorted, ratio) {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * ratio));
  return sorted[index];
}

/**
 * 把一段時間序列整理成分位帶。
 *
 * @param {object[]} rows 含 date 與指定欄位的列
 * @param {string} key 欄位名稱
 * @returns {object|null}
 */
export function summarizeBand(rows, key) {
  const valid = rows.filter((r) => Number.isFinite(r[key]) && r[key] > 0);
  if (valid.length < 60) return null;

  const values = valid.map((r) => r[key]);
  const sorted = [...values].sort((a, b) => a - b);
  const current = values[values.length - 1];

  return {
    current,
    min: sorted[0],
    p25: quantile(sorted, 0.25),
    median: quantile(sorted, 0.5),
    p75: quantile(sorted, 0.75),
    max: sorted[sorted.length - 1],
    percentile: percentileRank(sorted, current),
    samples: sorted.length,
    from: valid[0].date,
    to: valid[valid.length - 1].date,
  };
}

/**
 * 月營收摘要。
 *
 * 年增率一律與去年同月比較，不看月增率——台股不少產業有明顯淡旺季，
 * 月增率會把季節性讀成成長或衰退。
 *
 * @param {object[]} rows FinMind TaiwanStockMonthRevenue
 * @returns {object|null}
 */
export function summarizeRevenue(rows) {
  const byMonth = new Map();
  for (const r of rows) {
    if (!Number.isFinite(r.revenue)) continue;
    byMonth.set(`${r.revenue_year}-${String(r.revenue_month).padStart(2, '0')}`, r.revenue);
  }
  const keys = [...byMonth.keys()].sort();
  if (keys.length === 0) return null;

  const latestKey = keys[keys.length - 1];
  const [year, month] = latestKey.split('-').map(Number);

  /** 取連續 n 個月的加總，往前數；資料缺任一個月就回傳 null。 */
  const sumBack = (endKey, n) => {
    const index = keys.indexOf(endKey);
    if (index < n - 1) return null;
    let total = 0;
    for (let i = index - n + 1; i <= index; i += 1) total += byMonth.get(keys[i]);
    return total;
  };

  const shiftYear = (key, back) => {
    const [y, m] = key.split('-').map(Number);
    return `${y - back}-${String(m).padStart(2, '0')}`;
  };

  const yoyOf = (n) => {
    const now = sumBack(latestKey, n);
    const prev = sumBack(shiftYear(latestKey, 1), n);
    return now !== null && prev ? ((now - prev) / prev) * 100 : null;
  };

  return {
    latestMonth: `${year}-${String(month).padStart(2, '0')}`,
    latestRevenue: byMonth.get(latestKey),
    yoy: yoyOf(1),
    yoy3m: yoyOf(3),
    yoy12m: yoyOf(12),
    // 近 12 個月的序列供介面畫走勢，長度固定才不會讓圖忽長忽短。
    recent: keys.slice(-12).map((k) => ({ month: k, revenue: byMonth.get(k) })),
  };
}

/**
 * 把財報列表整理成「每期一列」的表。
 * @param {object[]} rows FinMind 的 {date, type, value}
 * @returns {{date:string, values:Record<string, number>}[]} 依日期排序
 */
function pivotByDate(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!Number.isFinite(r.value)) continue;
    const entry = map.get(r.date) ?? { date: r.date, values: {} };
    entry.values[r.type] = r.value;
    map.set(r.date, entry);
  }
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 損益表摘要：TTM EPS 與三項利潤率。
 *
 * 利潤率取最近一季而非 TTM，因為要看的是「目前的獲利品質」；
 * 同時給出四季前的同一項數值，讓介面能顯示趨勢而不是只有一個孤立的數字。
 *
 * @param {object[]} rows FinMind TaiwanStockFinancialStatements
 * @returns {object|null}
 */
export function summarizeIncome(rows) {
  const quarters = pivotByDate(rows);
  if (quarters.length === 0) return null;

  const last = quarters[quarters.length - 1];
  const yearAgo = quarters.length >= 5 ? quarters[quarters.length - 5] : null;

  const marginsOf = (q) => {
    if (!q) return null;
    const revenue = q.values.Revenue;
    if (!revenue) return null;
    const ratio = (v) => (Number.isFinite(v) ? (v / revenue) * 100 : null);
    return {
      gross: ratio(q.values.GrossProfit),
      operating: ratio(q.values.OperatingIncome),
      net: ratio(q.values.IncomeAfterTaxes),
    };
  };

  // 財報是單季數，近四季相加即為 TTM。不足四季就不給值，避免與同業或歷史比較時失真。
  const lastFour = quarters.slice(-4);
  const sumOf = (key) =>
    lastFour.length === 4
      ? lastFour.reduce((acc, q) => acc + (q.values[key] ?? 0), 0)
      : null;

  return {
    latestQuarter: last.date,
    epsTtm: sumOf('EPS'),
    epsQuarter: last.values.EPS ?? null,
    epsQuarterYearAgo: yearAgo?.values.EPS ?? null,
    netIncomeTtm: sumOf('IncomeAfterTaxes'),
    revenueTtm: sumOf('Revenue'),
    margins: marginsOf(last),
    marginsYearAgo: marginsOf(yearAgo),
    quarters: quarters.length,
  };
}

/**
 * 資產負債表摘要。
 * @param {object[]} rows FinMind TaiwanStockBalanceSheet
 * @returns {object|null}
 */
export function summarizeBalance(rows) {
  const periods = pivotByDate(rows);
  if (periods.length === 0) return null;

  const last = periods[periods.length - 1];
  const equityOf = (p) =>
    p?.values.EquityAttributableToOwnersOfParent ?? p?.values.Equity ?? null;

  const assets = last.values.TotalAssets ?? null;
  const liabilities = last.values.Liabilities ?? null;

  return {
    period: last.date,
    totalAssets: assets,
    liabilities,
    equity: equityOf(last),
    equityYearAgo: periods.length >= 5 ? equityOf(periods[periods.length - 5]) : null,
    debtRatio: assets && liabilities !== null ? (liabilities / assets) * 100 : null,
  };
}

/**
 * 股東權益報酬率。
 *
 * 分母採期初與期末權益的平均。只用期末會在權益大幅變動的年度失真，
 * 例如現金增資後權益暴增，用期末算會把 ROE 壓低到看不出實際獲利能力。
 * 取不到一年前的權益時退回期末值，並以 averaged 標示，介面才能說明口徑。
 *
 * @param {object|null} income summarizeIncome 的結果
 * @param {object|null} balance summarizeBalance 的結果
 * @returns {{value:number, averaged:boolean}|null}
 */
export function computeRoe(income, balance) {
  const profit = income?.netIncomeTtm;
  const now = balance?.equity;
  if (!Number.isFinite(profit) || !now || now <= 0) return null;

  const before = balance.equityYearAgo;
  const base = Number.isFinite(before) && before > 0 ? (now + before) / 2 : now;
  return { value: (profit / base) * 100, averaged: Number.isFinite(before) && before > 0 };
}

/**
 * 股利摘要。
 *
 * FinMind 的 year 欄位是民國年，且可能帶季度（例如「114年第2季」），
 * 季配息的公司一年會有多筆，必須先依年度加總才能算年配息與配發率。
 *
 * @param {object[]} rows FinMind TaiwanStockDividend
 * @param {number|null} epsTtm
 * @returns {object|null}
 */
export function summarizeDividend(rows, epsTtm = null) {
  const byYear = new Map();
  for (const r of rows) {
    const rocYear = Number(String(r.year ?? '').match(/^(\d+)/)?.[1]);
    if (!rocYear) continue;
    const cash = Number(r.CashEarningsDistribution) || 0;
    const stock = Number(r.StockEarningsDistribution) || 0;
    const entry = byYear.get(rocYear) ?? { year: rocYear + 1911, cash: 0, stock: 0 };
    entry.cash += cash;
    entry.stock += stock;
    byYear.set(rocYear, entry);
  }

  const years = [...byYear.values()].sort((a, b) => a.year - b.year);
  if (years.length === 0) return null;

  // 連續配發年數由最近一年往回數，中斷即停止。
  let consecutive = 0;
  for (let i = years.length - 1; i >= 0; i -= 1) {
    if (years[i].cash > 0) consecutive += 1;
    else break;
  }

  const latest = years[years.length - 1];
  return {
    years: years.slice(-6),
    consecutiveCashYears: consecutive,
    latestYear: latest.year,
    latestCash: latest.cash,
    latestStock: latest.stock,
    // 配發率超過 100% 代表配的比賺的多，動用了保留盈餘，值得知道，因此不設上限。
    payoutRatio:
      Number.isFinite(epsTtm) && epsTtm > 0 ? (latest.cash / epsTtm) * 100 : null,
  };
}

/* ------------------------------------------------------------------ */
/* 端點                                                                */
/* ------------------------------------------------------------------ */

/** 取 n 年前的日期字串。 */
function yearsAgo(n) {
  const d = new Date();
  d.setFullYear(d.getFullYear() - n);
  return d.toISOString().slice(0, 10);
}

/**
 * 向 FinMind 取單一資料集。
 * @param {string} dataset
 * @param {string} code
 * @param {number} years
 * @param {string} token
 * @returns {Promise<object[]>}
 */
async function finmind(dataset, code, years, token) {
  const params = new URLSearchParams({
    dataset,
    data_id: code,
    start_date: yearsAgo(years),
  });
  // v4 以 Authorization 標頭認證。舊版的 token 查詢參數不是官方寫法，也會把金鑰寫進日誌。
  const json = await fetchJson(`${FINMIND}?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
    timeoutMs: 12000,
    retries: 1,
  });
  return Array.isArray(json?.data) ? json.data : [];
}

/**
 * GET /api/fundamentals?code=2330
 *
 * 回傳估值分位帶、月營收年增、利潤率、ROE、負債比與股利紀錄。
 * 全部由程式計算，不呼叫任何語言模型。
 *
 * @param {object} query
 * @param {object} env
 * @returns {Promise<{status:number, body:object}>}
 */
export async function fundamentalsHandler(query, env = {}) {
  const code = String(query.code ?? '').trim();
  if (!/^\d{4,6}[A-Z]?$/.test(code)) {
    return { status: 400, body: { error: '代號格式不正確' } };
  }
  if (!env.FINMIND_TOKEN) {
    return {
      status: 200,
      body: { available: false, code, reason: '伺服器未設定 FINMIND_TOKEN，無法取得基本面資料' },
    };
  }

  const body = await withPartialCache(`fundamentals:${code}`, TTL.FUNDAMENTAL, async () => {
    // 五個資料集互不相依，並行取用。任一失敗不應拖垮其他四項，因此用 allSettled。
    const [per, revenue, statement, balance, dividend] = await Promise.allSettled([
      finmind('TaiwanStockPER', code, YEARS.per, env.FINMIND_TOKEN),
      finmind('TaiwanStockMonthRevenue', code, YEARS.revenue, env.FINMIND_TOKEN),
      finmind('TaiwanStockFinancialStatements', code, YEARS.statement, env.FINMIND_TOKEN),
      finmind('TaiwanStockBalanceSheet', code, YEARS.balance, env.FINMIND_TOKEN),
      finmind('TaiwanStockDividend', code, YEARS.dividend, env.FINMIND_TOKEN),
    ]);
    const ok = (r) => (r.status === 'fulfilled' ? r.value : []);

    const perRows = ok(per);
    const income = summarizeIncome(ok(statement));
    const sheet = summarizeBalance(ok(balance));

    const value = {
      available: true,
      code,
      bands: {
        pe: summarizeBand(perRows, 'PER'),
        pb: summarizeBand(perRows, 'PBR'),
        dividendYield: summarizeBand(perRows, 'dividend_yield'),
      },
      revenue: summarizeRevenue(ok(revenue)),
      income,
      balance: sheet,
      roe: computeRoe(income, sheet),
      dividend: summarizeDividend(ok(dividend), income?.epsTtm ?? null),
      // ETF 沒有財報也沒有月營收，這不是錯誤，介面要據此顯示「不適用」而不是「載入失敗」。
      missing: [
        perRows.length === 0 && 'per',
        ok(revenue).length === 0 && 'revenue',
        ok(statement).length === 0 && 'statement',
        ok(balance).length === 0 && 'balance',
        ok(dividend).length === 0 && 'dividend',
      ].filter(Boolean),
      fetchedAt: new Date().toISOString(),
    };

    // 五個資料集全部落空多半是暫時性失敗，短快取讓下一次請求重試。
    const complete = value.missing.length < 5;
    return { value, complete };
  });

  return { status: 200, body };
}
