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
import { withCache, withPartialCache, TTL } from './cache.js';
import { analyzeHandler } from './analyze.js';

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
 * 只接受正數，零與負數視為無效資料回傳 null。
 *
 * 報價欄位在盤前或無成交時可能是 "0.0000"，直接當成價格會算出離譜的漲跌幅。
 * @param {number|null} value
 * @returns {number|null}
 */
function positiveOrNull(value) {
  return value !== null && value > 0 ? value : null;
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
  return withPartialCache('universe', TTL.UNIVERSE, async () => {
    const map = {};
    let listedOk = false;
    let otcOk = false;

    // 上市：STOCK_DAY_ALL 每個交易日更新，含全部上市個股代號與名稱。
    try {
      const listed = await fetchJson(`${TWSE_OPENAPI}/exchangeReport/STOCK_DAY_ALL`);
      for (const row of listed ?? []) {
        const code = String(row.Code ?? '').trim();
        const name = String(row.Name ?? '').trim();
        if (code) map[code] = { code, name, market: 'TSE' };
      }
      listedOk = true;
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
      otcOk = true;
    } catch {
      // 同上，允許只有上市資料。
    }

    return { value: map, complete: listedOk && otcOk };
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

      const prevClose = positiveOrNull(toNumber(row.y));
      // z 為最新成交價。無成交時 MIS 可能回傳 "-"，也可能回傳 "0.0000"，
      // 後者若直接採用會算出負百分之百的跌幅，因此零與負值一律視為無效。
      const bestBid = positiveOrNull(toNumber(String(row.b ?? '').split('_')[0]));
      const price = positiveOrNull(toNumber(row.z)) ?? bestBid ?? prevClose;
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
/* 除權息與官方收盤行情                                                 */
/* ------------------------------------------------------------------ */

/**
 * 民國日期轉西元 YYYY-MM-DD。
 *
 * 兩個上游的格式不同：證交所是「115年08月18日」，櫃買是「1150818」。
 * @param {string} value
 * @returns {string|null}
 */
function rocToIso(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  // 民國年可能是二位或三位數，從尾端切出月與日比較安全。
  if (digits.length < 6) return null;
  const day = digits.slice(-2);
  const month = digits.slice(-4, -2);
  const rocYear = Number(digits.slice(0, -4));
  if (!rocYear) return null;
  return `${rocYear + 1911}-${month}-${day}`;
}

/** YYYY-MM-DD → YYYYMMDD */
function isoToCompact(iso) {
  return iso.replace(/-/g, '');
}

/**
 * 取得近期的除權息資料，來源為證交所與櫃買中心。
 *
 * 為什麼不沿用 Yahoo 帶回的除權息事件：Yahoo 的事件表落後於價格。
 * 2026-08-18 有六檔 ETF 除息（00878、00891、00900、00944、00945B、00980A），
 * Yahoo 的收盤價當天就已經扣掉配息，事件表卻還沒有那一筆，
 * 結果是憑空多出一筆等於配息的虧損——以該日的部位計算是一萬六千餘元。
 * 證交所在除息當天就會公布，是這件事唯一可靠的來源。
 *
 * 證交所提供「除權息前收盤價」與「除權息參考價」，兩者相減就是當天要補回的金額。
 * 這個差額對現金股利等於每股配息，對股票股利則是參考價的調整幅度，
 * 用它做淨值還原在兩種情況下都成立（股票股利另有股數變動，需自行補交易紀錄）。
 *
 * @returns {Promise<Record<string, Record<string, number>>>} 代號 → 日期 → 每股還原金額
 */
async function loadExRights() {
  return withPartialCache('exrights', TTL.DAILY, async () => {
    const map = {};
    let twseOk = false;
    let tpexOk = false;

    /** 寫入時取較大值，避免同一天重複來源互相覆蓋成較小的金額。 */
    const put = (code, date, amount) => {
      if (!code || !date || !Number.isFinite(amount) || amount <= 0) return;
      map[code] ??= {};
      map[code][date] = Math.max(map[code][date] ?? 0, amount);
    };

    // 證交所：除權除息計算結果表。查詢區間往回一百二十天，足以涵蓋季配與月配。
    try {
      const end = new Date();
      const start = new Date(Date.now() - 120 * 86400000);
      const url =
        `${TWSE_RWD}/exRight/TWT49U?startDate=${isoToCompact(start.toISOString().slice(0, 10))}` +
        `&endDate=${isoToCompact(end.toISOString().slice(0, 10))}&response=json`;
      const json = await fetchJson(url);
      for (const row of json?.data ?? []) {
        // 欄位順序：資料日期、股票代號、股票名稱、除權息前收盤價、除權息參考價、權值+息值
        const before = toNumber(row[3]);
        const reference = toNumber(row[4]);
        const combined = toNumber(row[5]);
        // 前收減參考價是實際的價格調整幅度；取不到時退而用申報的權值加息值。
        const amount =
          before !== null && reference !== null ? before - reference : combined;
        put(String(row[1] ?? '').trim(), rocToIso(row[0]), amount);
      }
      twseOk = true;
    } catch {
      // 單一市場失敗不應讓另一個市場的資料一起消失。
    }

    // 櫃買中心：除權息預告與結果。此表沒有參考價，只能用申報的現金股利。
    try {
      const rows = await fetchJson(`${TPEX_OPENAPI}/tpex_exright_prepost`);
      for (const row of rows ?? []) {
        put(
          String(row.SecuritiesCompanyCode ?? '').trim(),
          rocToIso(row.ExRrightsExDividendDate),
          toNumber(row.CashDividend)
        );
      }
      tpexOk = true;
    } catch {
      // 同上。
    }

    return { value: map, complete: twseOk && tpexOk };
  });
}

/**
 * 從表格中依欄位名稱取出數值，找不到欄位回傳 null。
 * @param {string[]} fields
 * @param {string[]} row
 * @param {string} name
 * @returns {number|null}
 */
function cellByField(fields, row, name) {
  const index = fields.indexOf(name);
  return index === -1 ? null : toNumber(row[index]);
}

/**
 * 取得某一交易日的全市場官方行情。
 *
 * 存在的理由是 Yahoo 對台股 ETF 的日線不可靠，而且有兩種不同的壞法：
 *
 * 1. **缺值**：近一兩天的 close 是 null。跳過那天會讓該日損益變成零，
 *    隔天則同時承擔兩天的漲跌——總額沒錯，但逐日數字全部對不上。
 * 2. **錯值**：2026-08-17 的 00940，Yahoo 給 12.54，證交所是 12.46。
 *    這種錯誤不會自己浮現，只會讓當天與隔天的損益各錯一段。
 *
 * 因此近期的收盤價一律以證交所與櫃買的官方行情為準，不只是補缺值。
 *
 * @param {string} isoDate YYYY-MM-DD
 * @returns {Promise<Record<string, {open:number|null, high:number|null, low:number|null, close:number}>>}
 */
async function loadDailyQuotes(isoDate) {
  return withPartialCache(`dailyquotes:${isoDate}`, TTL.DAILY, async () => {
    const map = {};
    let twseOk = false;
    let tpexOk = false;

    // 證交所：每日收盤行情（全部）。回應分成多張表，取含「收盤價」欄位的那一張。
    try {
      const url = `${TWSE_RWD}/afterTrading/MI_INDEX?date=${isoToCompact(isoDate)}&type=ALL&response=json`;
      const json = await fetchJson(url);
      for (const table of json?.tables ?? []) {
        const fields = (table.fields ?? []).map((f) => String(f).trim());
        if (!fields.includes('收盤價')) continue;
        for (const row of table.data ?? []) {
          const code = String(row[0] ?? '').trim();
          const close = cellByField(fields, row, '收盤價');
          if (!code || close === null || close <= 0) continue;
          map[code] = {
            open: cellByField(fields, row, '開盤價'),
            high: cellByField(fields, row, '最高價'),
            low: cellByField(fields, row, '最低價'),
            close,
          };
        }
        break;
      }
      twseOk = true;
    } catch {
      // 同 loadExRights，允許只有單一市場。
    }

    // 櫃買中心：上櫃股票每日收盤行情。日期參數是西元的 YYYY/MM/DD，欄位名稱也不同。
    try {
      const url =
        `https://www.tpex.org.tw/www/zh-tw/afterTrading/otc` +
        `?date=${encodeURIComponent(isoDate.replace(/-/g, '/'))}&type=EW&id=&response=json`;
      const json = await fetchJson(url);
      for (const table of json?.tables ?? []) {
        const fields = (table.fields ?? []).map((f) => String(f).trim());
        if (!fields.includes('收盤')) continue;
        for (const row of table.data ?? []) {
          const code = String(row[0] ?? '').trim();
          const close = cellByField(fields, row, '收盤');
          if (!code || close === null || close <= 0 || map[code]) continue;
          map[code] = {
            open: cellByField(fields, row, '開盤'),
            high: cellByField(fields, row, '最高'),
            low: cellByField(fields, row, '最低'),
            close,
          };
        }
        break;
      }
      tpexOk = true;
    } catch {
      // 同上。
    }

    // 空結果不視為完整，讓盤中查詢當日資料的情形能在收盤後很快重試。
    return { value: map, complete: twseOk && tpexOk && Object.keys(map).length > 0 };
  });
}

/**
 * 以官方行情校正的交易日數。
 *
 * 只涵蓋最近幾天：對帳看的就是這幾天，而每多一天就要多打兩次上游，
 * 且每次回應都是全市場上千列。更早的資料 Yahoo 通常已經補正確。
 */
const OFFICIAL_CLOSE_DAYS = 6;

/* ------------------------------------------------------------------ */
/* 端點：歷史 K 線                                                      */
/* ------------------------------------------------------------------ */

/**
 * GET /api/history?code=2330&range=1y&interval=1d
 *
 * 資料來源 Yahoo Finance。台股代號需加市場後綴：上市 .TW、上櫃 .TWO。
 * 對照表查不到時，兩種後綴依序嘗試。
 *
 * 一併帶回除權息資料。收盤價是未還原的原始價格，除息當天會直接跌掉配息金額；
 * 績效計算若只看價差，那一天會憑空多出一筆等於配息的虧損。
 * 把配息金額交給前端，權益曲線才能在除息日補回這筆現金。
 *
 * 除權息以證交所與櫃買的官方資料為準——Yahoo 的事件表會落後於它自己的價格。
 * Yahoo 近期缺漏的收盤價也會用證交所的每日收盤行情補上。
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
        const url = `${YAHOO_CHART}/${code}${suffix}?interval=${interval}&range=${range}&events=div`;
        const json = await fetchJson(url);
        const result = json?.chart?.result?.[0];
        if (!result?.timestamp?.length) {
          lastError = new Error('無資料');
          continue;
        }

        const q = result.indicators.quote[0];
        const raw = result.timestamp.map((ts, i) => ({
          date: new Date(ts * 1000).toISOString().slice(0, 10),
          open: q.open?.[i] ?? null,
          high: q.high?.[i] ?? null,
          low: q.low?.[i] ?? null,
          close: q.close?.[i] ?? null,
          // Yahoo 的成交量單位是股，換算為張與報價端點一致。
          volume: q.volume?.[i] == null ? null : q.volume[i] / SHARES_PER_LOT,
        }));

        // 近幾個交易日改以證交所與櫃買的官方行情為準，Yahoo 只作為更早期資料的來源。
        // 這一步同時處理 Yahoo 的缺值與錯值，兩種情況都出現過。
        const recent = raw.slice(-OFFICIAL_CLOSE_DAYS);
        const officialQuotes = await Promise.all(recent.map((c) => loadDailyQuotes(c.date)));
        let corrected = 0;
        recent.forEach((candle, i) => {
          const row = officialQuotes[i][code];
          if (!row) return;
          // Yahoo 的價格是浮點數，直接比對會把 12.489999771 與 12.49 當成不同，
          // 這個計數只是給人看的，用半個最小跳動單位當容差。
          if (candle.close === null || Math.abs(candle.close - row.close) > 0.005) corrected += 1;
          candle.open = row.open ?? candle.open;
          candle.high = row.high ?? candle.high;
          candle.low = row.low ?? candle.low;
          candle.close = row.close;
        });

        // 仍為 null 的空列必須濾掉，保留會讓指標計算出錯。
        const candles = raw.filter((c) => c.close !== null);

        // 除權息以證交所與櫃買的官方資料為準，Yahoo 的事件表僅作為補充。
        //
        // Yahoo 的事件表落後於它自己的價格：除息當天收盤價已經扣掉配息，
        // 事件表卻還沒有那一筆，權益曲線會因此多出一筆等於配息的虧損。
        const officialDividends = (await loadExRights())[code] ?? {};
        const byDate = new Map();
        for (const ev of Object.values(result.events?.dividends ?? {})) {
          const date = new Date(ev.date * 1000).toISOString().slice(0, 10);
          if (Number.isFinite(ev.amount) && ev.amount > 0) byDate.set(date, ev.amount);
        }
        // 官方資料後寫入，同一天以官方為準。
        for (const [date, amount] of Object.entries(officialDividends)) byDate.set(date, amount);

        const first = candles[0]?.date;
        const last = candles[candles.length - 1]?.date;
        const dividends = [...byDate.entries()]
          .map(([date, amount]) => ({ date, amount }))
          // 落在本次 K 線區間之外的配息與這段曲線無關，帶出去只會讓使用端誤用。
          .filter((d) => (!first || d.date >= first) && (!last || d.date <= last))
          .sort((a, b) => a.date.localeCompare(b.date));

        return {
          code,
          symbol: `${code}${suffix}`,
          market: suffix === '.TWO' ? 'OTC' : 'TSE',
          currency: result.meta?.currency ?? 'TWD',
          candles,
          dividends,
          // 近幾日有幾根 K 棒的收盤價與 Yahoo 不同，已改用官方數字。供除錯對帳用。
          correctedCloses: corrected,
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

  const all = await withPartialCache('margin:all', TTL.DAILY, async () => {
    const map = {};
    let listedOk = false;
    let otcOk = false;

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
      listedOk = true;
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
      otcOk = true;
    } catch {
      // 同上。
    }

    return { value: map, complete: listedOk && otcOk };
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
      json = await fetchJson(`${TWSE_RWD}/fund/T86?date=${date}&selectType=ALL&response=json`, {
        headers: { Referer: 'https://www.twse.com.tw/zh/trading/foreign/t86.html' },
        // 逐日回溯本身就是一種重試機制，單次請求不再重試，逾時也壓短。
        // 否則最壞情況是 8 個日期各自重試三次，累積時間會超過函式執行上限。
        // 保留 8 天的回溯範圍是為了跨過農曆年的連續休市。
        timeoutMs: 4000,
        retries: 0,
      });
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
 * 帶入 days 時改抓 FinMind 取得歷史序列，需伺服器設有 FINMIND_TOKEN。
 * 單位為張。
 */
export async function institutionalHandler(query, env = {}) {
  const codes = String(query.codes ?? '')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
  const days = Number(query.days ?? 0);

  if (days > 0) {
    if (codes.length !== 1) {
      return { status: 400, body: { error: '查詢歷史序列時只能帶入單一代號' } };
    }
    if (days > 365) {
      return { status: 400, body: { error: 'days 上限為 365' } };
    }
    // 未設定 token 時回傳明確的不可用狀態，而不是悄悄退回當日資料。
    // 兩者的資料結構不同，混在一起會讓前端難以判斷拿到的究竟是什麼。
    if (!env.FINMIND_TOKEN) {
      return {
        status: 200,
        body: {
          source: 'none',
          code: codes[0],
          available: false,
          reason: '伺服器未設定 FINMIND_TOKEN，無法取得法人歷史資料',
          series: [],
        },
      };
    }
    return institutionalHistory(codes[0], days, env.FINMIND_TOKEN);
  }

  const all = await withPartialCache('institutional:all', TTL.DAILY, async () => {
    // 兩個市場互不相依，並行取用；任一失敗不影響另一邊。
    const [listed, otc] = await Promise.allSettled([
      loadListedInstitutional(),
      loadOtcInstitutional(),
    ]);
    // 上市走逐日回溯，全部日期都查無資料時會回空物件而不是拋錯，
    // 因此完整性要看內容是否非空，只看 fulfilled 會漏判。
    const listedOk = listed.status === 'fulfilled' && Object.keys(listed.value).length > 0;
    const otcOk = otc.status === 'fulfilled' && Object.keys(otc.value).length > 0;
    return {
      value: {
        ...(otc.status === 'fulfilled' ? otc.value : {}),
        ...(listed.status === 'fulfilled' ? listed.value : {}),
      },
      complete: listedOk && otcOk,
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
  return withCache(`institutional:history:${code}:${days}`, TTL.DAILY, async () => {
    const start = new Date(Date.now() - days * 86400 * 1000).toISOString().slice(0, 10);
    const url =
      `${FINMIND}?dataset=TaiwanStockInstitutionalInvestorsBuySell` +
      `&data_id=${encodeURIComponent(code)}&start_date=${start}`;

    // FinMind v4 以 Authorization 標頭認證。舊版可用的 token 查詢參數已不是官方寫法，
    // 且把金鑰放在網址會被各層代理與日誌記錄下來，不應使用。
    const json = await fetchJson(url, { headers: { Authorization: `Bearer ${token}` } });
    if (json?.status !== 200) {
      return { status: 502, body: { error: `FinMind 回應：${json?.msg ?? '未知錯誤'}` } };
    }

    // FinMind 每個法人別各一列，需依日期彙整成單列。
    //
    // 實測回傳的法人別共五種：Foreign_Investor、Foreign_Dealer_Self、
    // Investment_Trust、Dealer_self、Dealer_Hedging。
    // 判斷順序不能調換：Foreign_Dealer_Self 同時符合外資與自營商兩種樣式，
    // 市場慣稱的「外資」包含外資自營商，因此必須先判定外資。
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
        available: true,
        series: Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date)),
        fetchedAt: new Date().toISOString(),
      },
    };
  });
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

  const all = await withPartialCache('valuation:all', TTL.DAILY, async () => {
    const map = {};
    let listedOk = false;
    let otcOk = false;

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
      listedOk = true;
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
      otcOk = true;
    } catch {
      // 同上。
    }

    return { value: map, complete: listedOk && otcOk };
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
  analyze: analyzeHandler,
};
