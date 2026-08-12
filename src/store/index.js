import { configureStore } from '@reduxjs/toolkit';
import portfolio, { hydrate } from './portfolioSlice.js';
import market from './marketSlice.js';
import auth from './authSlice.js';
import { createPersistenceMiddleware, readLocal } from './persistence.js';

export const store = configureStore({
  reducer: { portfolio, market, auth },
  middleware: (getDefault) => getDefault().concat(createPersistenceMiddleware()),
});

// 啟動時先還原本機資料，登入後才會再與雲端合併。
const local = readLocal();
if (local) store.dispatch(hydrate(local));
