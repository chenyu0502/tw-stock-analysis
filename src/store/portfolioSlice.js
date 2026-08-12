/**
 * 感興趣標的與持股部位的狀態管理。
 *
 * 這份 state 是使用者資料的唯一真實來源，會同步到 localStorage 與 Firestore。
 */

import { createSlice } from '@reduxjs/toolkit';

/** 均線天數的預設值，可由使用者調整或由回測最佳化覆寫。 */
export const DEFAULT_MA = { short: 20, long: 60 };

const initialState = {
  /** 感興趣標的：{ code, note, maShort, maLong, addedAt } */
  watchlist: [],
  /** 持股部位：{ code, shares, avgCost, note, maShort, maLong, addedAt } */
  holdings: [],
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

    /** 新增或加碼持股。已有部位時以加權平均重算成本。 */
    upsertHolding(state, action) {
      const { code, shares, price } = action.payload;
      const existing = state.holdings.find((h) => h.code === code);

      if (!existing) {
        state.holdings.push({
          code,
          shares,
          avgCost: price,
          note: action.payload.note ?? '',
          maShort: action.payload.maShort ?? DEFAULT_MA.short,
          maLong: action.payload.maLong ?? DEFAULT_MA.long,
          addedAt: Date.now(),
        });
        return;
      }

      const totalShares = existing.shares + shares;
      if (totalShares <= 0) {
        // 全數賣出視為出清部位。
        state.holdings = state.holdings.filter((h) => h.code !== code);
        return;
      }
      // 賣出不改變平均成本，只有買進才需要重算。
      if (shares > 0) {
        existing.avgCost = (existing.avgCost * existing.shares + price * shares) / totalShares;
      }
      existing.shares = totalShares;
    },

    removeHolding(state, action) {
      state.holdings = state.holdings.filter((h) => h.code !== action.payload);
    },

    updateHolding(state, action) {
      const { code, patch } = action.payload;
      const item = state.holdings.find((h) => h.code === code);
      if (item) Object.assign(item, patch);
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
  upsertHolding,
  removeHolding,
  updateHolding,
  setCash,
} = portfolioSlice.actions;

export default portfolioSlice.reducer;
