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
import { tradeCost } from '../lib/fees.js';

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
};

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
    },

    addWatch(state, action) {
      const code = String(action.payload.code ?? '').trim();
      if (!code || state.watchlist.some((w) => w.code === code)) return;
      state.watchlist.push({
        code,
        note: action.payload.note ?? '',
        maShort: action.payload.maShort ?? DEFAULT_MA.short,
        maLong: action.payload.maLong ?? DEFAULT_MA.long,
        addedAt: Date.now(),
      });
    },

    removeWatch(state, action) {
      state.watchlist = state.watchlist.filter((w) => w.code !== action.payload);
    },

    updateWatch(state, action) {
      const { code, patch } = action.payload;
      const item = state.watchlist.find((w) => w.code === code);
      if (item) Object.assign(item, patch);
    },

    /**
     * 記錄一筆交易並更新持股。
     *
     * payload: { code, shares, price, date?, fee?, note? }
     * shares 正為買進、負為賣出。fee 未指定時依台股費率自動計算。
     */
    recordTrade(state, action) {
      const { code, shares, price } = action.payload;
      const date = action.payload.date || today();
      const fee = Number.isFinite(action.payload.fee)
        ? action.payload.fee
        : tradeCost({ code, shares, price }).total;

      const existing = state.holdings.find((h) => h.code === code);
      let realized = null;

      if (shares < 0) {
        // 賣出時結算已實現損益。採平均成本法，與 avgCost 的維護方式一致。
        // 無對應持股時成本無從得知，realized 留白而不是猜一個數字。
        if (existing) {
          realized = (price - existing.avgCost) * Math.abs(shares) - fee;
        }
      }

      state.transactions.push({
        id: nanoid(),
        code,
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
        state.holdings = state.holdings.filter((h) => h.code !== code);
        return;
      }
      // 買進才需要重算平均成本，並把手續費計入成本。賣出不改變剩餘部位的成本。
      if (shares > 0) {
        existing.avgCost =
          (existing.avgCost * existing.shares + price * shares + fee) / totalShares;
      }
      existing.shares = totalShares;
    },

    removeTransaction(state, action) {
      state.transactions = state.transactions.filter((t) => t.id !== action.payload);
    },

    removeHolding(state, action) {
      state.holdings = state.holdings.filter((h) => h.code !== action.payload);
    },

    updateHolding(state, action) {
      const { code, patch } = action.payload;
      const item = state.holdings.find((h) => h.code === code);
      if (item) Object.assign(item, patch);
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
  addWatch,
  removeWatch,
  updateWatch,
  recordTrade,
  removeTransaction,
  removeHolding,
  updateHolding,
  recordCashFlow,
  removeCashFlow,
  setCash,
} = portfolioSlice.actions;

export default portfolioSlice.reducer;
