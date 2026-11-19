import { describe, expect, it, vi } from 'vitest';

vi.mock('./firebaseApp.js', () => ({ db: {} }));

import { claudeFlowRedirectUrl, isStandaloneDev } from './entry.js';
import { needsEmailVerification } from './emailVerification.js';
import { toProfile } from './userProfile.js';

const loc = (origin, pathname = '/stock/', search = '', hash = '') => ({ origin, pathname, search, hash });
const CF = 'https://claude-flow-chi.vercel.app';

describe('claudeFlowRedirectUrl', () => {
  it('直接打開本專案網址 → 轉回 Claude Flow 的同一個路徑（保留查詢字串與 hash）', () => {
    expect(claudeFlowRedirectUrl(loc('https://tw-stock-analysis.vercel.app', '/stock/x', '?a=1', '#h'), CF, true)).toBe(
      `${CF}/stock/x?a=1#h`,
    );
  });

  it('已經在 Claude Flow 網域 → 不轉', () => {
    expect(claudeFlowRedirectUrl(loc(CF), CF, true)).toBeNull();
    // 結尾斜線、路徑不影響判斷
    expect(claudeFlowRedirectUrl(loc(CF), `${CF}/`, true)).toBeNull();
  });

  it('本機開發、沒設定或設定錯誤 → 不轉', () => {
    expect(claudeFlowRedirectUrl(loc('http://localhost:5174'), CF, false)).toBeNull();
    expect(claudeFlowRedirectUrl(loc('https://x.vercel.app'), undefined, true)).toBeNull();
    expect(claudeFlowRedirectUrl(loc('https://x.vercel.app'), 'not a url', true)).toBeNull();
  });
});

describe('isStandaloneDev', () => {
  it('開發模式直接開台股的 port → 單獨開發', () => {
    expect(isStandaloneDev({ port: '5174' }, true, '5174')).toBe(true);
  });
  it('經 Claude Flow 開發伺服器轉送、或正式環境 → 不是', () => {
    expect(isStandaloneDev({ port: '5173' }, true, '5174')).toBe(false);
    expect(isStandaloneDev({ port: '' }, false, '5174')).toBe(false);
  });
});

describe('needsEmailVerification（與 Claude Flow 同一套判斷）', () => {
  const user = (emailVerified, ...providers) => ({
    emailVerified,
    providerData: providers.map((providerId) => ({ providerId })),
  });

  it('只用 Email/密碼且未驗證 → 需要', () => {
    expect(needsEmailVerification(user(false, 'password'))).toBe(true);
  });

  it('已驗證、Google、GitHub（即使 emailVerified 為 false）、未登入 → 不需要', () => {
    expect(needsEmailVerification(user(true, 'password'))).toBe(false);
    expect(needsEmailVerification(user(true, 'google.com'))).toBe(false);
    expect(needsEmailVerification(user(false, 'github.com', 'password'))).toBe(false);
    expect(needsEmailVerification(null)).toBe(false);
  });
});

describe('toProfile', () => {
  it('取出角色與停用狀態', () => {
    expect(toProfile('u', { uid: 'u', role: 'admin', disabled: false })).toEqual({ uid: 'u', role: 'admin', disabled: false });
  });

  it('不認得的角色當成 user；缺欄位給安全預設值', () => {
    expect(toProfile('u', { role: 'root' })).toEqual({ uid: 'u', role: 'user', disabled: false });
    expect(toProfile('u', undefined)).toEqual({ uid: 'u', role: 'user', disabled: false });
  });
});
