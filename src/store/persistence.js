/**
 * 資料持久化：localStorage 為主，Firestore 為跨裝置同步。
 *
 * 策略說明：
 * 1. 本機資料**按帳號分開存**（鍵名帶 uid）。併入 Claude Flow、開放給所有登入的使用者後，
 *    同一台電腦換人登入時，前一個人的持股絕不能被合併進下一個人的雲端文件。
 * 2. 登入後從雲端讀取，並與「這個帳號自己的」本機資料合併。
 * 3. 寫入雲端採防抖動，避免每次按鍵都打一次 Firestore。
 *
 * 換帳號的順序（見 src/stock/main.jsx）必須是：先在未登入狀態下 hydrate 本機資料
 * （middleware 沒有 uid，不寫本機也不寫雲端），再 setUser，最後 syncFromCloud。
 * 反過來的話，空的 hydrate 會帶著 uid 排進 2 秒後的雲端寫入，雲端讀取若慢於 2 秒，
 * 會把使用者的雲端持股覆寫成空的。
 */

import { hydrate } from './portfolioSlice.js';
import { mergePortfolio } from './merge.js';
import { loadPortfolio, savePortfolio, watchPortfolio } from '../lib/firebase.js';

/** 舊版（未分帳號）的鍵名，只用於一次性搬移。 */
export const LEGACY_STORAGE_KEY = 'tw-stock-portfolio-v1';
const CLOUD_WRITE_DEBOUNCE_MS = 2000;

/** 某個帳號的本機資料鍵名 */
export function storageKeyFor(uid) {
  return `${LEGACY_STORAGE_KEY}:${uid}`;
}

function readKey(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    // 資料毀損時視同沒有資料，不讓應用程式因為舊格式而無法啟動。
    return null;
  }
}

/**
 * 讀取某個帳號的本機資料。
 * @param {string} uid
 * @returns {object|null}
 */
export function readLocal(uid) {
  if (!uid) return null;
  return readKey(storageKeyFor(uid));
}

/**
 * 寫入某個帳號的本機資料。
 * @param {string} uid
 * @param {object} data
 */
export function writeLocal(uid, data) {
  if (!uid) return;
  try {
    localStorage.setItem(storageKeyFor(uid), JSON.stringify(data));
  } catch {
    // 無痕模式或配額用盡時會失敗，這不影響當次操作，靜默略過。
  }
}

/**
 * 取出並移除舊版未分帳號的本機資料（一次性搬移用）。
 *
 * 只能交給管理員：開放給所有人之前，這個網站上只有管理員能進台股頁，
 * 舊版那份資料一定屬於管理員。交給其他帳號就是把管理員的持股送給別人。
 * @returns {object|null}
 */
export function takeLegacyLocal() {
  const data = readKey(LEGACY_STORAGE_KEY);
  try {
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // 移除失敗不影響搬移結果。
  }
  return data;
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

    // 沒有 uid（未登入、正在換帳號）時本機與雲端都不寫，避免寫進錯誤的帳號。
    const uid = auth.user?.uid;
    if (uid) {
      writeLocal(uid, portfolio);

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

/**
 * 訂閱雲端變更，來了就與本機合併。
 *
 * **不會與雲端互相回音。** 兩層擋著：
 *
 * 1. 本機自己寫出去時 Firestore 會先回一次「尚未送達伺服器」的樂觀快照，直接略過。
 * 2. 伺服器確認後還會再回一次。此時合併結果等於本機現況，
 *    hydrate 出來的 state 與現有的完全相同，middleware 的 lastSerialized
 *    比對就會直接跳過，不會再寫一次。
 *
 * 合併結果與現況不同時（真的是別台改的），hydrate 是 portfolio 動作，
 * middleware 會照常寫回雲端——這正是把本機獨有資料推上去所需要的行為，
 * 因此這裡不必自己呼叫 savePortfolio。
 *
 * @param {import('@reduxjs/toolkit').Store} store
 * @param {string} uid
 * @returns {() => void} 取消訂閱
 */
export function subscribeToCloud(store, uid) {
  return watchPortfolio(uid, (cloud, fromLocalWrite) => {
    if (fromLocalWrite || !cloud) return;
    store.dispatch(hydrate(mergePortfolio(store.getState().portfolio, cloud)));
  });
}

export { mergePortfolio };
