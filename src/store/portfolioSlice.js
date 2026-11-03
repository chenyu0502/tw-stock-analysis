/**
 * 感興趣標的、持股部位與交易紀錄的狀態管理。
 *
 * 這份 state 是使用者資料的唯一真實來源，會同步到 localStorage 與 Firestore。
 *
 * holdings 與 transactions 的關係：
 * holdings 是「現在持有什麼」，transactions 是「怎麼變成現在這樣」。
 * 兩者刻意分開存放而不是由交易紀錄即時推導，原因是使用者可能直接匯入現有部位
 * 而沒有完整的歷史交易，強制推導會讓那些部位無法建立。
 * 績效頁需要歷史時，會以 transactions 為準，缺漏處由 holdings 的建立時間補上。
 */

import { createSlice, nanoid } from '@reduxjs/toolkit';

/** 均線天數的預設值，可由使用者調整或由回測最佳化覆寫。 */
export const DEFAULT_MA = { short: 20, long: 60 };

/**
 * 取得今日的 YYYY-MM-DD 字串。
 *
 * 不用 toISOString，因為那會轉成 UTC，台灣時間早上八點前會退回前一天。
 * @returns {string}
 */
export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const initialState = {
  /** 感興趣標的：{ code, note, maShort, maLong, addedAt } */
  watchlist: [],
  /** 持股部位：{ code, shares, avgCost, note, maShort, maLong, addedAt } */
  holdings: [],
  /** 交易紀錄：{ id, code, date, shares, price, fee, realized } */
  transactions: [],
  /** 資金流水：{ id, date, amount, note }，正為入金、負為出金 */
  cashFlows: [],
  /** 帳上現金，用於計算資金水位與部位集中度。 */
  cash: 0,
  /**
   * 統計起算日 YYYY-MM-DD。
   *
   * 沒有交易紀錄的持股，權益曲線預設從「登記進系統那天」算起，之前的每日損益全部缺失。
   * 若部位在某個日期之前就已買進且之後沒有異動，把起算日設到那天即可正確回推。
   * 留空則沿用各持股自己的建倉日。
   */
  statsStartDate: null,
  /**
   * 刪除標記（墓碑）：集合名稱 → 鍵 → 刪除時間。
   *
   * 存在的理由是雲端合併採聯集，**刪除本身無法透過聯集傳遞**。
   * 使用者刪掉一筆紀錄後，雲端那份還在，下次開啟合併時又被加回來，
   * 看起來就像「刪不掉、每次重開又出現」。
   *
   * 記下刪除這個動作本身，合併時據以濾除，刪除才會生效。
   * 追蹤標的與持股以代號為鍵，交易與資金流水以 id 為鍵。
   */
  deleted: {
    watchlist: {},
    holdings: {},
    transactions: {},
    cashFlows: {},
    /**
     * 「這一檔在某個時間點之前的進出紀錄全部刪除」，以代號為鍵。
     *
     * 只用 id 層級的墓碑不夠：清除當下只看得到本機那幾筆，
     * 雲端若還有同一檔的其他紀錄（不同 id，例如來自另一台裝置或更早的工作階段），
     * 就不在名單裡，合併時照樣回來——症狀正是「清除了又出現」。
     * 記成代號層級才涵蓋得到那些沒見過的 id。
     */
    transactionCodes: {},
  },
};

/** 墓碑的集合名稱，用於初始化與合併時逐一處理。 */
export const DELETABLE = [
  'watchlist',
  'holdings',
  'transactions',
  'cashFlows',
  'transactionCodes',
];

/** 標記一筆刪除。 */
function markDeleted(state, collection, key) {
  if (!key) return;
  state.deleted[collection] ??= {};
  state.deleted[collection][String(key)] = Date.now();
}

/**
 * 清掉刪除標記。
 *
 * 重新加入同一個代號時必須呼叫，否則墓碑會把剛加進去的東西又濾掉，
 * 症狀是「新增後重開就不見了」——與原本的問題剛好相反。
 */
