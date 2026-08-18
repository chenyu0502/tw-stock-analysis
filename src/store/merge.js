/**
 * 本機與雲端資料的合併。
 *
 * 刻意與 persistence.js 分開：這裡全是純函式，不碰 Firebase 也不碰 localStorage，
 * 因此可以直接在 Node 執行測試。合併規則出錯的後果是資料悄悄變多或變少，
 * 必須能單獨驗證。
 */

/**
 * 墓碑的保留期限。
 *
 * 超過這段時間就清掉，避免無限累積。代價是離線超過這麼久的裝置回來時，
 * 它手上的舊資料會被當成新資料合併回來。以個人使用的情境，九十天足夠有餘。
 */
const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** 合併兩份墓碑，同一個鍵取較晚的刪除時間，並丟掉過期的。 */
function mergeTombstones(a = {}, b = {}) {
  const cutoff = Date.now() - TOMBSTONE_TTL_MS;
  const out = {};
  for (const [key, at] of [...Object.entries(a), ...Object.entries(b)]) {
    const time = Number(at) || 0;
    if (time < cutoff) continue;
    out[key] = Math.max(out[key] ?? 0, time);
  }
  return out;
}

/**
 * 合併本機與雲端資料。
 *
 * 以 code 或 id 去重，同一筆在兩邊都有時保留較新的那一筆。
 * cash 取雲端值，因為它是單一數值無從合併，雲端代表較正式的紀錄。
 *
 * **刪除必須靠墓碑，不能靠聯集。** 聯集只會讓兩邊的資料越合越多：
 * 使用者刪掉一筆，雲端那份還在，下次開啟又被加回來，
 * 症狀是「刪不掉、每次重開又出現」。因此刪除動作本身要被記錄下來，
 * 合併時據以濾除。這對持股、追蹤標的、交易與資金流水一律適用。
 *
 * @param {object|null} local
 * @param {object|null} cloud
 * @returns {object}
 */
export function mergePortfolio(local, cloud) {
  const empty = {
    watchlist: [],
    holdings: [],
    transactions: [],
    cashFlows: [],
    cash: 0,
    statsStartDate: null,
    deleted: { watchlist: {}, holdings: {}, transactions: {}, cashFlows: {} },
  };
  if (!cloud) return local ?? empty;
  if (!local) return cloud;

  const deleted = {};
  for (const name of ['watchlist', 'holdings', 'transactions', 'cashFlows']) {
    deleted[name] = mergeTombstones(local.deleted?.[name], cloud.deleted?.[name]);
  }

  /**
   * 以指定欄位為鍵去重，並濾掉已被刪除的項目。
   *
   * 交易與資金流水以 id 為鍵而非 code：它們是逐筆事件，
   * 以 code 覆蓋會讓同一檔的多筆買賣只剩一筆。
   *
   * 墓碑要與項目自身的建立時間比較，不能只看「有沒有墓碑」。
   * 刪掉一檔之後又重新買進時，本機雖已撤掉墓碑，雲端那份還在，
   * 兩邊聯集後墓碑復活，剛加回來的持股就會被濾掉——
   * 症狀是「新增後重開又不見了」，與原本的問題剛好相反。
   * 建立時間晚於刪除時間就代表這是新的一筆，墓碑不適用。
   *
   * 交易與資金流水沒有建立時間，但它們的 id 是 nanoid，重新加入必定產生新的 id，
   * 不可能與舊墓碑相撞，因此一律套用墓碑是安全的。
   */
  const merge = (a = [], b = [], keyField, tombstones, newer) => {
    const map = new Map();
    for (const item of [...a, ...b]) {
      const key = String(item?.[keyField] ?? '');
      if (!key) continue;
      const removedAt = tombstones[key];
      if (removedAt && !((item.addedAt ?? 0) > removedAt)) continue;
      const prev = map.get(key);
      if (!prev || newer(item, prev)) map.set(key, item);
    }
    return [...map.values()];
  };

  const byAddedAt = (item, prev) => (item.addedAt ?? 0) > (prev.addedAt ?? 0);
  // 逐筆事件沒有 addedAt，同 id 視為同一筆，保留先取到的即可。
  const keepFirst = () => false;
  const byDate = (x, y) => String(x.date).localeCompare(String(y.date));

  const watchlist = merge(local.watchlist, cloud.watchlist, 'code', deleted.watchlist, byAddedAt);
  const holdings = merge(local.holdings, cloud.holdings, 'code', deleted.holdings, byAddedAt);

  // 項目因為比墓碑新而留下時，那個墓碑已經沒有意義，留著只會讓人以為它還在生效。
  for (const item of watchlist) delete deleted.watchlist[item.code];
  for (const item of holdings) delete deleted.holdings[item.code];

  return {
    watchlist,
    holdings,
    transactions: merge(
      local.transactions,
      cloud.transactions,
      'id',
      deleted.transactions,
      keepFirst
    ).sort(byDate),
    cashFlows: merge(local.cashFlows, cloud.cashFlows, 'id', deleted.cashFlows, keepFirst).sort(
      byDate
    ),
    cash: cloud.cash ?? local.cash ?? 0,
    // 統計起算日是單一設定值，無從合併，以雲端為準。
    // 漏掉這一項會讓登入後的同步把本機設定清成 null，使用者得重設一次。
    statsStartDate: cloud.statsStartDate ?? local.statsStartDate ?? null,
    deleted,
  };
}
