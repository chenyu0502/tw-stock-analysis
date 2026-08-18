/**
 * 產生版本識別碼，讓前端能偵測到新版部署。
 *
 * 建置時把識別碼同時寫進兩個地方：
 * 1. 編譯進 bundle 的 __BUILD_ID__ 常數，代表「這份程式碼是哪一版」
 * 2. dist/version.json，代表「伺服器上目前是哪一版」
 * 前端比對兩者，不同就表示有新版可載入。
 *
 * 之所以需要這個機制：index.html 雖然設定為每次重新驗證，但使用者若一直開著分頁
 * 不重新整理，就永遠拿不到新版，還會誤以為修改沒有部署。
 */

/**
 * 取得本次建置的識別碼。
 *
 * Vercel 會提供 commit SHA，那是最精確的識別。本機建置沒有這個變數，
 * 退回用時間戳，同樣能區分不同次建置。
 * @returns {string}
 */
export function resolveBuildId() {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA;
  return sha ? sha.slice(0, 12) : `local-${Date.now()}`;
}

/**
 * @param {string} buildId
 * @returns {import('vite').Plugin}
 */
export default function versionPlugin(buildId) {
  return {
    name: 'build-version',
    apply: 'build',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: JSON.stringify({ buildId, builtAt: new Date().toISOString() }),
      });
    },
  };
}