function clearDeleted(state, collection, key) {
  if (state.deleted?.[collection]) delete state.deleted[collection][String(key)];
}

const portfolioSlice = createSlice({
  name: 'portfolio',
  initialState,
  reducers: {
    /** 以整包資料覆寫，用於從 localStorage 或 Firestore 還原。 */
    hydrate(state, action) {
      const data = action.payload ?? {};
      state.watchlist = Array.isArray(data.watchlist) ? data.watchlist : [];
      state.holdings = Array.isArray(data.holdings) ? data.holdings : [];
      state.transactions = Array.isArray(data.transactions) ? data.transactions : [];
      state.cashFlows = Array.isArray(data.cashFlows) ? data.cashFlows : [];
      state.cash = Number.isFinite(data.cash) ? data.cash : 0;
      state.statsStartDate = data.statsStartDate ?? null;
      // 舊資料沒有這個欄位，逐一補上空物件，避免後續存取時炸開。
      state.deleted = {};
      for (const name of DELETABLE) {
        const value = data.deleted?.[name];
        state.deleted[name] = value && typeof value === 'object' ? value : {};
      }
    },

    /**
     * 還原一份持股備份，**保留感興趣標的**。
     *
     * 不能直接用 hydrate：那會連 watchlist 一起覆寫，而持股頁的匯出刻意不含
     * 感興趣標的，還原時就會把它清空。
     *
     * 這是整包取代而非合併——備份的語意是「回到那個時間點」，
     * 合併只會把已經刪掉的部位又帶回來。呼叫端必須先向使用者確認。
     */
    restorePortfolio(state, action) {
      const data = action.payload ?? {};
      if (Array.isArray(data.holdings)) state.holdings = data.holdings;
      if (Array.isArray(data.transactions)) state.transactions = data.transactions;
      if (Array.isArray(data.cashFlows)) state.cashFlows = data.cashFlows;
      if (Number.isFinite(data.cash)) state.cash = data.cash;
      if (data.statsStartDate !== undefined) state.statsStartDate = data.statsStartDate ?? null;
    },

    /**
     * 依代號新增或更新一筆持股，**不產生交易紀錄**。
     *
     * 給試算表匯入用。匯入的是「目前部位」這個事實，不是一筆買賣事件；
     * 若改用 recordTrade，每一列都會變成一筆日期為今天的買進，
     * 權益曲線會把整個部位當成今天才建倉。
     */
    upsertHolding(state, action) {
      const code = String(action.payload.code ?? '').trim();
      const shares = Number(action.payload.shares);
      if (!code || !Number.isFinite(shares) || shares <= 0) return;

      clearDeleted(state, 'holdings', code);
      const avgCost = Number(action.payload.avgCost);
      const existing = state.holdings.find((h) => h.code === code);
      const patch = {
        shares,
        avgCost: Number.isFinite(avgCost) ? avgCost : (existing?.avgCost ?? 0),
        note: action.payload.note ?? existing?.note ?? '',
        // 跨裝置合併靠這個判斷新舊，見 merge.js。
        updatedAt: Date.now(),
      };

      if (existing) {
        Object.assign(existing, patch);
        return;
      }
      state.holdings.push({
        code,
        maShort: action.payload.maShort ?? DEFAULT_MA.short,
        maLong: action.payload.maLong ?? DEFAULT_MA.long,
        addedAt: Date.now(),
        openedAt: action.payload.openedAt ?? today(),
        ...patch,
      });
    },

    /** 設定統計起算日，傳入空值即清除。 */
    setStatsStartDate(state, action) {
      const value = action.payload;
      state.statsStartDate = /^\d{4}-\d{2}-\d{2}$/.test(value ?? '') ? value : null;
    },

    addWatch(state, action) {
      const code = String(action.payload.code ?? '').trim();
      if (!code || state.watchlist.some((w) => w.code === code)) return;
      clearDeleted(state, 'watchlist', code);
      state.watchlist.push({
        code,
        note: action.payload.note ?? '',
        maShort: action.payload.maShort ?? DEFAULT_MA.short,
        maLong: action.payload.maLong ?? DEFAULT_MA.long,
        addedAt: Date.now(),
      });
    },

    removeWatch(state, action) {
      markDeleted(state, 'watchlist', action.payload);
      state.watchlist = state.watchlist.filter((w) => w.code !== action.payload);
    },

    updateWatch(state, action) {
      const { code, patch } = action.payload;
      const item = state.watchlist.find((w) => w.code === code);
      if (item) Object.assign(item, patch, { updatedAt: Date.now() });
    },

    /**
     * 記錄一筆交易並更新持股。
     *
     * payload: { code, shares, price, date?, fee?, note? }
     * shares 正為買進、負為賣出。
     *
     * price 是**成交價**，fee 是**該筆交易的手續費與交易稅合計**，兩者分開填。
     * 費用的流向在三個地方一致：
     *
     * - **帳上現金**：恆為流出。買進扣得更多，賣出收得更少。
     * - **成本均價**：買進時攤進 avgCost，所以成本會略高於成交價。
     * - **已實現損益**：賣出時從 realized 扣掉。
     *
     * fee 省略或為零時，price 就被當成已含費用的單位成本，行為與這個欄位
     * 出現之前完全相同——舊資料不需要轉檔，介面上也保留這個填法。
     */
    recordTrade(state, action) {
      const { code, shares, price } = action.payload;
      const date = action.payload.date || today();
      const fee = Number.isFinite(action.payload.fee) ? action.payload.fee : 0;

      const existing = state.holdings.find((h) => h.code === code);
      let realized = null;
      // 曾經移除又重新買進的標的，要先撤掉墓碑，否則合併時會把它濾掉。
      clearDeleted(state, 'holdings', code);

      if (shares < 0) {
        // 賣出時結算已實現損益。採平均成本法，與 avgCost 的維護方式一致。
        // 無對應持股時成本無從得知，realized 留白而不是猜一個數字。
        if (existing) {
          realized = (price - existing.avgCost) * Math.abs(shares) - fee;
        }
      }

      // 成交會直接動到帳上現金。
      //
      // 先前只有「記錄資金進出」會改現金，記錄交易不會，於是用帳上現金買股票時
      // 帳上現金不會減少。使用者只能另外記一筆出金去補，但權益曲線本來就會為
      // 交易扣一次現金，等於扣了兩次——曲線的歷史現金因此偏掉一個買進金額。
      //
      // 買進 shares 為正、金額為流出；賣出 shares 為負，這個式子自動變成流入。
      // 手續費恆為流出。
      const cashDelta = shares * price + fee;
      if (Number.isFinite(cashDelta)) state.cash -= cashDelta;

      state.transactions.push({
        id: nanoid(),
        code,
        // 建立時間。代號層級的墓碑靠它判斷「這筆是刪除之後才記的」，
        // 沒有它的話，清除過的標的之後再記交易會被墓碑一併濾掉。
        addedAt: Date.now(),
        date,
        shares,
        price,
        fee,
        realized,
        note: action.payload.note ?? '',
      });

      if (!existing) {
        // 沒有持股卻賣出，視為資料輸入錯誤，只留下交易紀錄不建立負部位。
        if (shares <= 0) return;
        state.holdings.push({
          code,
          shares,
          // 費用攤進單位成本。fee 為零時就等於成交價，也就是「price 已含費用」的填法。
          avgCost: price + fee / shares,
          note: action.payload.note ?? '',
          maShort: action.payload.maShort ?? DEFAULT_MA.short,
          maLong: action.payload.maLong ?? DEFAULT_MA.long,
          addedAt: Date.now(),
          openedAt: date,
        });
        return;
      }

      const totalShares = existing.shares + shares;
      if (totalShares <= 0) {
        // 全數賣出視為出清部位，交易紀錄仍保留供績效計算。
        //
        // 這也是一次刪除，必須立墓碑。少了它，另一台裝置雲端那份持股會在
        // 合併時被當成「本機沒有、雲端有」而加回來，已出清的部位就復活了。
        // 本 reducer 開頭的 clearDeleted 在這一行之前，因此不會互相抵銷。
        markDeleted(state, 'holdings', code);
        state.holdings = state.holdings.filter((h) => h.code !== code);
        return;
      }
      // 買進才需要重算平均成本，以股數加權。賣出不改變剩餘部位的成本。
      if (shares > 0) {
        existing.avgCost =
          (existing.avgCost * existing.shares + price * shares + fee) / totalShares;
      }
      existing.shares = totalShares;
      // 股數變了就要更新時間戳，否則另一台裝置會把它當成沒有變過的舊資料。
      existing.updatedAt = Date.now();
    },

    /**
     * 修正一筆既有的交易。
     *
     * payload: { id, patch: { date?, shares?, price?, fee?, note? } }
     *
     * **帳上現金會按差額同步調整。** 記錄交易時現金已經被扣（或加）過一次，
     * 改了股數或價格就必須補上差額，否則現金會一直停在用錯誤數字算出來的值——
     * 這正是「賣出時價格填錯、帳上現金跟著錯、而且沒有地方可以修」的成因。
     *
     * **刻意不動持股的股數與成本均價。** avgCost 是逐筆累進維護的加權平均，
     * 後續的買進已經把它折進去了，無法從單一筆交易反推回去。硬算只會得到一個
     * 看似合理卻對不上任何對帳單的數字。持股列本來就可以直接編輯股數與成本均價，
     * 那是比較誠實的修正路徑，介面上也會這樣說明。
     */
    updateTransaction(state, action) {
      const { id, patch = {} } = action.payload;
      const tx = state.transactions.find((t) => t.id === id);
      if (!tx) return;

      const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
      const oldShares = tx.shares;
      const oldPrice = tx.price;
      const oldFee = Number.isFinite(tx.fee) ? tx.fee : 0;
      const oldCashDelta = oldShares * oldPrice + oldFee;

      const shares = patch.shares === undefined ? oldShares : num(patch.shares, oldShares);
      const price = patch.price === undefined ? oldPrice : num(patch.price, oldPrice);
      const fee = patch.fee === undefined ? oldFee : num(patch.fee, oldFee);

      /*
       * 已實現損益重算時的成本基準，從原本那一筆反推。
       *
       *   realized = (price − avgCost) × |shares| − fee
       *   ⇒ avgCost = price − (realized + fee) / |shares|
       *
       * 用當下持股的 avgCost 不行：全數賣出時那個部位已經不存在了，
       * 而部分賣出之後 avgCost 也可能被後來的買進改過。反推只用這一筆自己的
       * 三個欄位，不依賴任何會變動的狀態。
       */
      let realized = tx.realized;
      if (shares < 0) {
        if (Number.isFinite(tx.realized) && oldShares < 0) {
          const basis = oldPrice - (tx.realized + oldFee) / Math.abs(oldShares);
          realized = (price - basis) * Math.abs(shares) - fee;
        }
        // 原本沒有已實現損益（賣出時查不到持股）就維持留白，不憑空算一個出來。
      } else {
        // 改成買進之後，已實現損益不再適用。
        realized = null;
      }

      tx.date = patch.date || tx.date;
      tx.shares = shares;
      tx.price = price;
      tx.fee = fee;
      if (patch.note !== undefined) tx.note = patch.note;
      tx.realized = realized;
      // 合併時要靠它判斷哪一邊比較新，少了它另一台裝置的舊值會贏。
      tx.updatedAt = Date.now();

      const delta = shares * price + fee - oldCashDelta;
      if (Number.isFinite(delta)) state.cash -= delta;
    },

    /**
     * 刪除一筆交易，帳上現金同步反向調整。
     *
     * 刪除的語意是「這筆交易沒有發生過」，因此記錄時扣掉（或加上）的現金要還回來。
     * 這與 dropTransactionsForCodes 不同——那個是「清除進出紀錄但保留持股」，
     * 屬於整理資料的意圖，不該動現金。
     *
     * 持股的股數與成本均價同樣不動，理由見 updateTransaction。
     */
    removeTransaction(state, action) {
      const id = action.payload;
      const tx = state.transactions.find((t) => t.id === id);
      if (tx) {
        const cashDelta = tx.shares * tx.price + (Number.isFinite(tx.fee) ? tx.fee : 0);
        if (Number.isFinite(cashDelta)) state.cash += cashDelta;
      }
      markDeleted(state, 'transactions', id);
      state.transactions = state.transactions.filter((t) => t.id !== id);
    },

    /**
     * 清除指定標的的全部進出紀錄，持股本身保留。
     *
     * 給「進出紀錄與持股清單對不起來」的情況收尾用。
     * 新增持股時系統會留下一筆買進紀錄，但之後直接修改股數並不會更新它，
     * 兩邊從此分家。介面上又沒有列出這些紀錄的地方，使用者無從自行修正。
     *
     * 清掉之後，該檔在權益曲線中會改用「以統計起算日建倉」的補記方式，
     * 股數與成本直接取自持股清單，兩邊必然一致。
     * 代價是該檔的歷史買賣明細不再保留，因此僅適用於沒有實際交易的標的。
     *
     * payload: string[] 代號清單
     */
    dropTransactionsForCodes(state, action) {
      const codes = new Set(action.payload ?? []);
      if (codes.size === 0) return;
      // 兩種墓碑都要立。
      //
      // id 層級涵蓋當下看得到的紀錄；代號層級涵蓋雲端可能還存在、
      // 但本機從未見過的其他 id——只立前者就會出現「清除了又出現」。
      for (const t of state.transactions) {
        if (codes.has(t.code)) markDeleted(state, 'transactions', t.id);
      }
      for (const code of codes) markDeleted(state, 'transactionCodes', code);
      state.transactions = state.transactions.filter((t) => !codes.has(t.code));
    },

    removeHolding(state, action) {
      markDeleted(state, 'holdings', action.payload);
      state.holdings = state.holdings.filter((h) => h.code !== action.payload);
    },

    updateHolding(state, action) {
      const { code, patch } = action.payload;
      const item = state.holdings.find((h) => h.code === code);
      // updatedAt 是跨裝置合併的依據。少了它，另一台裝置無從得知這份比較新，
      // 兩邊會各自保留自己的版本並互相覆蓋雲端，永遠同步不了。
      if (item) Object.assign(item, patch, { updatedAt: Date.now() });
    },

    /** 記錄一筆入金或出金。amount 正為入金、負為出金。 */
    recordCashFlow(state, action) {
      const amount = Number(action.payload.amount);
      if (!Number.isFinite(amount) || amount === 0) return;
      state.cashFlows.push({
        id: nanoid(),
        date: action.payload.date || today(),
        amount,
        note: action.payload.note ?? '',
      });
      state.cash += amount;
    },

    removeCashFlow(state, action) {
      markDeleted(state, 'cashFlows', action.payload);
      const flow = state.cashFlows.find((c) => c.id === action.payload);
      if (!flow) return;
      state.cashFlows = state.cashFlows.filter((c) => c.id !== action.payload);
      state.cash -= flow.amount;
    },

    setCash(state, action) {
      state.cash = Number(action.payload) || 0;
    },
  },
});

export const {
  hydrate,
  restorePortfolio,
  upsertHolding,
  addWatch,
  removeWatch,
  updateWatch,
  recordTrade,
  updateTransaction,
  removeTransaction,
  dropTransactionsForCodes,
  removeHolding,
  updateHolding,
  recordCashFlow,
  removeCashFlow,
  setCash,
  setStatsStartDate,
} = portfolioSlice.actions;

export default portfolioSlice.reducer;
