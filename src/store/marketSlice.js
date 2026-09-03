/**
 * 市場資料的快取狀態。
 *
 * 這裡存的都是可重新取得的衍生資料，不需要同步到雲端，也不寫入 localStorage。
 */

import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import * as api from '../services/stockApi.js';
import { today } from './portfolioSlice.js';

/**
 * 這份日 K 是否該重抓。
 *
 * **日 K 原本只在「尚未載入」時抓，一整個分頁生命週期都不會更新。**
 * 應用程式開著跨過換日就會出事，而且症狀不像資料過期：
 *
 * 1. 曲線最後一天停在昨天，於是月曆**今天那格根本不存在**。
 * 2. 昨天那根 K 棒是昨天盤中抓的，收盤價其實是當時的盤中價，
 *    不是官方收盤價，於是**昨天那格的數字是錯的**。
 *
 * 同一時間「今日損益」用的是會自己更新的即時報價，兩邊因此對不起來。
 *
 * @param {{loadedOn?: string}|undefined} entry
 * @returns {boolean}
 */
export function isHistoryStale(entry) {
  return !entry || entry.loadedOn !== today();
}

/** 載入多檔即時報價。 */
export const loadQuotes = createAsyncThunk('market/loadQuotes', async (codes) =>
  api.fetchQuotes(codes)
);

/**
 * 載入單檔歷史 K 線。
 *
 * `condition` 擋掉同一檔正在進行中的重複請求。守衛條件是「資料還沒進 store」，
 * 而在第一個回應回來之前那個條件對每個元件都成立——實測十檔會送出四十四次請求，
 * 全部擠在 0.35 秒內。這正是先前把 /api/history 打到 504 的那種併發形狀。
 */
export const loadHistory = createAsyncThunk(
  'market/loadHistory',
  async ({ code, range }) => {
    const data = await api.fetchHistory(code, { range });
    return { code, data };
  },
  {
    condition: ({ code }, { getState }) => !getState().market.historyPending[code],
  }
);

/** 載入單檔的三大法人買賣超歷史序列。 */
export const loadInstitutionalHistory = createAsyncThunk(
  'market/loadInstitutionalHistory',
  async ({ code, days = 30 }) => {
    const data = await api.fetchInstitutionalHistory(code, days);
    return { code, data };
  }
);

/** 載入單檔的基本面深度指標。伺服器快取 24 小時，前端只在未載入時取用。 */
export const loadFundamentals = createAsyncThunk(
  'market/loadFundamentals',
  async ({ code }) => {
    const data = await api.fetchFundamentals(code);
    return { code, data };
  }
);

/**
 * 載入即將除權息的清單。
 *
 * 全市場只需一次請求，因此不帶參數也不分代號快取，
 * 由使用端自行比對自己關心的標的。
 */
export const loadExDividend = createAsyncThunk('market/loadExDividend', async () =>
  api.fetchExDividend()
);

/**
 * 載入加權指數與櫃買指數。
 *
 * 全市場共用，與持股清單無關，因此不帶參數。
 */
export const loadMarketIndices = createAsyncThunk(
  'market/loadMarketIndices',
  async ({ withCandles = true } = {}) => api.fetchMarketIndices({ withCandles })
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
  /** 各檔的基本面深度指標，鍵為代號，值為 { available, bands, revenue, income, ... } */
  fundamentals: {},
  /**
   * 即將除權息的標的，鍵為代號，值為該檔最近一次的 { date, cash, stock, kind }。
   * 同一檔在公告區間內可能有多筆（月配 ETF），只留最近的那一次。
   */
  exDividend: {},
  /** 大盤指數，鍵為 TAIEX / TPEX，值含即時報價與日 K。 */
  indices: {},
  /** 即時指數取用失敗的訊息。日 K 仍可能是好的，因此與 error 分開存。 */
  indicesQuoteError: null,
  /** 正在請求中的日 K 代號，用於擋掉重複請求。 */
  historyPending: {},
  loading: {
    quotes: false,
    history: false,
    daily: false,
    chips: false,
    fundamentals: false,
    indices: false,
  },
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

      .addCase(loadHistory.pending, (state, action) => {
        state.loading.history = true;
        state.historyPending[action.meta.arg.code] = true;
      })
      .addCase(loadHistory.fulfilled, (state, action) => {
        state.loading.history = false;
        delete state.historyPending[action.payload.code];
        // 記下抓取當天的日期，換日後才知道這份要重抓。見 isHistoryStale。
        state.history[action.payload.code] = { ...action.payload.data, loadedOn: today() };
      })
      .addCase(loadHistory.rejected, (state, action) => {
        state.loading.history = false;
        // 失敗也要清掉，否則這一檔在整個分頁生命週期內都不會再重試。
        delete state.historyPending[action.meta.arg.code];
        state.error = action.error.message;
      })

      .addCase(loadMarketIndices.pending, (state) => {
        state.loading.indices = true;
      })
      .addCase(loadMarketIndices.fulfilled, (state, action) => {
        state.loading.indices = false;
        // 日 K 拿到了但即時指數沒拿到，端點仍然算成功。這種半成功要留下訊息，
        // 否則畫面只會顯示一片空白的指數，看不出是上游取不到。
        state.indicesQuoteError = action.payload.quoteError ?? null;
        // 只更新報價的那幾次不會帶 K 線，要保留既有的，否則展開中的圖會清空。
        const next = action.payload.indices ?? {};
        for (const [id, value] of Object.entries(next)) {
          const candles = value.candles?.length ? value.candles : (state.indices[id]?.candles ?? []);
          state.indices[id] = { ...value, candles };
        }
      })
      .addCase(loadMarketIndices.rejected, (state) => {
        // 大盤只是參考資訊，取不到就不顯示，不蓋掉報價的錯誤訊息。
        state.loading.indices = false;
      })

      .addCase(loadExDividend.fulfilled, (state, action) => {
        // 上游已依日期排序，先到的即為最近一次，因此同一檔只寫入第一筆。
        const map = {};
        for (const item of action.payload.items ?? []) {
          if (!map[item.code]) map[item.code] = item;
        }
        state.exDividend = map;
      })
      .addCase(loadExDividend.rejected, (state) => {
        // 除息提醒是加值資訊，取不到就不顯示，不打斷其他功能也不蓋掉報價錯誤訊息。
        state.exDividend = {};
      })

      .addCase(loadFundamentals.pending, (state) => {
        state.loading.fundamentals = true;
      })
      .addCase(loadFundamentals.fulfilled, (state, action) => {
        state.loading.fundamentals = false;
        state.fundamentals[action.payload.code] = action.payload.data;
      })
      .addCase(loadFundamentals.rejected, (state, action) => {
        state.loading.fundamentals = false;
        // 基本面屬於加值資訊，取不到時記錄於該檔自身，
        // 不寫進全域 error，避免蓋掉更重要的報價錯誤訊息。
        state.fundamentals[action.meta.arg.code] = {
          available: false,
          reason: action.error.message,
        };
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
