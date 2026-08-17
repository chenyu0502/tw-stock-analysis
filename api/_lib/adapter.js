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

      if (result.noStore) {
        // AI 分析的結果依請求內容而異，快取在邊緣節點會讓不同標的拿到別人的分析。
        res.setHeader('Cache-Control', 'no-store');
      } else {
        // 同一交易日內資料不會變動太快，讓 Vercel Edge 快取吸收重複請求。
        res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=300');
      }
      res.status(result.status).json(result.body);
    } catch (err) {
      res.status(502).json({ error: err?.message ?? '資料取用失敗' });
    }
  };
}
