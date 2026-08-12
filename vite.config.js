import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import localApi from './vite-plugin-local-api.js';

export default defineConfig(({ mode }) => {
  // 第三個參數傳空字串代表載入全部環境變數，包含沒有 VITE_ 前綴的伺服器端變數
  // （例如 FINMIND_TOKEN）。這些變數只交給 API 中介層使用，不會進到前端 bundle。
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [react(), tailwindcss(), localApi(env)],
    server: {
      port: 5173,
      open: true,
    },
    build: {
      outDir: 'dist',
      // 圖表與 Excel 函式庫體積大，切開讓首屏只載入必要的部分。
      rollupOptions: {
        output: {
          manualChunks: {
            react: ['react', 'react-dom', 'react-redux', '@reduxjs/toolkit'],
            charts: ['recharts'],
            firebase: ['firebase/app', 'firebase/auth', 'firebase/firestore'],
            xlsx: ['xlsx'],
          },
        },
      },
    },
  };
});
