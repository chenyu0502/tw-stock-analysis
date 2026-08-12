/**
 * 所有資料端點的實作。
 *
 * 每個 handler 都是純函式：接收 query 物件，回傳 { status, body }。
 * 開發時由 Vite middleware 呼叫，正式環境由 Vercel serverless function 呼叫，
 * 兩邊共用同一份程式碼，不會出現行為分歧。
 *
 * 單位慣例：對外一律以「張」為股票數量單位（1 張 = 1000 股）。
 * 上游來源單位不一致（證交所法人資料為股、融資融券為張、櫃買兩者皆有），
 * 統一在這一層換算完畢，前端不需要再處理單位問題。
 */

import { fetchJson, toNumber } from './http.js';
import { withCache, TTL } from './cache.js';

const TWSE_OPENAPI = 'https://openapi.twse.com.tw/v1';
const TWSE_RWD = 'https://www.twse.com.tw/rwd/zh';
const TPEX_OPENAPI = 'https://www.tpex.org.tw/openapi/v1';
const TWSE_MIS = 'https://mis.twse.com.tw/stock/api/getStockInfo.jsp';
const YAHOO_CHART = 'https://query1.finance.yahoo.com/v8/finance/chart';
const FINMIND = 'https://api.finmindtrade.com/api/v4/data';

/** 一張等於一千股。 */
const SHARES_PER_LOT = 1000;

/**
 * 從物件中找出第一個鍵名符合 pattern 的值。
 *
 * 上游的欄位名稱極不穩定：證交所融資融券用中文鍵名，櫃買中心的三大法人
 * 鍵名帶有多餘空格（例如 " Foreign Investors ... -Total Sell"），
 * 寫死鍵名會在上游微調時整段壞掉，改用樣式比對。
 * @param {object} row
 * @param {RegExp} pattern
 * @returns {*}
 */
function pickKey(row, pattern) {
  if (!row) return undefined;
  const key = Object.keys(row).find((k) => pattern.test(k.trim()));
  return key === undefined ? undefined : row[key];
}

/**
 * 產生今日往前數天的日期字串（YYYYMMDD），用於逐日回溯尋找最近交易日。
 * @param {number} count
 * @returns {string[]}
 */
