/**
 * 市場資料的快取狀態。
 *
 * 這裡存的都是可重新取得的衍生資料，不需要同步到雲端，也不寫入 localStorage。
 */

import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import * as api from '../services/stockApi.js';

/** 載入多檔即時報價。 */
export const loadQuotes = createAsyncThunk('market/loadQuotes', async (codes) =>
  api.fetchQuotes(codes)
);

/** 載入單檔歷史 K 線。 */
export const loadHistory = createAsyncThunk('market/loadHistory', async ({ code, range }) => {
  const data = await api.fetchHistory(code, { range });
  return { code, data };
});

/** 載入單檔的三大法人買賣超歷史序列。 */
export const loadInstitutionalHistory = createAsyncThunk(
  'market/loadInstitutionalHistory',
  async ({ code, days = 30 }) => {
    const data = await api.fetchInstitutionalHistory(code, days);
    return { code, data };
  }
);

/** 一次載入融資融券、三大法人、估值三項每日更新的資料。 */
export const loadDailyStats = createAsyncThunk('market/loadDailyStats', async (codes) => {
  // 三個端點互不相依，並行取用。任一失敗不應拖垮其他兩項，因此用 allSettled。
  const [margin, institutional, valuation] = await Promise.allSettled([
    api.fetchMargin(codes),
    api.fetchInstitutional(codes),
    api.fetchValuation(codes),
  ]);
  return {
    margin: margin.status === 'fulfilled' ? margin.value.items : {},
    institutional: institutional.status === 'fulfilled' ? institutional.value.items : {},
    valuation: valuation.status === 'fulfilled' ? valuation.value.items : {},
  };
});

const initialState = {
  quotes: {},
  history: {},
  margin: {},
  institutional: {},
  /** 各檔的法人買賣超歷史，鍵為代號，值為 { available, series, reason } */
  institutionalHistory: {},
  valuation: {},
  loading: { quotes: false, history: false, daily: false, chips: false },
  error: null,
  lastQuoteAt: null,
};

const marketSlice = createSlice({
  name: 'market',
  initialState,
  reducers: {
    clearError(state) {
      state.error = null;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(loadQuotes.pending, (state) => {
        state.loading.quotes = true;
      })
      .addCase(loadQuotes.fulfilled, (state, action) => {
        state.loading.quotes = false;
        Object.assign(state.quotes, action.payload.quotes);
        state.lastQuoteAt = Date.now();
      })
      .addCase(loadQuotes.rejected, (state, action) => {
        state.loading.quotes = false;
        state.error = action.error.message;
      })

      .addCase(loadHistory.pending, (state) => {
        state.loading.history = true;
      })
      .addCase(loadHistory.fulfilled, (state, action) => {
        state.loading.history = false;
        state.history[action.payload.code] = action.payload.data;
      })
      .addCase(loadHistory.rejected, (state, action) => {
        state.loading.history = false;
        state.error = action.error.message;
      })

      .addCase(loadInstitutionalHistory.pending, (state) => {
        state.loading.chips = true;
      })
      .addCase(loadInstitutionalHistory.fulfilled, (state, action) => {
        state.loading.chips = false;
        state.institutionalHistory[action.payload.code] = action.payload.data;
      })
      .addCase(loadInstitutionalHistory.rejected, (state, action) => {
        state.loading.chips = false;
        // 法人歷史屬於加值資訊，取不到時記錄於該檔自身，
        // 不寫進全域 error，避免蓋掉更重要的報價錯誤訊息。
        state.institutionalHistory[action.meta.arg.code] = {
          available: false,
          reason: action.error.message,
          series: [],
        };
      })

      .addCase(loadDailyStats.pending, (state) => {
        state.loading.daily = true;
      })
      .addCase(loadDailyStats.fulfilled, (state, action) => {
        state.loading.daily = false;
        Object.assign(state.margin, action.payload.margin);
        Object.assign(state.institutional, action.payload.institutional);
        Object.assign(state.valuation, action.payload.valuation);
      })
      .addCase(loadDailyStats.rejected, (state, action) => {
        state.loading.daily = false;
        state.error = action.error.message;
      });
  },
});

export const { clearError } = marketSlice.actions;
export default marketSlice.reducer;
