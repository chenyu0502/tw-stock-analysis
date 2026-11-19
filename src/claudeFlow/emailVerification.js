/**
 * Email 驗證的判斷：只有「只用 Email/密碼登入」且尚未驗證信箱的帳號需要驗證。
 *
 * 與 Claude Flow 的 src/auth/emailVerification.ts、api/_lib/auth.js 的
 * isUnverifiedPasswordAccount、firestore.rules 的 emailVerifiedIfPassword 同一套判斷，
 * 改的時候四處要一起改。
 *
 * - Google 登入的 Email 由 Google 驗證過，Firebase 會標成 emailVerified = true。
 * - GitHub 登入時 Firebase 常把 emailVerified 標成 false，但信箱一樣由 GitHub 驗證過，
 *   不能因此擋住 GitHub 使用者，所以只看「是否全部都是 password」。
 *
 * @param {{ emailVerified?: boolean, providerData?: { providerId: string }[] } | null | undefined} user
 */
export function needsEmailVerification(user) {
  if (!user || user.emailVerified) return false;
  const providers = user.providerData ?? [];
  return providers.length > 0 && providers.every((p) => p.providerId === 'password');
}
