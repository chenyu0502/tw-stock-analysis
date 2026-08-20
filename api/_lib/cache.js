/**
 * 伺服器端記憶體快取。
 *
 * 用途是擋掉重複打上游 API 的流量。Vercel serverless 冷啟動時快取會清空，
 * 這是可接受的行為，因為快取只是最佳化，不是正確性的前提。
 */

const store = new Map();

/**
 * 進行中的 producer，用於合併同一把鑰匙的併發請求。
 *
 * 績效頁一次會查數十檔個股的歷史股價，每一檔都會用到同一份除權息表與同一天的
 * 全市場收盤行情。若只看快取有無命中，這數十個請求會在快取寫入前全部撲空，
 * 對上游打出數十次一模一樣的查詢。
 */
const inflight = new Map();

/**
 * 取出未過期的快取值，過期或不存在則回傳 undefined。
 * @param {string} key
 * @returns {*}
 */
export function cacheGet(key) {
  const hit = store.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.expireAt) {
    store.delete(key);
    return undefined;
  }
  return hit.value;
}

/**
 * 寫入快取。
 * @param {string} key
 * @param {*} value
 * @param {number} ttlMs 存活時間（毫秒）
 */
export function cacheSet(key, value, ttlMs) {
  store.set(key, { value, expireAt: Date.now() + ttlMs });
}

/**
 * 快取包裝器：命中則直接回傳，未命中才執行 producer。
 * @param {string} key
 * @param {number} ttlMs
 * @param {() => Promise<*>} producer
 * @returns {Promise<*>}
 */
/**
 * 合併同一把鑰匙的併發請求：已有 producer 在執行就共用那個 promise。
 *
 * 只看「快取有沒有命中」是不夠的。快取要等 producer 完成才會寫入，
 * 在那之前抵達的請求全部會撲空並各自再跑一次 producer。
 * 績效頁一次查數十檔個股，每一檔又要數天份的全市場行情，
 * 少了這道合併就會對上游打出上百次一模一樣的查詢，函式直接逾時。
 *
 * @param {string} key
 * @param {() => Promise<*>} run
 * @returns {Promise<*>}
 */
function dedupe(key, run) {
  const pending = inflight.get(key);
  if (pending) return pending;

  const promise = run();
  inflight.set(key, promise);
  // 成功與失敗都要清掉，否則後續請求會一直拿到同一個被拒絕的 promise。
  return promise.finally(() => inflight.delete(key));
}

export async function withCache(key, ttlMs, producer) {
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;

  return dedupe(key, async () => {
    const value = await producer();
    cacheSet(key, value, ttlMs);
    return value;
  });
}

/**
 * 資料不完整時的快取包裝器。
 *
 * 多個上游合併而成的資料集（例如上市加上櫃）若有一邊取用失敗，
 * 結果仍然「有值」，用一般的 withCache 會把這份殘缺資料鎖住整個 TTL，
 * 使用者在那段期間只會看到某個市場的個股永遠查無資料，而且沒有任何錯誤訊息。
 *
 * 因此把完整與不完整分開計時：不完整的結果只快取很短的時間，讓下一次請求重試。
 *
 * @param {string} key
 * @param {number} ttlMs 資料完整時的存活時間
 * @param {() => Promise<{ value: *, complete: boolean }>} producer
 * @returns {Promise<*>}
 */
export async function withPartialCache(key, ttlMs, producer) {
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;

  // 這裡同樣需要合併併發請求。官方月報表與除權息表都走這個包裝器，
  // 一次開頁會同時查二十幾檔，漏掉合併正是造成 /api/history 逾時的原因之一。
  return dedupe(key, async () => {
    const { value, complete } = await producer();
    cacheSet(key, value, complete ? ttlMs : TTL.PARTIAL);
    return value;
  });
}

/** 常用 TTL 常數（毫秒）。 */
export const TTL = {
  /** 盤中報價：15 秒 */
  QUOTE: 15 * 1000,
  /** 日 K 歷史：10 分鐘 */
  HISTORY: 10 * 60 * 1000,
  /** 每日一次更新的資料（融資融券、法人、估值）：30 分鐘 */
  DAILY: 30 * 60 * 1000,
  /** 股票代號名稱對照表：12 小時 */
  UNIVERSE: 12 * 60 * 60 * 1000,
  /**
   * 基本面：24 小時。
   *
   * 財報一季才更新一次，月營收一個月一次，股利一年數次。
   * 這類資料抓一次可以用很久，而每檔要打五個資料集，
   * TTL 設短只會平白消耗 FinMind 的每小時額度。
   */
  FUNDAMENTAL: 24 * 60 * 60 * 1000,
  /** 資料不完整時的重試間隔：1 分鐘 */
  PARTIAL: 60 * 1000,
};
