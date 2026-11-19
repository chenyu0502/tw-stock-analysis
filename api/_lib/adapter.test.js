// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { toVercelHandler } from './adapter.js';

/** 最小化的 Vercel res 替身，記錄狀態碼、標頭與主體。 */
function mockRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: undefined,
    setHeader(k, v) {
      res.headers[k] = v;
    },
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(b) {
      res.body = b;
      return res;
    },
  };
  return res;
}

describe('toVercelHandler 的登入驗證', () => {
  it('驗證失敗 → 回傳驗證錯誤、不快取，且不執行 handler', async () => {
    const handler = vi.fn();
    const verify = vi.fn(async () => ({ ok: false, status: 401, error: '請先登入' }));
    const res = mockRes();
    await toVercelHandler(handler, { verify })({ headers: {}, query: { code: '2330' } }, res);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: '請先登入' });
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(handler).not.toHaveBeenCalled();
  });

  it('把 Authorization 標頭交給驗證函式', async () => {
    const verify = vi.fn(async () => ({ ok: false, status: 403, error: 'x' }));
    await toVercelHandler(vi.fn(), { verify })({ headers: { authorization: 'Bearer t' } }, mockRes());
    expect(verify.mock.calls[0][0]).toBe('Bearer t');
  });

  it('驗證通過 → 執行 handler，成功回應只允許瀏覽器快取（不能用邊緣快取 s-maxage）', async () => {
    const handler = vi.fn(async (input) => ({ status: 200, body: { echo: input.code } }));
    const verify = vi.fn(async () => ({ ok: true, uid: 'admin' }));
    const res = mockRes();
    await toVercelHandler(handler, { verify })({ headers: {}, query: { code: '2330' } }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ echo: '2330' });
    expect(res.headers['Cache-Control']).toBe('private, max-age=30');
    expect(res.headers['Cache-Control']).not.toMatch(/s-maxage/);
  });

  it('把已驗證的使用者與他自己的 Gemini 金鑰交給 handler', async () => {
    const handler = vi.fn(async () => ({ status: 200, body: {} }));
    const verify = vi.fn(async () => ({ ok: true, uid: 'bob', role: 'user' }));
    const key = 'AIzaSyA1234567890abcdefghij_-XYZ';
    await toVercelHandler(handler, { verify })({ headers: { 'x-gemini-key': key }, body: {} }, mockRes());
    expect(handler.mock.calls[0][2]).toEqual({ uid: 'bob', role: 'user', geminiKey: key });
  });

  it('沒帶 Gemini 金鑰時 geminiKey 為 null', async () => {
    const handler = vi.fn(async () => ({ status: 200, body: {} }));
    const verify = vi.fn(async () => ({ ok: true, uid: 'bob', role: 'user' }));
    await toVercelHandler(handler, { verify })({ headers: {} }, mockRes());
    expect(handler.mock.calls[0][2].geminiKey).toBeNull();
  });
});
