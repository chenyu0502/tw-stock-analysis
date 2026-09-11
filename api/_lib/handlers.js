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
 *
 * **執行區域與上游延遲**
 *
 * 下面幾個上游（證交所 MIS、TWSE、櫃買）的伺服器都在台灣，而 Vercel Hobby
 * 方案的函式固定跑在美東 iad1，無法更改區域（選區域是 Pro 以上的功能）。
 * 於是每一次取價都要橫跨太平洋，實測差距極大：
 *
 *   同一支查詢（每次換代號，強制真的打上游）
 *     美東 iad1   25.5 秒（逾時後重試）
 *     台灣本機    0.02 秒
 *
 *   連續十次取樣：個股報價四次完全拿不到、大盤指數四次回 null。
 *   同一時間從台灣連打 MIS 二十次全部成功——上游是好的，慢的是這條路。
 *
 * 因此這一層的設計必須假設「上游隨時可能取不到」：快取要盡量留住成功的結果、
 * 失敗要明確往上拋讓畫面說得出來，而不是安靜地回一份空資料。
 *
 * 註：不要在 vercel.json 裡用 `//xxx` 當註解，那個檔案的 schema 不接受
 * 未定義的屬性，加了會讓整個部署失敗（訊息為 should NOT have additional property）。
 */

import { fetchJson, toNumber } from './http.js';
import { withCache, withPartialCache, cacheGet, TTL } from './cache.js';
import { analyzeHandler } from './analyze.js';
import { fundamentalsHandler } from './fundamentals.js';
import { marketIndexHandler } from './marketIndex.js';
import { buildPeerReport, loadIndustryMap } from './peers.js';

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
 * 查出個股屬於上市或上櫃，**只讀已經在快取裡的對照表，絕不觸發載入**。
 *
 * 歷史查詢只拿這個結果決定先試 .TW 還是 .TWO，猜錯的代價是多打一次 Yahoo，
 * 實測 0.2 秒。而建一次對照表要抓兩份全市場清單，正式站實測 5.4 秒——
 * 一次開頁二十幾檔各自冷啟動，每個實例都付這 5.4 秒，正是壓測時單檔
 * 拖到 27 秒的主因。用 0.2 秒的可能損失換掉 5.4 秒的必然成本。
 *
 * 對照表由前端的代號搜尋等處自然填熱，溫的時候這裡照樣受益。
 *
 * @param {string} code
 * @returns {'TSE'|'OTC'|null} 尚未快取時回傳 null
 */
function peekMarket(code) {
  const universe = cacheGet('universe');
  return universe?.[code]?.market ?? null;
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

    // 上游沒有回傳 msgArray 就是取用失敗，要往上拋。
    //
    // 分辨「上游掛了」與「代號不存在」的方法是看 msgArray 在不在：
    // 代號查無資料時 MIS 仍會回一個空陣列，欄位本身是存在的。
    // 少了這一關，證交所抽風時端點會回一個沒有任何報價的成功回應，
    // 前端把它當正常結果，畫面只是靜靜地空著或停在舊價，看不出發生什麼事。
    if (!Array.isArray(json?.msgArray)) {
      throw new Error('證交所即時報價暫時取不到，請稍後再試');
    }

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

    await applyOfficialClose(quotes);

    return {
      quotes,
      missing: codes.filter((c) => !quotes[c]),
      fetchedAt: new Date().toISOString(),
    };
  });

  return { status: 200, body };
}

/**
 * 收盤後把「現價」換成官方收盤價。
 *
 * MIS 的 z 是最後一筆成交價，收盤後不會再改。台股的收盤價由 13:25～13:30 的
 * 收盤集合競價決定，兩者通常相同，但不保證——實測 2026-09-01 的 00944，
 * MIS 停在 21.26，證交所公告的收盤價是 21.25。持有一萬股就差一百元，
 * 而且那個數字會被拿去跟券商對帳。
 *
 * **只在收盤後才動作，盤中完全不額外請求。** 盤中的即時價本來就該用 MIS，
 * 而官方行情要收盤後才公布。判斷依據是 MIS 自己回報的成交時間。
 *
 * @param {Record<string, object>} quotes 會就地修改
 */
