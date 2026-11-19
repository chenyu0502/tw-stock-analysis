import { beforeEach, describe, expect, it, vi } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';

// persistence.js 會呼叫雲端；這裡只測本機分帳號的邏輯，雲端全部替換掉。
const cloud = vi.hoisted(() => ({ savePortfolio: vi.fn(async () => {}) }));
vi.mock('../lib/firebase.js', () => ({
  loadPortfolio: vi.fn(async () => null),
  savePortfolio: cloud.savePortfolio,
  watchPortfolio: vi.fn(() => () => {}),
}));

import portfolio, { hydrate } from './portfolioSlice.js';
import auth, { setUser } from './authSlice.js';
import {
  LEGACY_STORAGE_KEY,
  createPersistenceMiddleware,
  readLocal,
  storageKeyFor,
  takeLegacyLocal,
  writeLocal,
} from './persistence.js';

function makeStore() {
  return configureStore({
    reducer: { portfolio, auth },
    middleware: (getDefault) => getDefault().concat(createPersistenceMiddleware()),
  });
}

const ALICE = { uid: 'alice', displayName: 'Alice', email: 'a@example.com', photoURL: null };

beforeEach(() => {
  localStorage.clear();
  cloud.savePortfolio.mockClear();
  vi.useRealTimers();
});

describe('本機持股按帳號分開存', () => {
  it('不同帳號各自讀寫自己的鍵，互不干擾', () => {
    writeLocal('alice', { cash: 100 });
    writeLocal('bob', { cash: 5 });
    expect(readLocal('alice')).toEqual({ cash: 100 });
    expect(readLocal('bob')).toEqual({ cash: 5 });
    expect(localStorage.getItem(storageKeyFor('alice'))).toContain('100');
  });

  it('沒有 uid 時不讀也不寫', () => {
    writeLocal(null, { cash: 1 });
    expect(localStorage.length).toBe(0);
    expect(readLocal(null)).toBeNull();
  });

  it('舊版未分帳號的資料取出後就移除（只會搬移一次）', () => {
    localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify({ cash: 42 }));
    expect(takeLegacyLocal()).toEqual({ cash: 42 });
    expect(localStorage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
    expect(takeLegacyLocal()).toBeNull();
  });
});

describe('persistence middleware', () => {
  it('還沒標記登入時 hydrate 不寫本機、也不排雲端寫入', () => {
    vi.useFakeTimers();
    const store = makeStore();
    store.dispatch(hydrate({ cash: 300 }));
    vi.advanceTimersByTime(5000);
    expect(localStorage.length).toBe(0);
    expect(cloud.savePortfolio).not.toHaveBeenCalled();
  });

  it('登入後的異動寫進這個帳號自己的鍵，並寫回這個帳號的雲端文件', () => {
    vi.useFakeTimers();
    const store = makeStore();
    store.dispatch(setUser(ALICE));
    store.dispatch(hydrate({ cash: 300 }));
    expect(readLocal('alice')).toMatchObject({ cash: 300 });
    expect(localStorage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
    vi.advanceTimersByTime(2500);
    expect(cloud.savePortfolio).toHaveBeenCalledWith('alice', expect.objectContaining({ cash: 300 }));
  });

  it('換帳號時先清 uid 再清空持股：清空的動作不會寫進前一個帳號', () => {
    vi.useFakeTimers();
    const store = makeStore();
    store.dispatch(setUser(ALICE));
    store.dispatch(hydrate({ cash: 300 }));
    vi.advanceTimersByTime(2500);
    cloud.savePortfolio.mockClear();

    // 與 src/main.jsx 的 stopSync 相同順序
    store.dispatch(setUser(null));
    store.dispatch(hydrate({}));
    vi.advanceTimersByTime(5000);

    expect(readLocal('alice')).toMatchObject({ cash: 300 });
    expect(cloud.savePortfolio).not.toHaveBeenCalled();
    expect(store.getState().portfolio.cash).toBe(0);
  });
});
