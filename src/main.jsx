import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { store } from './store/index.js';
import { watchAuth } from './lib/firebase.js';
import { setUser } from './store/authSlice.js';
import { syncFromCloud } from './store/persistence.js';
import App from './App.jsx';
import './index.css';

// 登入狀態變化時更新 store，並在登入成功後把雲端資料合併進來。
watchAuth((user) => {
  store.dispatch(setUser(user));
  if (user?.uid) syncFromCloud(store, user.uid);
});

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Provider store={store}>
      <App />
    </Provider>
  </StrictMode>
);
