/**
 * 把純函式 handler 接到 Vercel serverless function 的 (req, res) 介面上。
 */

/**
 * @param {(input: object, env: object) => Promise<{status:number, body:*, noStore?:boolean}>} handler
 * @returns {(req: object, res: object) => Promise<void>}
 */
export function toVercelHandler(handler) {
  return async function vercelHandler(req, res) {
    try {
      // 查詢字串與請求主體合併成單一輸入物件，handler 不需要區分兩者的來源。
      // Vercel 會依 Content-Type 自動解析 JSON 主體。
      const body = typeof req.body === 'object' && req.body !== null ? req.body : {};
      const result = await handler({ ...(req.query ?? {}), ...body }, process.env);

      if (result.noStore || result.status >= 400) {
        // AI 分析的結果依請求內容而異，快取在邊緣節點會讓不同標的拿到別人的分析。
        //
        // 失敗的回應同樣不能快取。先前所有回應一律帶 s-maxage=30 與
        // stale-while-revalidate=300，於是上游一次抽風，那個壞掉的結果會被
        // 邊緣節點重複供應最長五分鐘——使用者重新整理也沒用，看起來像壞掉很久。
        res.setHeader('Cache-Control', 'no-store');
      } else {
        // 同一交易日內資料不會變動太快，讓 Vercel Edge 快取吸收重複請求。
        res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=300');
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
