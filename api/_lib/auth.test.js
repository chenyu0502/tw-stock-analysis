// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAuthCache, readGeminiKey, verifyMember } from './auth.js';

const ENV = { VITE_FIREBASE_PROJECT_ID: 'demo-proj' };

/** 產生一個（未簽章的）測試用 JWT。真正的簽章驗證由 Firestore 負責，這裡只需要 payload。 */
function makeToken(payload) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'none' })}.${enc(payload)}.sig`;
}

const future = () => Math.floor(Date.now() / 1000) + 3600;
const validToken = (uid = 'alice') => makeToken({ user_id: uid, sub: uid, exp: future() });

/** 模擬 Firestore REST 的 users/{uid} 回應。 */
function firestoreReturns(status, fields) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ fields }),
  }));
}

const adminFields = { role: { stringValue: 'admin' }, disabled: { booleanValue: false } };

beforeEach(() => {
  clearAuthCache();
});

describe('verifyMember', () => {
  it('沒有 Authorization 標頭 → 401，不打 Firestore', async () => {
    const f = firestoreReturns(200, adminFields);
    expect(await verifyMember(undefined, ENV, f)).toEqual({ ok: false, status: 401, error: '請先登入' });
    expect(await verifyMember('Basic abc', ENV, f)).toMatchObject({ ok: false, status: 401 });
    expect(f).not.toHaveBeenCalled();
  });

  it('token 格式錯誤 → 401', async () => {
    const f = firestoreReturns(200, adminFields);
    expect(await verifyMember('Bearer not-a-jwt', ENV, f)).toMatchObject({ ok: false, status: 401 });
    expect(await verifyMember(`Bearer ${makeToken({ exp: future() })}`, ENV, f)).toMatchObject({
      ok: false,
      status: 401,
    });
    expect(f).not.toHaveBeenCalled();
  });

  it('token 已過期 → 401，不打 Firestore', async () => {
    const f = firestoreReturns(200, adminFields);
    const expired = makeToken({ user_id: 'alice', exp: Math.floor(Date.now() / 1000) - 10 });
    expect(await verifyMember(`Bearer ${expired}`, ENV, f)).toMatchObject({ ok: false, status: 401 });
    expect(f).not.toHaveBeenCalled();
  });

  it('未設定專案 ID → 500', async () => {
    const f = firestoreReturns(200, adminFields);
    expect(await verifyMember(`Bearer ${validToken()}`, {}, f)).toMatchObject({ ok: false, status: 500 });
  });

  it('管理員 → 通過並回傳 role，用使用者自己的 token 讀 users/{uid}', async () => {
    const f = firestoreReturns(200, adminFields);
    const token = validToken('alice');
    expect(await verifyMember(`Bearer ${token}`, ENV, f)).toEqual({ ok: true, uid: 'alice', role: 'admin' });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe(
      'https://firestore.googleapis.com/v1/projects/demo-proj/databases/(default)/documents/users/alice',
    );
    expect(init.headers.Authorization).toBe(`Bearer ${token}`);
  });

  it('VITE_USE_EMULATOR=true 時改連本機 Emulator', async () => {
    const f = firestoreReturns(200, adminFields);
    await verifyMember(`Bearer ${validToken()}`, { ...ENV, VITE_USE_EMULATOR: 'true' }, f);
    expect(f.mock.calls[0][0]).toMatch(/^http:\/\/127\.0\.0\.1:8080\/v1\/projects\/demo-proj\//);
  });

  it('一般使用者 → 通過，role 為 user（台股已開放給所有登入的人）', async () => {
    const f = firestoreReturns(200, { role: { stringValue: 'user' }, disabled: { booleanValue: false } });
    expect(await verifyMember(`Bearer ${validToken('bob')}`, ENV, f)).toEqual({ ok: true, uid: 'bob', role: 'user' });
  });

  it('不認得的 role 一律當成 user，不會被當成管理員', async () => {
    const f = firestoreReturns(200, { role: { stringValue: 'superuser' }, disabled: { booleanValue: false } });
    expect(await verifyMember(`Bearer ${validToken()}`, ENV, f)).toMatchObject({ ok: true, role: 'user' });
  });

  it('已停用（一般使用者或管理員）→ 403', async () => {
    for (const role of ['user', 'admin']) {
      clearAuthCache();
      const f = firestoreReturns(200, { role: { stringValue: role }, disabled: { booleanValue: true } });
      expect(await verifyMember(`Bearer ${validToken()}`, ENV, f)).toMatchObject({ ok: false, status: 403 });
    }
  });

  it('缺 disabled 欄位 → 403（視為停用，與 Security Rules 一致）', async () => {
    const f = firestoreReturns(200, { role: { stringValue: 'admin' } });
    expect(await verifyMember(`Bearer ${validToken()}`, ENV, f)).toMatchObject({ ok: false, status: 403 });
  });

  it('Firestore 拒絕 token（偽造或不屬於此 uid）→ 401 / 403', async () => {
    expect(await verifyMember(`Bearer ${validToken()}`, ENV, firestoreReturns(401))).toMatchObject({
      ok: false,
      status: 401,
    });
    expect(await verifyMember(`Bearer ${validToken()}`, ENV, firestoreReturns(403))).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it('沒有 users 文件 → 403', async () => {
    expect(await verifyMember(`Bearer ${validToken()}`, ENV, firestoreReturns(404))).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it('Firestore 連不上或出錯 → 503（拒絕，不放行）', async () => {
    const down = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(await verifyMember(`Bearer ${validToken()}`, ENV, down)).toMatchObject({ ok: false, status: 503 });
    expect(await verifyMember(`Bearer ${validToken()}`, ENV, firestoreReturns(500))).toMatchObject({
      ok: false,
      status: 503,
    });
  });

  it('驗證通過的結果會快取，同一個 token 不再重打 Firestore', async () => {
    const f = firestoreReturns(200, adminFields);
    const header = `Bearer ${validToken()}`;
    await verifyMember(header, ENV, f);
    await verifyMember(header, ENV, f);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('被拒絕的結果不快取', async () => {
    const f = firestoreReturns(200, { role: { stringValue: 'user' }, disabled: { booleanValue: true } });
    const header = `Bearer ${validToken()}`;
    await verifyMember(header, ENV, f);
    await verifyMember(header, ENV, f);
    expect(f).toHaveBeenCalledTimes(2);
  });
});

describe('Email 驗證', () => {
  const tokenWith = (extra) => makeToken({ user_id: 'alice', sub: 'alice', exp: future(), ...extra });

  it('只用 Email/密碼且未驗證信箱 → 403，不打 Firestore', async () => {
    const f = firestoreReturns(200, adminFields);
    const token = tokenWith({ email_verified: false, firebase: { identities: { email: ['a@x.tw'] } } });
    expect(await verifyMember(`Bearer ${token}`, ENV, f)).toEqual({
      ok: false,
      status: 403,
      error: '請先完成 Email 驗證',
    });
    expect(f).not.toHaveBeenCalled();
  });

  it('Email/密碼已驗證 → 通過', async () => {
    const f = firestoreReturns(200, adminFields);
    const token = tokenWith({ email_verified: true, firebase: { identities: { email: ['a@x.tw'] } } });
    expect(await verifyMember(`Bearer ${token}`, ENV, f)).toMatchObject({ ok: true });
  });

  it('GitHub 帳號 email_verified 為 false 仍通過（信箱由 GitHub 驗證）', async () => {
    const f = firestoreReturns(200, adminFields);
    const token = tokenWith({
      email_verified: false,
      firebase: { identities: { 'github.com': ['1'], email: ['a@x.tw'] } },
    });
    expect(await verifyMember(`Bearer ${token}`, ENV, f)).toMatchObject({ ok: true });
  });
});

describe('readGeminiKey', () => {
  const key = 'AIzaSyA1234567890abcdefghij_-XYZ';

  it('讀取 X-Gemini-Key 標頭（Node 會把標頭名稱轉成小寫）', () => {
    expect(readGeminiKey({ 'x-gemini-key': key })).toBe(key);
    expect(readGeminiKey({ 'x-gemini-key': `  ${key}  ` })).toBe(key);
    expect(readGeminiKey({ 'x-gemini-key': [key] })).toBe(key);
  });

  it('沒帶或格式不對時回傳 null（不會轉交給 Google）', () => {
    expect(readGeminiKey(undefined)).toBeNull();
    expect(readGeminiKey({})).toBeNull();
    expect(readGeminiKey({ 'x-gemini-key': 'short' })).toBeNull();
    expect(readGeminiKey({ 'x-gemini-key': `${key}\r\nX-Evil: 1` })).toBeNull();
    expect(readGeminiKey({ 'x-gemini-key': 'a'.repeat(201) })).toBeNull();
  });
});