function recentDates(count) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const d = new Date(Date.now() - i * 86400000);
    out.push(
      `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
    );
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 股票代號名稱對照表                                                   */
/* ------------------------------------------------------------------ */

/**
 * 建立上市加上櫃的代號對照表。
 * @returns {Promise<Record<string, { code: string, name: string, market: 'TSE'|'OTC' }>>}
 */
async function loadUniverse() {
  return withCache('universe', TTL.UNIVERSE, async () => {
    const map = {};

    // 上市：STOCK_DAY_ALL 每個交易日更新，含全部上市個股代號與名稱。
    try {
      const listed = await fetchJson(`${TWSE_OPENAPI}/exchangeReport/STOCK_DAY_ALL`);
      for (const row of listed ?? []) {
        const code = String(row.Code ?? '').trim();
        const name = String(row.Name ?? '').trim();
        if (code) map[code] = { code, name, market: 'TSE' };
      }
    } catch {
      // 上市清單取用失敗不應讓整個對照表失效，繼續嘗試上櫃。
    }

    // 上櫃：櫃買中心 OpenAPI，欄位名稱與證交所完全不同。
    try {
      const otc = await fetchJson(`${TPEX_OPENAPI}/tpex_mainboard_quotes`);
      for (const row of otc ?? []) {
        const code = String(row.SecuritiesCompanyCode ?? '').trim();
        const name = String(row.CompanyName ?? '').trim();
        if (code && !map[code]) map[code] = { code, name, market: 'OTC' };
      }
    } catch {
      // 同上，允許只有上市資料。
    }

    return map;
  });
}

/**
 * 查出個股屬於上市或上櫃。查不到時預設上市，由呼叫端自行處理後備。
 * @param {string} code
 * @returns {Promise<'TSE'|'OTC'>}
 */
async function resolveMarket(code) {
  const universe = await loadUniverse();
  return universe[code]?.market ?? 'TSE';
}

/**
 * GET /api/universe
 * 回傳完整代號對照表，前端用於代號轉名稱與模糊搜尋。
 */
export async function universeHandler() {
  const universe = await loadUniverse();
  return {
    status: 200,
    body: { count: Object.keys(universe).length, items: Object.values(universe) },
  };
}

/* ------------------------------------------------------------------ */
/* 端點：即時報價                                                       */
/* ------------------------------------------------------------------ */

/**
 * GET /api/quote?codes=2330,2317
 *
 * 資料來源為證交所 MIS 即時系統。由於無從得知代號屬於上市或上櫃，
 * 對兩種通道都送出查詢，MIS 只會回傳存在的通道，不會報錯。
 */
export async function quoteHandler(query) {
  const codes = String(query.codes ?? '')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);

  if (codes.length === 0) return { status: 400, body: { error: '缺少 codes 參數' } };
  if (codes.length > 50) return { status: 400, body: { error: '單次查詢上限 50 檔' } };

  const cacheKey = `quote:${codes.slice().sort().join(',')}`;
  const body = await withCache(cacheKey, TTL.QUOTE, async () => {
    const channels = codes.flatMap((c) => [`tse_${c}.tw`, `otc_${c}.tw`]).join('|');
    const url = `${TWSE_MIS}?json=1&delay=0&ex_ch=${encodeURIComponent(channels)}&_=${Date.now()}`;

    const json = await fetchJson(url, {
      headers: { Referer: 'https://mis.twse.com.tw/stock/index.jsp' },
    });

    const quotes = {};
    for (const row of json?.msgArray ?? []) {
      const code = row.c;
      if (!code) continue;

      const prevClose = toNumber(row.y);
      // z 為最新成交價，無成交時為 "-"，退而使用最佳委買價，再退用昨收。
      const bestBid = toNumber(String(row.b ?? '').split('_')[0]);
      const price = toNumber(row.z) ?? bestBid ?? prevClose;
      const change = price !== null && prevClose !== null ? price - prevClose : null;

      quotes[code] = {
        code,
        name: row.n ?? '',
        fullName: row.nf ?? '',
        market: row.ex === 'otc' ? 'OTC' : 'TSE',
        price,
        prevClose,
        open: toNumber(row.o),
        high: toNumber(row.h),
        low: toNumber(row.l),
        // MIS 的 v 是累積成交量，單位已是張。
        volume: toNumber(row.v),
        limitUp: toNumber(row.u),
        limitDown: toNumber(row.w),
        change,
        changePercent: change !== null && prevClose ? (change / prevClose) * 100 : null,
        tradeDate: row.d ?? null,
        tradeTime: row.t ?? null,
      };
    }

    return {
      quotes,
      missing: codes.filter((c) => !quotes[c]),
      fetchedAt: new Date().toISOString(),
    };
  });

  return { status: 200, body };
}

/* ------------------------------------------------------------------ */
/* 端點：歷史 K 線                                                      */
/* ------------------------------------------------------------------ */

/**
 * GET /api/history?code=2330&range=1y&interval=1d
 *
 * 資料來源 Yahoo Finance。台股代號需加市場後綴：上市 .TW、上櫃 .TWO。
 * 對照表查不到時，兩種後綴依序嘗試。
 */
export async function historyHandler(query) {
  const code = String(query.code ?? '').trim();
  const range = String(query.range ?? '1y');
  const interval = String(query.interval ?? '1d');

  if (!/^\d{4,6}[A-Z]?$/.test(code)) {
    return { status: 400, body: { error: '代號格式不正確' } };
  }
  if (!['1d', '1wk', '1mo'].includes(interval)) {
    return { status: 400, body: { error: 'interval 僅支援 1d / 1wk / 1mo' } };
  }
  if (!['1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'max'].includes(range)) {
    return { status: 400, body: { error: 'range 參數不在允許清單' } };
  }

  const cacheKey = `history:${code}:${range}:${interval}`;
  const body = await withCache(cacheKey, TTL.HISTORY, async () => {
    const market = await resolveMarket(code);
    // 依對照表結果決定優先順序，查不到時仍會嘗試另一種後綴。
    const suffixes = market === 'OTC' ? ['.TWO', '.TW'] : ['.TW', '.TWO'];

    let lastError;
    for (const suffix of suffixes) {
      try {
        const url = `${YAHOO_CHART}/${code}${suffix}?interval=${interval}&range=${range}`;
        const json = await fetchJson(url);
        const result = json?.chart?.result?.[0];
        if (!result?.timestamp?.length) {
          lastError = new Error('無資料');
          continue;
        }

        const q = result.indicators.quote[0];
        const candles = result.timestamp
          .map((ts, i) => ({
            date: new Date(ts * 1000).toISOString().slice(0, 10),
            open: q.open?.[i] ?? null,
            high: q.high?.[i] ?? null,
            low: q.low?.[i] ?? null,
            close: q.close?.[i] ?? null,
            // Yahoo 的成交量單位是股，換算為張與報價端點一致。
            volume: q.volume?.[i] == null ? null : q.volume[i] / SHARES_PER_LOT,
          }))
          // Yahoo 會夾帶收盤價為 null 的空列（停牌或資料缺漏），保留會讓指標計算出錯。
          .filter((c) => c.close !== null);

        return {
          code,
          symbol: `${code}${suffix}`,
          market: suffix === '.TWO' ? 'OTC' : 'TSE',
          currency: result.meta?.currency ?? 'TWD',
          candles,
          fetchedAt: new Date().toISOString(),
        };
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError ?? new Error('查無歷史資料');
  });

  return { status: 200, body };
}

/* ------------------------------------------------------------------ */
/* 端點：融資融券                                                       */
/* ------------------------------------------------------------------ */

/**
 * 建立單一標的的融資融券資料結構。
 * @param {object} base 代號、名稱、日期
 * @param {number|null} marginBalance 融資今日餘額（張）
 * @param {number|null} marginPrev 融資前日餘額（張）
 * @param {number|null} shortBalance 融券今日餘額（張）
 * @param {number|null} shortPrev 融券前日餘額（張）
 */
function buildMarginRow(base, marginBalance, marginPrev, shortBalance, shortPrev) {
  return {
    ...base,
    marginBalance,
    marginPrevBalance: marginPrev,
    marginChange:
      marginBalance !== null && marginPrev !== null ? marginBalance - marginPrev : null,
    marginChangePercent:
      marginBalance !== null && marginPrev ? ((marginBalance - marginPrev) / marginPrev) * 100 : null,
    shortBalance,
    shortPrevBalance: shortPrev,
    shortChange: shortBalance !== null && shortPrev !== null ? shortBalance - shortPrev : null,
    shortChangePercent:
      shortBalance !== null && shortPrev ? ((shortBalance - shortPrev) / shortPrev) * 100 : null,
    // 券資比反映軋空壓力，融資餘額為零時無意義。
    shortMarginRatio:
      shortBalance !== null && marginBalance ? (shortBalance / marginBalance) * 100 : null,
  };
}

/**
 * GET /api/margin?codes=2330,6488
 *
 * 上市取證交所 MI_MARGN（中文欄位名），上櫃取櫃買中心 margin_balance（英文欄位名）。
 * 兩邊都是一次回傳全市場，整包快取後依代號過濾，比逐檔查詢有效率。單位為張。
 */
export async function marginHandler(query) {
  const codes = String(query.codes ?? '')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);

  const all = await withCache('margin:all', TTL.DAILY, async () => {
    const map = {};

    // 上市。證交所此端點使用中文欄位名稱。
    try {
      const rows = await fetchJson(`${TWSE_OPENAPI}/exchangeReport/MI_MARGN`);
      for (const row of rows ?? []) {
        const code = String(pickKey(row, /^股票代號$/) ?? '').trim();
        if (!code) continue;
        map[code] = buildMarginRow(
          {
            code,
            name: String(pickKey(row, /^股票名稱$/) ?? '').trim(),
            market: 'TSE',
            date: String(pickKey(row, /^日期$|^Date$/i) ?? ''),
          },
          toNumber(pickKey(row, /^融資今日餘額$/)),
          toNumber(pickKey(row, /^融資前日餘額$/)),
          toNumber(pickKey(row, /^融券今日餘額$/)),
          toNumber(pickKey(row, /^融券前日餘額$/))
        );
      }
    } catch {
      // 單一市場失敗不影響另一市場。
    }

    // 上櫃。
    try {
      const rows = await fetchJson(`${TPEX_OPENAPI}/tpex_mainboard_margin_balance`);
      for (const row of rows ?? []) {
        const code = String(row.SecuritiesCompanyCode ?? '').trim();
        if (!code || map[code]) continue;
        map[code] = buildMarginRow(
          {
            code,
            name: String(row.CompanyName ?? '').trim(),
            market: 'OTC',
            date: String(row.Date ?? ''),
          },
          toNumber(row.MarginPurchaseBalance),
          toNumber(row.MarginPurchaseBalancePreviousDay),
          toNumber(row.ShortSaleBalance),
          toNumber(row.ShortSaleBalancePreviousDay)
        );
      }
    } catch {
      // 同上。
    }

    return map;
  });

  const picked = codes.length ? Object.fromEntries(codes.map((c) => [c, all[c] ?? null])) : all;
  return { status: 200, body: { items: picked, fetchedAt: new Date().toISOString() } };
}

/* ------------------------------------------------------------------ */
/* 端點：三大法人買賣超                                                  */
/* ------------------------------------------------------------------ */

/**
 * 取得上市三大法人買賣超。
 *
 * 證交所 OpenAPI 並未提供 T86，只能改用官網的 rwd 端點，它需要指定日期，
 * 且假日與尚未收盤時會回傳空資料，因此逐日往前回溯到最近一個有資料的交易日。
 * 回傳格式是 { fields, data } 的欄位陣列，需依欄位名稱找出索引再對應。
 * 原始單位為股。
 * @returns {Promise<Record<string, object>>}
 */
async function loadListedInstitutional() {
  for (const date of recentDates(8)) {
    let json;
    try {
      json = await fetchJson(
        `${TWSE_RWD}/fund/T86?date=${date}&selectType=ALL&response=json`,
        { headers: { Referer: 'https://www.twse.com.tw/zh/trading/foreign/t86.html' } }
      );
    } catch {
      continue;
    }
    if (json?.stat !== 'OK' || !Array.isArray(json.data) || json.data.length === 0) continue;

    const fields = json.fields ?? [];
    const indexOf = (pattern) => fields.findIndex((f) => pattern.test(String(f)));

    const iCode = indexOf(/證券代號/);
    const iName = indexOf(/證券名稱/);
    const iForeignMain = indexOf(/^外陸資買賣超股數/);
    const iForeignDealer = indexOf(/^外資自營商買賣超股數/);
    const iTrust = indexOf(/^投信買賣超股數/);
    const iDealer = indexOf(/^自營商買賣超股數$/);
    const iTotal = indexOf(/^三大法人買賣超股數/);

    const map = {};
    for (const row of json.data) {
      const code = String(row[iCode] ?? '').trim();
      if (!code) continue;

      // 市場慣稱的「外資」是外陸資與外資自營商的合計。
      const foreign = (toNumber(row[iForeignMain]) ?? 0) + (toNumber(row[iForeignDealer]) ?? 0);
      const trust = toNumber(row[iTrust]) ?? 0;
      const dealer = toNumber(row[iDealer]) ?? 0;
      const total = toNumber(row[iTotal]);

      map[code] = {
        code,
        name: String(row[iName] ?? '').trim(),
        market: 'TSE',
        date: json.date ?? date,
        foreign: foreign / SHARES_PER_LOT,
        trust: trust / SHARES_PER_LOT,
        dealer: dealer / SHARES_PER_LOT,
        total: (total ?? foreign + trust + dealer) / SHARES_PER_LOT,
      };
    }
    if (Object.keys(map).length > 0) return map;
  }
  return {};
}

/**
 * 取得上櫃三大法人買賣超。
 *
 * 櫃買中心 OpenAPI 的欄位名稱含有不規則空格，只能用樣式比對。原始單位為股。
 * @returns {Promise<Record<string, object>>}
 */
async function loadOtcInstitutional() {
  const rows = await fetchJson(`${TPEX_OPENAPI}/tpex_3insti_daily_trading`);
  const map = {};
  for (const row of rows ?? []) {
    const code = String(row.SecuritiesCompanyCode ?? '').trim();
    if (!code) continue;

    // 「ForeignInvestorsIncludeMainlandAreaInvestors-Difference」已是含外資自營商的合計，
    // 優先採用，缺漏時才用不含外資自營商的欄位加上外資自營商欄位。
    const foreignAll = toNumber(pickKey(row, /^ForeignInvestorsInclude\s*MainlandAreaInvestors-Difference$/i));
    const foreignExcl = toNumber(pickKey(row, /Foreign Investors.*Dealers excluded\)-Difference$/i)) ?? 0;
    const foreignDealer = toNumber(pickKey(row, /^ForeignDealers-Difference$/i)) ?? 0;
    const foreign = foreignAll ?? foreignExcl + foreignDealer;

    const trust = toNumber(pickKey(row, /^SecuritiesInvestmentTrustCompanies-Difference$/i)) ?? 0;
    const dealer = toNumber(pickKey(row, /^Dealers-Difference$/i)) ?? 0;
    const total = toNumber(pickKey(row, /^TotalDifference$/i));

    map[code] = {
      code,
      name: String(row.CompanyName ?? '').trim(),
      market: 'OTC',
      date: String(row.Date ?? ''),
      foreign: foreign / SHARES_PER_LOT,
      trust: trust / SHARES_PER_LOT,
      dealer: dealer / SHARES_PER_LOT,
      total: (total ?? foreign + trust + dealer) / SHARES_PER_LOT,
    };
  }
  return map;
}

/**
 * GET /api/institutional?codes=2330[&days=30]
 *
 * 預設回傳當日買賣超（免費、免 token）。
 * 帶入 days 且伺服器設有 FINMIND_TOKEN 時，改抓 FinMind 取得歷史連買連賣序列。
 * 單位為張。
 */
export async function institutionalHandler(query, env = {}) {
  const codes = String(query.codes ?? '')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
  const days = Number(query.days ?? 0);

  if (days > 0 && env.FINMIND_TOKEN && codes.length === 1) {
    return institutionalHistory(codes[0], days, env.FINMIND_TOKEN);
  }

  const all = await withCache('institutional:all', TTL.DAILY, async () => {
    // 兩個市場互不相依，並行取用；任一失敗不影響另一邊。
    const [listed, otc] = await Promise.allSettled([
      loadListedInstitutional(),
      loadOtcInstitutional(),
    ]);
    return {
      ...(otc.status === 'fulfilled' ? otc.value : {}),
      ...(listed.status === 'fulfilled' ? listed.value : {}),
    };
  });

  const picked = codes.length ? Object.fromEntries(codes.map((c) => [c, all[c] ?? null])) : all;
  return {
    status: 200,
    body: { source: 'TWSE/TPEx', items: picked, fetchedAt: new Date().toISOString() },
  };
}

/**
 * 透過 FinMind 取得單檔的法人買賣超歷史。單位換算為張。
 * @param {string} code
 * @param {number} days
 * @param {string} token
 */
async function institutionalHistory(code, days, token) {
  const start = new Date(Date.now() - days * 86400 * 1000).toISOString().slice(0, 10);
  const url =
    `${FINMIND}?dataset=TaiwanStockInstitutionalInvestorsBuySell` +
    `&data_id=${encodeURIComponent(code)}&start_date=${start}&token=${encodeURIComponent(token)}`;

  const json = await fetchJson(url);
  if (json?.status !== 200) {
    return { status: 502, body: { error: `FinMind 回應：${json?.msg ?? '未知錯誤'}` } };
  }

  // FinMind 是每個法人別一列，需依日期彙整成單列。
  const byDate = {};
  for (const row of json.data ?? []) {
    const d = row.date;
    byDate[d] ??= { date: d, foreign: 0, trust: 0, dealer: 0, total: 0 };
    const net = ((row.buy ?? 0) - (row.sell ?? 0)) / SHARES_PER_LOT;
    const type = String(row.name ?? '');
    if (/Foreign/i.test(type)) byDate[d].foreign += net;
    else if (/Investment_Trust/i.test(type)) byDate[d].trust += net;
    else if (/Dealer/i.test(type)) byDate[d].dealer += net;
    byDate[d].total += net;
  }

  return {
    status: 200,
    body: {
      source: 'FinMind',
      code,
      series: Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date)),
      fetchedAt: new Date().toISOString(),
    },
  };
}

/* ------------------------------------------------------------------ */
/* 端點：估值指標                                                       */
/* ------------------------------------------------------------------ */

/**
 * GET /api/valuation?codes=2330,6488
 *
 * 上市取證交所 BWIBBU_ALL，上櫃取櫃買中心 peratio_analysis，
 * 兩者皆免費且免 token，比參考站另接第三方服務穩定。
 */
export async function valuationHandler(query) {
  const codes = String(query.codes ?? '')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);

  const all = await withCache('valuation:all', TTL.DAILY, async () => {
    const map = {};

    try {
      const rows = await fetchJson(`${TWSE_OPENAPI}/exchangeReport/BWIBBU_ALL`);
      for (const row of rows ?? []) {
        const code = String(row.Code ?? '').trim();
        if (!code) continue;
        map[code] = {
          code,
          name: String(row.Name ?? '').trim(),
          market: 'TSE',
          peRatio: toNumber(row.PEratio),
          pbRatio: toNumber(row.PBratio),
          dividendYield: toNumber(row.DividendYield),
          dividendPerShare: null,
        };
      }
    } catch {
      // 允許只有其中一個市場的資料。
    }

    try {
      const rows = await fetchJson(`${TPEX_OPENAPI}/tpex_mainboard_peratio_analysis`);
      for (const row of rows ?? []) {
        const code = String(row.SecuritiesCompanyCode ?? '').trim();
        if (!code || map[code]) continue;
        map[code] = {
          code,
          name: String(row.CompanyName ?? '').trim(),
          market: 'OTC',
          peRatio: toNumber(row.PriceEarningRatio),
          pbRatio: toNumber(row.PriceBookRatio),
          dividendYield: toNumber(row.YieldRatio),
          dividendPerShare: toNumber(row.DividendPerShare),
        };
      }
    } catch {
      // 同上。
    }

    return map;
  });

  const picked = codes.length ? Object.fromEntries(codes.map((c) => [c, all[c] ?? null])) : all;
  return { status: 200, body: { items: picked, fetchedAt: new Date().toISOString() } };
}

/* ------------------------------------------------------------------ */
/* 路由表                                                              */
/* ------------------------------------------------------------------ */

/** 端點名稱對應到 handler，供 Vite dev middleware 與 Vercel function 共用。 */
export const routes = {
  quote: quoteHandler,
  history: historyHandler,
  margin: marginHandler,
  institutional: institutionalHandler,
  valuation: valuationHandler,
  universe: universeHandler,
};
