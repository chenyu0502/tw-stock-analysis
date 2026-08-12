/**
 * 開發模式的 API 中介層。
 *
 * 正式環境由 Vercel 把 api/*.js 部署成 serverless function，本機 vite dev 沒有這層，
 * 這個外掛把同一批 handler 掛在 dev server 的 /api/* 路徑上，
 * 讓開發與正式環境走完全相同的程式碼路徑，避免只在其中一邊會壞的問題。
 */

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const HANDLERS_PATH = resolve(process.cwd(), 'api/_lib/handlers.js');

/**
 * @param {Record<string, string>} env 由 vite loadEnv 讀入的環境變數
 * @returns {import('vite').Plugin}
 */
export default function localApiPlugin(env = {}) {
  return {
    name: 'local-api',
    configureServer(server) {
      // api/ 底下的檔案異動一律重啟 dev server。
      //
      // 曾試過以 import 查詢字串做模組版本控制，但那只會換掉 handlers.js 本身，
      // 它相依的 cache.js 仍是舊實例，記憶體快取會把修正前的錯誤資料留下來，
      // 造成「程式碼已改好但 API 仍回傳舊結果」的假象。整個重啟才是可靠做法。
      server.watcher.add(HANDLERS_PATH);
      server.watcher.on('change', (file) => {
        if (file.replace(/\\/g, '/').includes('/api/')) {
          server.restart();
        }
      });

      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api/')) return next();

        const url = new URL(req.url, 'http://localhost');
        const name = url.pathname.replace(/^\/api\//, '').replace(/\/$/, '');

        const send = (status, payload) => {
          res.statusCode = status;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify(payload));
        };

        try {
          const mod = await import(pathToFileURL(HANDLERS_PATH).href);
          const handler = mod.routes[name];
          if (!handler) {
            send(404, { error: `未知的端點：${name}` });
            return;
          }

          const query = Object.fromEntries(url.searchParams.entries());
          const result = await handler(query, env);
          send(result.status, result.body);
        } catch (err) {
          send(502, { error: err?.message ?? '資料取用失敗' });
        }
      });
    },
  };
}
