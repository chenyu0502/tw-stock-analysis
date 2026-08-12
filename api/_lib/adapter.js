/**
 * 把純函式 handler 接到 Vercel serverless function 的 (req, res) 介面上。
 */

/**
 * @param {(query: object, env: object) => Promise<{status:number, body:*}>} handler
 * @returns {(req: object, res: object) => Promise<void>}
 */
export function toVercelHandler(handler) {
  return async function vercelHandler(req, res) {
    try {
      const result = await handler(req.query ?? {}, process.env);
      // 同一交易日內資料不會變動太快，讓 Vercel Edge 快取吸收重複請求。
      res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=300');
      res.status(result.status).json(result.body);
    } catch (err) {
      res.status(502).json({ error: err?.message ?? '資料取用失敗' });
    }
  };
}
