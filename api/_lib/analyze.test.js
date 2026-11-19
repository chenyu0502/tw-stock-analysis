// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { NEED_USER_KEY, analyzeHandler, resolveGeminiKey } from './analyze.js';

const SERVER = { GEMINI_API_KEY: 'server-key-0123456789abcdef' };
const USER_KEY = 'AIzaSyA1234567890abcdefghij_-XYZ';

describe('resolveGeminiKey', () => {
  it('有帶自己的金鑰 → 用自己的（不論是不是管理員）', () => {
    expect(resolveGeminiKey(SERVER, { role: 'user', geminiKey: USER_KEY })).toEqual({ apiKey: USER_KEY, source: 'user' });
    expect(resolveGeminiKey(SERVER, { role: 'admin', geminiKey: USER_KEY })).toEqual({ apiKey: USER_KEY, source: 'user' });
  });

  it('一般使用者沒帶金鑰 → 不能用，絕不動用伺服器的金鑰', () => {
    expect(resolveGeminiKey(SERVER, { role: 'user', geminiKey: null })).toBeNull();
    expect(resolveGeminiKey(SERVER, {})).toBeNull();
    expect(resolveGeminiKey(SERVER)).toBeNull();
  });

  it('管理員沒帶金鑰 → 退用伺服器的 GEMINI_API_KEY；伺服器也沒設定時不能用', () => {
    expect(resolveGeminiKey(SERVER, { role: 'admin', geminiKey: null })).toEqual({
      apiKey: SERVER.GEMINI_API_KEY,
      source: 'server',
    });
    expect(resolveGeminiKey({}, { role: 'admin', geminiKey: null })).toBeNull();
  });
});

describe('analyzeHandler', () => {
  it('一般使用者沒帶金鑰 → 回傳「請先設定」與代碼，不打 Gemini', async () => {
    const result = await analyzeHandler({ code: '2330', price: 100 }, SERVER, { role: 'user', geminiKey: null });
    expect(result.status).toBe(200);
    expect(result.noStore).toBe(true);
    expect(result.body).toMatchObject({ available: false, code: NEED_USER_KEY });
    expect(result.body.reason).toMatch(/Gemini API Key/);
  });
});