async function applyOfficialClose(quotes) {
  const todayCompact = isoToCompact(taipeiToday());
  const entries = Object.entries(quotes).filter(
    ([, q]) => q.tradeDate === todayCompact && String(q.tradeTime ?? '') >= '13:30'
  );
  if (entries.length === 0) return;

  const month = taipeiToday().slice(0, 7);
  await Promise.all(
    entries.map(async ([code, q]) => {
      try {
        const map = await loadOfficialMonth(code, q.market === 'OTC' ? 'OTC' : 'TSE', month);
        const row = map.get(taipeiToday());
        if (!row || !Number.isFinite(row.close) || row.close <= 0) return;
        q.price = row.close;
        q.open = row.open ?? q.open;
        q.high = row.high ?? q.high;
        q.low = row.low ?? q.low;
        q.change = q.prevClose === null ? null : row.close - q.prevClose;
        q.changePercent = q.change !== null && q.prevClose ? (q.change / q.prevClose) * 100 : null;
      } catch {
        // 取不到就沿用 MIS 的價格，不讓報價整批失敗。
      }
    })
  );
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
 * 台北時間的今天。
 *
 * 不能用 `new Date().toISOString()`——那是 UTC，比台北慢八小時。
 * 台北凌晨到早上八點之間，UTC 還停在前一天，會把昨天那個已經收盤的
 * 交易日誤判成「今天」而略過校正。伺服器可能跑在任何時區，不能靠本機時間。
 * @returns {string} YYYY-MM-DD
 */
function taipeiToday() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
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
      const json = await fetchJson(url, BULK_FETCH);
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
      const rows = await fetchJson(`${TPEX_OPENAPI}/tpex_exright_prepost`, BULK_FETCH);
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
 * GET /api/exdividend
 *
 * 即將除權息的標的。來源為證交所的除權除息預告表與櫃買的除權息預告，
 * 兩者都只涵蓋已公告的區間（實測約往後兩個月）。
 *
 * 與 loadExRights() 的差別：那個用的是**結果表**，只有已經發生的，
 * 用途是還原歷史淨值；這裡要的是還沒發生的，用途是提醒。
 *
 * 配息金額可能尚未定案。證交所在該欄位放的是「待公告實際收益分配金額」這串文字
 * （而且帶 HTML 標籤），此時金額回傳 null，由介面顯示「金額待公告」，
 * 不可當成零——那會讓使用者以為這次不配息。
 */
export async function exDividendHandler() {
  const today = new Date().toISOString().slice(0, 10);

  const body = await withPartialCache('exdividend:upcoming', TTL.DAILY, async () => {
    const items = [];
    let twseOk = false;
    let tpexOk = false;

    // 證交所：除權除息預告表。不帶日期參數，回傳的就是目前已公告的整個區間。
    try {
      const json = await fetchJson(`${TWSE_RWD}/exRight/TWT48U?response=json`, BULK_FETCH);
      for (const row of json?.data ?? []) {
        const date = rocToIso(row[0]);
        const code = String(row[1] ?? '').trim();
        if (!date || !code || date < today) continue;
        items.push({
          code,
          name: String(row[2] ?? '').trim(),
          date,
          // 欄位順序：日期、代號、名稱、權/息、無償配股率、現金增資配股率、認購價、現金股利
          cash: toNumber(row[7]),
          stock: toNumber(row[4]),
          kind: String(row[3] ?? '').trim(),
          market: 'TSE',
        });
      }
      twseOk = true;
    } catch {
      // 單一市場失敗不應讓另一個市場的提醒一起消失。
    }

    // 櫃買：除權息預告與結果同表，需自行濾掉已發生的日期。
    try {
      const rows = await fetchJson(`${TPEX_OPENAPI}/tpex_exright_prepost`, BULK_FETCH);
      for (const row of rows ?? []) {
        const date = rocToIso(row.ExRrightsExDividendDate);
        const code = String(row.SecuritiesCompanyCode ?? '').trim();
        if (!date || !code || date < today) continue;
        items.push({
          code,
          name: String(row.CompanyName ?? '').trim(),
          date,
          cash: toNumber(row.CashDividend),
          stock: toNumber(row.StockDividendRatio),
          kind: String(row.ExRrightsExDividend ?? '').trim(),
          market: 'OTC',
        });
      }
      tpexOk = true;
    } catch {
      // 同上。
    }

    items.sort((a, b) => a.date.localeCompare(b.date) || a.code.localeCompare(b.code));
    return {
      value: { items, from: today, fetchedAt: new Date().toISOString() },
      complete: twseOk && tpexOk,
    };
  });

  return { status: 200, body };
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
 * 同上，但取原始字串。日期欄位不能經過 toNumber。
 * @param {string[]} fields
 * @param {string[]} row
 * @param {string} name
 * @returns {string}
 */
function cellByFieldRaw(fields, row, name) {
  const index = fields.indexOf(name);
  return index === -1 ? '' : String(row[index] ?? '');
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
 * 兩個市場分開查也分開快取。只持有上市股時不必去打櫃買，而且櫃買掛掉時
 * 上市的結果不會跟著被標成不完整、每分鐘重試一次。
 *
 * **改成「單檔單月」而不是「全市場單日」是為了修 504。**
 *
 * 原本 TSE 走 `MI_INDEX?type=ALL`，那是**單日 4.5 MB、耗時 4.2 秒**的全市場行情，
 * 而且校正三天就要打三次。一次開頁會同時查二十幾檔歷史，每檔在各自的
 * serverless 實例上冷啟動（跨實例不共用記憶體快取），等於同時向證交所要
 * 三百多 MB。上游一慢就撞上逾時，整個 /api/history 回 504。
 *
 * 改用單檔端點後：**2.4 KB、0.12 秒，而且一次涵蓋整個月**。
 * 實測同一份資料，體積約為原本的一千九百分之一。
 *
 * @param {string} code 股票代號
 * @param {'TSE'|'OTC'} market
 * @param {string} month YYYY-MM
 * @returns {Promise<Map<string, {open:number|null, high:number|null, low:number|null, close:number}>>}
 */
async function loadOfficialMonth(code, market, month) {
  return withPartialCache(`officialmonth:${market}:${code}:${month}`, TTL.DAILY, async () => {
    const [year, mon] = month.split('-');
    // 兩個市場的網址、日期格式與欄位名稱全都不同，只有「一個月一張表」的結構相同。
    const spec =
      market === 'OTC'
        ? {
            url:
              `https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock` +
              `?code=${encodeURIComponent(code)}&date=${year}/${mon}/01&id=&response=json`,
            date: '日 期',
            open: '開盤',
            high: '最高',
            low: '最低',
            close: '收盤',
          }
        : {
            url:
              `${TWSE_RWD}/afterTrading/STOCK_DAY` +
              `?stockNo=${encodeURIComponent(code)}&date=${year}${mon}01&response=json`,
            date: '日期',
            open: '開盤價',
            high: '最高價',
            low: '最低價',
            close: '收盤價',
          };

    const map = new Map();
    try {
      const json = await fetchJson(spec.url, OFFICIAL_FETCH);
      // TWSE 把資料放在頂層的 fields/data，TPEx 放在 tables 陣列裡，兩種都要能讀。
      const tables = json?.tables ?? (json?.fields ? [{ fields: json.fields, data: json.data }] : []);
      for (const table of tables) {
        const fields = (table.fields ?? []).map((f) => String(f).trim());
        if (!fields.includes(spec.close)) continue;
        for (const row of table.data ?? []) {
          const isoDate = rocToIso(cellByFieldRaw(fields, row, spec.date));
          const close = cellByField(fields, row, spec.close);
          // 無成交的日子開高低收會是「--」，解析後為 null，整列跳過。
          if (!isoDate || close === null || close <= 0) continue;
          map.set(isoDate, {
            open: cellByField(fields, row, spec.open),
            high: cellByField(fields, row, spec.high),
            low: cellByField(fields, row, spec.low),
            close,
          });
        }
        break;
      }
    } catch {
      // 取不到就沿用 Yahoo 的數字，不讓整個歷史查詢失敗。
    }

    // 空結果不視為完整，讓當月尚未有資料的情形能很快重試。
    return { value: map, complete: map.size > 0 };
  });
}

/**
 * 以官方行情校正的月份數（含當月）。
 *
 * **原本只校正最近三個交易日，那樣不夠。**
 *
 * Yahoo 對部分標的回傳的是「還原股價」——除息日之前的每一根都被往下調整過。
 * 實測 1453：2026-08-28 除息 0.35 元，8/03～8/27 每一天都比證交所低約 0.33，
 * 比值固定 0.9709；而 8/28 起又變回未還原。`close` 與 `adjclose` 兩個欄位
 * 給的是同一組數字，因此無法改讀另一個欄位繞過。
 *
 * 這對本專案是實質錯誤：權益曲線另外在除息日把配息當現金加回，
 * 若價格序列也已經還原過，等於同一筆配息算了兩次；而且還原與未還原的交界
 * 會生出一段假漲幅——實測 1453 在 8/28 那天憑空多出約 2,572 元。
 *
 * 單檔月報表只有兩三 KB，一次涵蓋整個月，因此改成校正最近幾個月的每一天。
 *
 * **取三個月而不是兩個月，是為了避開交界的假跳空。** 校正區間的第一天會拿
 * 未校正的前一天當基準，那個落差會整包變成當天的損益：實測只校正兩個月時，
 * 8/03 相對 7/31 憑空多出 2,451 元。多補一個月，交界就落在對帳區間之外。
 * 再往前的資料仍可能是還原價，需要對更早的期間時要再調大。
 */
const OFFICIAL_CLOSE_MONTHS = 3;

/**
 * 官方行情的取用預算。
 *
 * 單檔月報表只有兩三 KB、實測 0.12 秒，逾時給五秒已經很寬鬆，還可以重試一次。
 * 這與先前的全市場行情不同——那個回應有 4.5 MB，只能設短逾時且不重試。
 */
const OFFICIAL_FETCH = { timeoutMs: 5000, retries: 1 };

/**
 * 除權息表的取用預算。
 *
 * 這幾個上游的回應是上千列，而且是每次冷啟動必打的。逾時設短、不重試，
 * 失敗就少一層資訊，讓整個請求逾時卻是完全沒有資料。
 */
const BULK_FETCH = { timeoutMs: 6000, retries: 0 };

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
  // withPartialCache 而不是 withCache：官方行情取不到時這份資料是殘缺的，
  // 只能快取一分鐘等著重試，不能當成好資料鎖住十分鐘。理由見下方 droppedPast。
  const body = await withPartialCache(cacheKey, TTL.HISTORY, async () => {
    // 只在對照表已經快取時用它決定順序，沒有就直接用預設順序——
    // 為了排順序而去建一次對照表並不划算，理由見 peekMarket。
    const market = peekMarket(code);
    // 兩種後綴都會嘗試，順序猜錯只是多打一次 Yahoo。
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
        // 只校正「今天以前」的日期。
        //
        // 官方收盤行情要等收盤後才會公布，盤中查今天必然是空的——
        // 空結果會被標成不完整而只快取一分鐘，於是每分鐘重抓一次全市場行情，
        // 是純粹的浪費，也是最容易讓整個請求逾時的一段。
        // 而今天那根 K 棒在權益曲線裡本來就會被即時報價覆蓋，根本用不到官方值。
        const todayIso = taipeiToday();
        // 最近 N 個月的月報表。一份就涵蓋整個月，因此校正的天數多寡不影響請求數。
        const months = [];
        const cursor = new Date(`${todayIso.slice(0, 7)}-01T00:00:00Z`);
        for (let i = 0; i < OFFICIAL_CLOSE_MONTHS; i += 1) {
          months.push(cursor.toISOString().slice(0, 7));
          cursor.setUTCMonth(cursor.getUTCMonth() - 1);
        }

        const official = new Map();
        for (const monthMap of await Promise.all(
          months.map((m) => loadOfficialMonth(code, suffix === '.TWO' ? 'OTC' : 'TSE', m))
        )) {
          for (const [date, row] of monthMap) official.set(date, row);
        }

        let corrected = 0;
        // 今天也校正，但只在官方已經公布時（收盤後）。盤中月報表裡沒有今天那列，
        // official.has 自然為 false，因此不需要另外判斷是否收盤。
        const recent = raw.filter((c) => official.has(c.date));
        recent.forEach((candle) => {
          const row = official.get(candle.date);
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

        // 濾掉的若是「今天以前」的交易日，代表這份資料有洞。
        //
        // Yahoo 對台股 ETF 常常給 null 收盤（實測 00915 的 2026-09-07），
        // 正常情況由上面的官方月報表補上；官方那一趟失敗時就補不了，
        // 那一天會整根消失。缺一根 K 棒不會有任何錯誤訊息，症狀是
        // **當日損益被挪到下一個有價格的日子**——缺的那天少算它的漲跌，
        // 隔天一次補回來。實測五檔 ETF 同時缺 09-07 時，9/07 與 9/08 各差七千多元。
        //
        // 因此這種結果必須標成不完整，只快取一分鐘。先前一律當成好資料鎖十分鐘，
        // 上游一次限流就會讓所有裝置在那十分鐘內都拿到有洞的資料。
        //
        // 只算「官方校正涵蓋得到」的那幾個月，而且不算今天。
        //
        // 這兩個界線都不能少：
        //
        // - **今天那一根不算**：盤前 Yahoo 給 null 是正常的，官方行情也還沒公布，
        //   算進去會讓開盤前的每一分鐘都在重抓。
        // - **超出校正窗的不算**：range=2y 時，兩年前那些 Yahoo 缺值本來就補不了，
        //   重抓一百次還是缺。算進去會讓每一份長區間的歷史都被判為不完整、
        //   每分鐘重建一次——實測 28 檔持股有 11 檔會中，那正是先前把
        //   /api/history 打到 504 的請求形狀。
        const correctableFrom = `${months[months.length - 1]}-01`;
        const droppedPast = raw.filter(
          (c) => c.close === null && c.date < todayIso && c.date >= correctableFrom
        ).length;

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
          value: {
            code,
            symbol: `${code}${suffix}`,
            market: suffix === '.TWO' ? 'OTC' : 'TSE',
            currency: result.meta?.currency ?? 'TWD',
            candles,
            dividends,
            // 近幾日有幾根 K 棒的收盤價與 Yahoo 不同，已改用官方數字。供除錯對帳用。
            correctedCloses: corrected,
            // 這份資料少了幾個過去的交易日。使用端據此知道逐日損益不可信。
            missingPastDays: droppedPast,
            fetchedAt: new Date().toISOString(),
          },
          complete: droppedPast === 0,
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
 * 全市場的本益比、股價淨值比與殖利率快照。
 *
 * 上市取證交所 BWIBBU_ALL，上櫃取櫃買中心 peratio_analysis，
 * 兩者皆免費且免 token，比參考站另接第三方服務穩定。
 *
 * 抽成獨立函式是為了讓同業比較重用同一份快取。兩個端點各抓一次全市場清單，
 * 拿到的會是同一份資料，卻要付兩趟跨太平洋的往返，還可能因為抓取時間不同
 * 而讓「本檔估值」與「同業中位數」落在不同的交易日。
 *
 * @returns {Promise<Record<string, object>>}
 */
async function loadValuationAll() {
  return withPartialCache('valuation:all', TTL.DAILY, async () => {
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
}

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

  const all = await loadValuationAll();
  const picked = codes.length ? Object.fromEntries(codes.map((c) => [c, all[c] ?? null])) : all;
  return { status: 200, body: { items: picked, fetchedAt: new Date().toISOString() } };
}

/* ------------------------------------------------------------------ */
/* 端點：同業估值比較                                                   */
/* ------------------------------------------------------------------ */

/**
 * GET /api/peers?code=2330
 *
 * 回傳同產業的本益比、股價淨值比與殖利率統計，以及本檔在其中的分位與名次。
 * 全部由程式計算，不呼叫任何語言模型。
 *
 * 產業分類需要 FINMIND_TOKEN；估值數字重用 /api/valuation 的全市場快取，
 * 因此熱快取時這個端點不會產生任何上游流量。
 */
export async function peersHandler(query, env = {}) {
  const code = String(query.code ?? '').trim();
  if (!/^\d{4,6}[A-Z]?$/.test(code)) {
    return { status: 400, body: { error: '代號格式不正確' } };
  }
  if (!env.FINMIND_TOKEN) {
    return {
      status: 200,
      body: {
        available: false,
        code,
        reason: '伺服器未設定 FINMIND_TOKEN，無法取得產業分類',
      },
    };
  }

  // 兩份資料互不相依，並行取用。
  const [industries, valuations] = await Promise.all([
    loadIndustryMap(env.FINMIND_TOKEN),
    loadValuationAll(),
  ]);

  return {
    status: 200,
    body: {
      ...buildPeerReport({ code, industries, valuations }),
      fetchedAt: new Date().toISOString(),
    },
  };
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
  peers: peersHandler,
  fundamentals: fundamentalsHandler,
  exdividend: exDividendHandler,
  universe: universeHandler,
  analyze: analyzeHandler,
  marketindex: marketIndexHandler,
};
