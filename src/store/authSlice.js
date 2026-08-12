/**
 * 登入狀態。
 *
 * 只保存顯示所需的欄位，不整包存 Firebase User 物件，
 * 因為它含有不可序列化的方法，會觸發 Redux 的序列化檢查警告。
 */

import { createSlice } from '@reduxjs/toolkit';

const initialState = {
  user: null,
  /** 初始化完成前為 true，用於避免畫面閃現未登入狀態。 */
  initializing: true,
  error: null,
};

const authSlice = createSlice({
  name: 'auth',
  initialState,
  reducers: {
    setUser(state, action) {
      const user = action.payload;
      state.user = user
        ? { uid: user.uid, displayName: user.displayName, email: user.email, photoURL: user.photoURL }
        : null;
      state.initializing = false;
    },
    setAuthError(state, action) {
      state.error = action.payload;
      state.initializing = false;
    },
  },
});

export const { setUser, setAuthError } = authSlice.actions;
export default authSlice.reducer;
