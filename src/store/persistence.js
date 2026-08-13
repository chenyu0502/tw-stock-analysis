/**
 * 資料持久化：localStorage 為主，Firestore 為跨裝置同步。
 *
 * 策略說明：
 * 1. 未登入時只寫 localStorage，應用程式完全可用。
 * 2. 登入後從雲端讀取，並與本機資料合併，避免使用者在未登入狀態輸入的資料被清掉。
 * 3. 寫入雲端採防抖動，避免每次按鍵都打一次 Firestore。
 */

import { hydrate } from './portfolioSlice.js';
import { loadPortfolio, savePortfolio } from '../lib/firebase.js';

const STORAGE_KEY = 'tw-stock-portfolio-v1';
const CLOUD_WRITE_DEBOUNCE_MS = 2000;

/**
 * 從 localStorage 讀取資料。
 * @returns {object|null}
 */
export function readLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    // 資料毀損時視同沒有資料，不讓應用程式因為舊格式而無法啟動。
    return null;
  }
}

/**
 * 寫入 localStorage。
 * @param {object} data
 */
export function writeLocal(data) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // 無痕模式或配額用盡時會失敗，這不影響當次操作，靜默略過。
  }
}

/**
 * 合併本機與雲端資料。
 *
 * 以 code 為鍵去重，同一檔在兩邊都有時保留 addedAt 較新的那一筆。
 * cash 取雲端值，因為它是單一數值無從合併，雲端代表較正式的紀錄。
 * @param {object|null} local
 * @param {object|null} cloud
 * @returns {object}
 */
export function mergePortfolio(local, cloud) {
  const empty = { watchlist: [], holdings: [], transactions: [], cashFlows: [], cash: 0 };
  if (!cloud) return local ?? empty;
  if (!local) return cloud;

  /** 以 code 去重，同一檔兩邊都有時保留較新的一筆。 */
  const mergeByCode = (a = [], b = []) => {
    const map = new Map();
    for (const item of [...a, ...b]) {
      const prev = map.get(item.code);
      if (!prev || (item.addedAt ?? 0) > (prev.addedAt ?? 0)) map.set(item.code, item);
    }
    return [...map.values()];
  };

  /**
   * 以 id 去重。交易與資金流水是逐筆事件，不能像持股那樣以 code 覆蓋，
   * 否則同一檔的多筆買賣只會留下一筆。
   */
  const mergeById = (a = [], b = []) => {
    const map = new Map();
    for (const item of [...a, ...b]) map.set(item.id, item);
    return [...map.values()].sort((x, y) => String(x.date).localeCompare(String(y.date)));
  };

  return {
    watchlist: mergeByCode(local.watchlist, cloud.watchlist),
    holdings: mergeByCode(local.holdings, cloud.holdings),
    transactions: mergeById(local.transactions, cloud.transactions),
    cashFlows: mergeById(local.cashFlows, cloud.cashFlows),
    cash: cloud.cash ?? local.cash ?? 0,
  };
}

/**
 * 建立 Redux middleware：portfolio 有異動就寫本機，並防抖動寫雲端。
 * @returns {import('@reduxjs/toolkit').Middleware}
 */
export function createPersistenceMiddleware() {
  let timer = null;
  let lastSerialized = null;

  return (store) => (next) => (action) => {
    const result = next(action);

    if (!action.type?.startsWith('portfolio/')) return result;

    const { portfolio, auth } = store.getState();
    const serialized = JSON.stringify(portfolio);
    if (serialized === lastSerialized) return result;
    lastSerialized = serialized;

    writeLocal(portfolio);

    const uid = auth.user?.uid;
    if (uid) {
      clearTimeout(timer);
      timer = setTimeout(() => {
        savePortfolio(uid, portfolio).catch(() => {
          // 雲端寫入失敗不阻斷操作，本機資料仍然完整。
        });
      }, CLOUD_WRITE_DEBOUNCE_MS);
    }

    return result;
  };
}

/**
 * 登入後把雲端資料拉下來與本機合併。
 * @param {import('@reduxjs/toolkit').Store} store
 * @param {string} uid
 */
export async function syncFromCloud(store, uid) {
  try {
    const cloud = await loadPortfolio(uid);
    const merged = mergePortfolio(store.getState().portfolio, cloud);
    store.dispatch(hydrate(merged));
    // 合併後立刻回寫，讓雲端也拿到本機獨有的資料。
    await savePortfolio(uid, merged);
  } catch {
    // 雲端不可用時維持本機資料運作。
  }
}
