import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { store } from './store/index.js';
import { watchAuth } from './lib/firebase.js';
import { setUser } from './store/authSlice.js';
import { syncFromCloud, subscribeToCloud } from './store/persistence.js';
import App from './App.jsx';
import './index.css';

// 登入狀態變化時更新 store，並在登入成功後把雲端資料合併進來。
//
// 初次同步之後開始訂閱雲端變更，另一台裝置改了什麼這台就會即時跟上。
// 先同步再訂閱是刻意的：初次同步會把本機獨有的資料回寫雲端，
// 兩者同時進行會讓合併在兩條路徑上交錯，難以推理。
let unsubscribeCloud = null;

watchAuth((user) => {
  store.dispatch(setUser(user));

  // 登出或換人時一定要收掉，否則舊帳號的快照會繼續灌進新的 state。
  unsubscribeCloud?.();
  unsubscribeCloud = null;

  if (!user?.uid) return;
  const { uid } = user;
  syncFromCloud(store, uid).then(() => {
    // 同步期間可能又登出或換了帳號，確認還是同一個人才訂閱。
    if (store.getState().auth.user?.uid !== uid) return;
    unsubscribeCloud = subscribeToCloud(store, uid);
  });
});

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Provider store={store}>
      <App />
    </Provider>
  </StrictMode>
);
