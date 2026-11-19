/**
 * 把純函式 handler 接到 Vercel serverless function 的 (req, res) 介面上。
 */

import { readGeminiKey, verifyMember } from './auth.js';

/**
 * handler 的第三個參數：已驗證的使用者與他自己的 Gemini 金鑰（沒帶時為 null）。
 * @typedef {{ uid: string, role: string, geminiKey: string|null }} RequestContext
 */

/**
 * @param {(input: object, env: object, ctx: RequestContext) => Promise<{status:number, body:*, noStore?:boolean}>} handler
 * @param {{ verify?: typeof verifyMember }} [options] 測試用：替換驗證函式
 * @returns {(req: object, res: object) => Promise<void>}
 */
export function toVercelHandler(handler, { verify = verifyMember } = {}) {
  return async function vercelHandler(req, res) {
    // 每個端點都只開放給登入且未停用的 Claude Flow 使用者，驗證放在最前面，
    // handler 一律不會被未授權的請求執行。
    const auth = await verify(req.headers?.authorization, process.env);
    if (!auth.ok) {
      res.setHeader('Cache-Control', 'no-store');
      res.status(auth.status).json({ error: auth.error });
      return;
    }

    try {
      // 查詢字串與請求主體合併成單一輸入物件，handler 不需要區分兩者的來源。
      // Vercel 會依 Content-Type 自動解析 JSON 主體。
      const body = typeof req.body === 'object' && req.body !== null ? req.body : {};
      const ctx = { uid: auth.uid, role: auth.role, geminiKey: readGeminiKey(req.headers) };
      const result = await handler({ ...(req.query ?? {}), ...body }, process.env, ctx);

      if (result.noStore || result.status >= 400) {
        // AI 分析的結果依請求內容而異，快取在邊緣節點會讓不同標的拿到別人的分析。
        //
        // 失敗的回應同樣不能快取。先前所有回應一律帶 s-maxage=30 與
        // stale-while-revalidate=300，於是上游一次抽風，那個壞掉的結果會被
        // 邊緣節點重複供應最長五分鐘——使用者重新整理也沒用，看起來像壞掉很久。
        res.setHeader('Cache-Control', 'no-store');
      } else {
        // 只允許瀏覽器快取（private），不能再用 s-maxage 讓 Vercel 邊緣節點快取：
        // 邊緣快取命中的請求根本不會進到這個函式，等於繞過上面的登入驗證，
        // 任何人打同一個網址都能拿到快取內容。
        res.setHeader('Cache-Control', 'private, max-age=30');
      }
      res.status(result.status).json(result.body);
    } catch (err) {
      // 這一條也要標成不可快取。上游拋錯是最常見的失敗路徑，
      // 少了這行就沒有任何 Cache-Control，等於把失敗交給邊緣節點自行決定要留多久。
      res.setHeader('Cache-Control', 'no-store');
      res.status(502).json({ error: err?.message ?? '資料取用失敗' });
    }
  };
}
