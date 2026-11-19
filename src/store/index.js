import { configureStore } from '@reduxjs/toolkit';
import portfolio from './portfolioSlice.js';
import market from './marketSlice.js';
import auth from './authSlice.js';
import { createPersistenceMiddleware } from './persistence.js';

export const store = configureStore({
  reducer: { portfolio, market, auth },
  middleware: (getDefault) => getDefault().concat(createPersistenceMiddleware()),
});

// 本機資料按帳號分開存，要等確認是哪個帳號登入後才還原（見 src/stock/main.jsx 的 startSync）。
