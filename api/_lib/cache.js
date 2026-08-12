/**
 * 伺服器端記憶體快取。
 *
 * 用途是擋掉重複打上游 API 的流量。Vercel serverless 冷啟動時快取會清空，
 * 這是可接受的行為，因為快取只是最佳化，不是正確性的前提。
 */

const store = new Map();

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
export async function withCache(key, ttlMs, producer) {
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;
  const value = await producer();
  cacheSet(key, value, ttlMs);
  return value;
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
};
