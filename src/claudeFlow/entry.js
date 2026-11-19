/**
 * 台股分析的入口網址判斷。
 *
 * 正式環境的入口是 Claude Flow 的 /stock/（Claude Flow 用 Vercel rewrite 轉送到這個專案）。
 * 直接打開本專案自己的網址（例如 tw-stock-analysis.vercel.app）時，網域不同、登入狀態不共用，
 * 所以轉回 Claude Flow 的同一個路徑。
 */

/**
 * @param {{ origin: string, pathname: string, search: string, hash: string }} loc 目前網址
 * @param {string|undefined} claudeFlowUrl VITE_CLAUDE_FLOW_URL，例如 https://claude-flow-chi.vercel.app
 * @param {boolean} isProd 只在正式建置時轉址；本機開發一律不轉
 * @returns {string|null} 要轉去的網址；不需要轉時為 null
 */
export function claudeFlowRedirectUrl(loc, claudeFlowUrl, isProd) {
  if (!isProd || !claudeFlowUrl) return null;
  let target;
  try {
    target = new URL(claudeFlowUrl);
  } catch {
    return null;
  }
  if (target.origin === loc.origin) return null;
  return `${target.origin}${loc.pathname}${loc.search}${loc.hash}`;
}

/**
 * 是否為「單獨開發台股」：開發模式、且直接打開台股自己的開發伺服器 port。
 * 這時沒有 Claude Flow 的登入頁，改用頁面上的開發用登入。
 * 透過 Claude Flow 的開發伺服器（它把 /stock 轉送過來）打開時，照正式環境導向 Claude Flow 的 /login。
 *
 * @param {{ port: string }} loc
 * @param {boolean} isDev
 * @param {string} devPort 台股開發伺服器的 port
 */
export function isStandaloneDev(loc, isDev, devPort) {
  return isDev && loc.port === devPort;
}
