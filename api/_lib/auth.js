/**
 * API 的登入驗證：所有登入且未停用的 Claude Flow 使用者都能呼叫 /api/*。
 *
 * 做法是拿使用者自己的 Firebase ID token 去讀 Firestore 的 users/{uid}：
 * - token 是偽造的、過期的、或不屬於這個 uid，Firestore 會直接拒絕（401/403），
 *   簽章由 Google 驗證，這裡不必自己驗 JWT，也不需要額外套件；
 * - 不需要 service account 金鑰，Vercel 上不必多放一份機密；
 * - 讀到的文件就是 Claude Flow 的使用者資料，順便確認 disabled，並取得 role
 *   （AI 分析用它決定能不能退用伺服器的 Gemini 金鑰，見 analyze.js）。
 *
 * 這依賴 Firestore 規則「本人可讀自己的 users 文件」（見 firestore.rules）。
 */

/** 驗證通過的結果快取多久。被停用或降級的帳號最多再用這麼久。 */
const CACHE_TTL_MS = 60 * 1000;
/** 快取上限，超過就整個清掉；使用者不多，不需要更精緻的淘汰策略。 */
const CACHE_MAX_ENTRIES = 500;

/** @type {Map<string, { uid: string, role: string, expiresAt: number }>} token → 驗證通過的結果 */
const cache = new Map();

/** 測試用：清空快取。 */
export function clearAuthCache() {
  cache.clear();
}

/**
 * @typedef {{ ok: true, uid: string, role: string } | { ok: false, status: number, error: string }} AuthResult
 */

/** @returns {AuthResult} */
function fail(status, error) {
  return { ok: false, status, error };
}

/**
 * 解出 JWT 的 payload（不驗簽章，只用來取 uid 與到期時間；真正的驗證交給 Firestore）。
 * @param {string} token
 * @returns {object|null}
 */
function decodePayload(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const payload = JSON.parse(json);
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

/**
 * token 是否屬於「只用 Email/密碼登入、還沒驗證信箱」的帳號。
 *
 * 與前端的 needsEmailVerification（src/auth/emailVerification.ts）同一套判斷：
 * firebase.identities 列出帳號綁定的所有登入方式，Email/密碼的鍵名是 "email"。
 * 只有全部都是 email 且 email_verified 不是 true 才算未驗證；
 * GitHub 帳號的 email_verified 常是 false，但信箱由 GitHub 驗證過，不能擋。
 *
 * @param {object} payload 解出的 token payload
 */
export function isUnverifiedPasswordAccount(payload) {
  if (payload?.email_verified === true) return false;
  const identities = payload?.firebase?.identities;
  if (!identities || typeof identities !== 'object') return false;
  const keys = Object.keys(identities);
  return keys.length > 0 && keys.every((k) => k === 'email');
}

/**
 * 確認請求來自登入、未停用、且（Email/密碼帳號）已驗證信箱的 Claude Flow 使用者。
 *
 * @param {string|undefined} authorization 請求的 Authorization 標頭
 * @param {Record<string, string|undefined>} env 環境變數
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<AuthResult>}
 */
export async function verifyMember(authorization, env, fetchImpl = fetch) {
  const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? '');
  if (!match) return fail(401, '請先登入');
  const token = match[1];

  const now = Date.now();
  const cached = cache.get(token);
  if (cached && cached.expiresAt > now) return { ok: true, uid: cached.uid, role: cached.role };
  if (cached) cache.delete(token);

  const payload = decodePayload(token);
  const uid = payload?.user_id ?? payload?.sub;
  if (typeof uid !== 'string' || !uid) return fail(401, '登入憑證格式不正確');

  const expiresAtMs = typeof payload.exp === 'number' ? payload.exp * 1000 : 0;
  if (expiresAtMs <= now) return fail(401, '登入已過期，請重新整理頁面');
  // payload 在這裡還沒驗簽章，但偽造的 token 下面讀 Firestore 時一定會被拒絕；
  // 這一關只會讓請求更嚴格，不會讓偽造的 token 通過，所以放在打 Firestore 之前省一次請求。
  if (isUnverifiedPasswordAccount(payload)) return fail(403, '請先完成 Email 驗證');

  const projectId = env.FIREBASE_PROJECT_ID || env.VITE_FIREBASE_PROJECT_ID;
  if (!projectId) return fail(500, '伺服器未設定 Firebase 專案（VITE_FIREBASE_PROJECT_ID）');

  // 開發模式連本機 Emulator。正式環境若誤設成 true，127.0.0.1 上沒有 Emulator，
  // 請求會失敗並回 503——失敗時拒絕，不會變成放行。
  const host =
    env.VITE_USE_EMULATOR === 'true' ? 'http://127.0.0.1:8080' : 'https://firestore.googleapis.com';
  const url = `${host}/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/users/${encodeURIComponent(uid)}`;

  let res;
  try {
    res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
  } catch {
    return fail(503, '暫時無法驗證登入狀態，請稍後再試');
  }

  if (res.status === 401) return fail(401, '登入憑證無效，請重新登入');
  // 404：登入了 Firebase 但從沒在 Claude Flow 登入過（沒有使用者資料）。
  if (res.status === 403 || res.status === 404) return fail(403, '請先從 Claude Flow 首頁登入');
  if (!res.ok) return fail(503, '暫時無法驗證登入狀態，請稍後再試');

  let doc;
  try {
    doc = await res.json();
  } catch {
    return fail(503, '暫時無法驗證登入狀態，請稍後再試');
  }

  const role = doc?.fields?.role?.stringValue;
  const disabled = doc?.fields?.disabled?.booleanValue;
  // disabled 必須明確是 false（與 Security Rules 一致）；缺欄位視為停用。
  if (disabled !== false) return fail(403, '帳號已停用，請聯絡管理員');
  const safeRole = role === 'admin' ? 'admin' : 'user';

  if (cache.size >= CACHE_MAX_ENTRIES) cache.clear();
  cache.set(token, { uid, role: safeRole, expiresAt: Math.min(now + CACHE_TTL_MS, expiresAtMs) });
  return { ok: true, uid, role: safeRole };
}

/** Gemini API 金鑰的合理格式：只允許英數、底線、連字號，長度 20～200。 */
const GEMINI_KEY_RE = /^[A-Za-z0-9_-]{20,200}$/;

/**
 * 從請求標頭取出使用者自己的 Gemini 金鑰（X-Gemini-Key）。
 * 沒帶或格式不對時回傳 null；這個值只轉交給 Google，不記錄、不快取。
 * @param {Record<string, string|string[]|undefined>|undefined} headers
 * @returns {string|null}
 */
export function readGeminiKey(headers) {
  const raw = headers?.['x-gemini-key'];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  return value && GEMINI_KEY_RE.test(value) ? value : null;
}
