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
const AUTH_PATH = resolve(process.cwd(), 'api/_lib/auth.js');

/** 請求主體的大小上限，避免異常請求把 dev server 的記憶體吃光。 */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * 讀取並解析 JSON 請求主體。
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<object>}
 */
function readJsonBody(req) {
  return new Promise((resolve_, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('請求主體過大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        resolve_({});
        return;
      }
      try {
        resolve_(JSON.parse(raw));
      } catch {
        reject(new Error('請求主體不是有效的 JSON'));
      }
    });
    req.on('error', reject);
  });
}

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
          // 與正式環境（api/_lib/adapter.js）相同的登入驗證，開發時也走同一條路徑。
          const authMod = await import(pathToFileURL(AUTH_PATH).href);
          const auth = await authMod.verifyMember(req.headers.authorization, env);
          if (!auth.ok) {
            send(auth.status, { error: auth.error });
            return;
          }

          const mod = await import(pathToFileURL(HANDLERS_PATH).href);
          const handler = mod.routes[name];
          if (!handler) {
            send(404, { error: `未知的端點：${name}` });
            return;
          }

          const query = Object.fromEntries(url.searchParams.entries());
          // 正式環境由 Vercel 自動解析 JSON 主體，dev server 沒有這層，需自行讀取。
          const body = req.method === 'POST' ? await readJsonBody(req) : {};
          const ctx = { uid: auth.uid, role: auth.role, geminiKey: authMod.readGeminiKey(req.headers) };
          const result = await handler({ ...query, ...body }, env, ctx);
          send(result.status, result.body);
        } catch (err) {
          send(502, { error: err?.message ?? '資料取用失敗' });
        }
      });
    },
  };
}
