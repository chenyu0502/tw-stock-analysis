import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import localApi from './vite-plugin-local-api.js';
import version, { resolveBuildId } from './vite-plugin-version.js';

/**
 * 台股分析以 Claude Flow 的 /stock/ 路徑上線：Claude Flow 的 vercel.json 把 /stock/* 與 /api/*
 * 轉送到這個專案。所以網站本身也放在 /stock/ 底下（base 與輸出目錄），兩邊的路徑才對得上。
 */
export default defineConfig(({ mode }) => {
  // 第三個參數傳空字串代表載入全部環境變數，包含沒有 VITE_ 前綴的伺服器端變數
  // （FINMIND_TOKEN、GEMINI_API_KEY）。它們只交給 api/ 中介層使用，不會進到前端 bundle。
  const env = loadEnv(mode, process.cwd(), '');
  const buildId = resolveBuildId();
  const devPort = 5174;

  return {
    base: '/stock/',
    plugins: [react(), tailwindcss(), localApi(env), version(buildId)],
    // 新版偵測：編譯進 bundle 的版本識別碼，與伺服器上的 /stock/version.json 比對。
    // __STOCK_DEV_PORT__：直接打開這個 port 代表單獨開發台股（沒有 Claude Flow），見 src/claudeFlow/entry.js。
    define: { __BUILD_ID__: JSON.stringify(buildId), __STOCK_DEV_PORT__: JSON.stringify(String(devPort)) },
    // 5174：可以和 Claude Flow 的開發伺服器（5173）同時開著，Claude Flow 會把 /stock、/api 轉送過來。
    server: { port: devPort, strictPort: true },
    build: {
      outDir: 'dist/stock',
      emptyOutDir: true,
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
    test: {
      globals: true,
      environment: 'jsdom',
      include: ['src/**/*.test.{js,jsx}', 'api/**/*.test.js'],
    },
  };
});
