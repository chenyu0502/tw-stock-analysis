/**
 * 大盤指數：加權指數與櫃買指數。
 *
 * 兩個來源各司其職：
 *
 * - **即時報價走證交所 MIS**（`tse_t00.tw`、`otc_o00.tw`）。盤中每分鐘更新，
 *   與個股報價同一個來源，紅綠與漲跌幅的口徑因此一致。
 * - **日 K 走 FinMind 的 `TaiwanStockPrice`**（`data_id` 為 `TAIEX` 與 `TPEx`）。
 *
 * 為什麼日 K 不沿用個股那條 Yahoo 路徑：
 *   Yahoo 的 `^TWII`（加權）雖然是更新的，但 `^TWOII`（櫃買）已經停止更新——
 *   實測最後一筆停在 2024-10-12，兩年前。拿它畫圖會得到一條看似正常、
 *   其實完全過時的線，比沒有資料更糟。
 *
 * 為什麼不用櫃買自己的官方資料：
 *   TPEx 的 `openapi/v1/tpex_index` 有完整開高低收，但**只回傳當月**（實測 14 筆），
 *   湊不出 20 日均線；月份分頁的 `afterTrading/tradingIndex` 有歷史，卻只有收盤價，
 *   畫不出 K 棒。FinMind 兩者兼具，且實測與官方數字完全一致。
 *
 * 交叉驗證（2026-08-20）：FinMind 與 MIS 的當日開高低收、前一日收盤四個市場數字
 * 全部相同，櫃買 8/19 收盤 384.79 也與 TPEx 官方月報一致。
 */

import { fetchJson, toNumber } from './http.js';
import { withCache, TTL } from './cache.js';

const TWSE_MIS = 'https://mis.twse.com.tw/stock/api/getStockInfo.jsp';
const FINMIND = 'https://api.finmindtrade.com/api/v4/data';

/**
 * 兩個指數的定義。
 *
 * `channel` 是 MIS 的頻道代號，`finmind` 是 FinMind 的 data_id，兩邊的命名毫無關聯，
 * 集中在這裡對照，加新指數時只要多一列。
 */
const INDICES = [
  { id: 'TAIEX', name: '加權指數', channel: 'tse_t00.tw', misCode: 't00', finmind: 'TAIEX' },
  { id: 'TPEX', name: '櫃買指數', channel: 'otc_o00.tw', misCode: 'o00', finmind: 'TPEx' },
];

/** 日 K 回溯天數。畫 60 根 K 棒又要 20 日均線成形，取一年最寬裕也夠快。 */
const HISTORY_DAYS = 365;

/** 正數才有意義，零與負值視為無資料。指數不可能為零。 */
function positiveOrNull(value) {
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * 取兩個指數的即時報價。
 *
 * 一次請求拿兩個頻道，省一趟往返。任一失敗就整個回空物件，
 * 由呼叫端決定要不要退回純歷史資料。
 */
async function loadQuotes() {
  const channels = INDICES.map((i) => i.channel).join('|');
  const url = `${TWSE_MIS}?json=1&delay=0&ex_ch=${encodeURIComponent(channels)}&_=${Date.now()}`;
  const json = await fetchJson(url, {
    headers: { Referer: 'https://mis.twse.com.tw/stock/index.jsp' },
  });

  const byCode = {};
  for (const row of json?.msgArray ?? []) {
    if (!row?.c) continue;
    const prevClose = positiveOrNull(toNumber(row.y));
    const price = positiveOrNull(toNumber(row.z)) ?? prevClose;
    const change = price !== null && prevClose !== null ? price - prevClose : null;
    byCode[row.c] = {
      price,
      prevClose,
      open: positiveOrNull(toNumber(row.o)),
      high: positiveOrNull(toNumber(row.h)),
      low: positiveOrNull(toNumber(row.l)),
      change,
      changePercent: change !== null && prevClose ? (change / prevClose) * 100 : null,
      // MIS 的 d 是 YYYYMMDD，轉成與 K 線相同的格式才能比對是不是同一天。
      date: String(row.d ?? '').replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3'),
      time: row.t ?? '',
    };
  }
  return byCode;
}

/**
 * 取單一指數的日 K。
 *
 * FinMind 的欄位名稱與一般慣例不同：最高價是 `max`、最低價是 `min`，
 * 這裡一併正規化成 open/high/low/close，前端不需要知道上游的怪癖。
 */
async function loadCandles(dataId, token) {
  const start = new Date(Date.now() - HISTORY_DAYS * 86400000).toISOString().slice(0, 10);
  const params = new URLSearchParams({
    dataset: 'TaiwanStockPrice',
    data_id: dataId,
    start_date: start,
  });
  // 沒有 token 也能取，只是額度較低。有設就帶上，與基本面共用同一把。
  if (token) params.set('token', token);

  const json = await fetchJson(`${FINMIND}?${params}`);
  return (json?.data ?? [])
    .map((row) => ({
      date: row.date,
      open: toNumber(row.open),
      high: toNumber(row.max),
      low: toNumber(row.min),
      close: toNumber(row.close),
      volume: toNumber(row.Trading_Volume),
    }))
    .filter((c) => c.date && Number.isFinite(c.close))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 以即時報價覆蓋當日那根 K 棒。
 *
 * FinMind 的當日資料要收盤後才會齊，盤中若直接採用，最後一根 K 棒會停在
 * 昨天的位置，而上方的即時指數卻一直在動——同一個畫面出現兩個「今天」。
 *
 * @param {object[]} candles
 * @param {object|null} quote
 * @returns {object[]}
 */
function applyLiveCandle(candles, quote) {
  if (!quote?.date || quote.price === null) return candles;

  const live = {
    date: quote.date,
    open: quote.open ?? quote.price,
    high: quote.high ?? quote.price,
    low: quote.low ?? quote.price,
    close: quote.price,
    volume: null,
  };

  const last = candles[candles.length - 1];
  if (last?.date === quote.date) {
    // 成交量沿用上游那筆，即時報價的量與日 K 的量單位不同，不可混用。
    return [...candles.slice(0, -1), { ...live, volume: last.volume }];
  }
  if (!last || last.date < quote.date) return [...candles, live];
  return candles;
}

/**
 * 大盤指數端點。
 *
 * 即時報價與日 K 分開快取：報價 15 秒、K 線 10 分鐘，與個股的慣例相同。
 * 兩者分開的理由是盤中每十五秒重抓一次一年份的 K 線毫無必要。
 */
export async function marketIndexHandler(query, env = {}) {
  const withCandles = String(query.candles ?? '1') !== '0';

  const quotes = await withCache('indexquote', TTL.QUOTE, loadQuotes).catch(() => ({}));

  const candlesById = {};
  if (withCandles) {
    const results = await Promise.allSettled(
      INDICES.map((i) =>
        withCache(`indexcandles:${i.finmind}`, TTL.HISTORY, () =>
          loadCandles(i.finmind, env.FINMIND_TOKEN)
        )
      )
    );
    INDICES.forEach((i, n) => {
      candlesById[i.id] = results[n].status === 'fulfilled' ? results[n].value : [];
    });
  }

  const indices = {};
  for (const meta of INDICES) {
    const quote = quotes[meta.misCode] ?? null;
    indices[meta.id] = {
      id: meta.id,
      name: meta.name,
      ...(quote ?? {
        price: null,
        prevClose: null,
        open: null,
        high: null,
        low: null,
        change: null,
        changePercent: null,
        date: '',
        time: '',
      }),
      candles: withCandles ? applyLiveCandle(candlesById[meta.id] ?? [], quote) : [],
    };
  }

  return { status: 200, body: { indices } };
}
