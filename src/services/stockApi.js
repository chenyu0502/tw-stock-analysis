/**
 * 前端資料取用層。
 *
 * 一律走自家 /api/* 代理，不直接呼叫證交所或 Yahoo。
 * 好處是沒有跨域問題、不依賴公開 CORS proxy，且 FinMind token 留在伺服器端不外洩。
 */

/**
 * 呼叫自家 API 端點。
 * @param {string} path 端點名稱，例如 'quote'
 * @param {Record<string, string|number>} [params]
 * @returns {Promise<*>}
 */
async function callApi(path, params = {}) {
  const search = new URLSearchParams(
    Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => [k, String(v)])
  );

  const res = await fetch(`/api/${path}?${search}`);
  const json = await res.json().catch(() => null);

  if (!res.ok) {
    throw new Error(json?.error ?? `API ${path} 回應 ${res.status}`);
  }
  return json;
}

/**
 * 取得多檔即時報價。
 * @param {string[]} codes
 * @returns {Promise<{ quotes: Record<string, object>, missing: string[] }>}
 */
export function fetchQuotes(codes) {
  if (!codes.length) return Promise.resolve({ quotes: {}, missing: [] });
  return callApi('quote', { codes: codes.join(',') });
}

/**
 * 取得單檔歷史 K 線。
 * @param {string} code
 * @param {{ range?: string, interval?: string }} [options]
 * @returns {Promise<{ candles: object[] }>}
 */
export function fetchHistory(code, options = {}) {
  const { range = '1y', interval = '1d' } = options;
  return callApi('history', { code, range, interval });
}

/**
 * 取得單檔的當日逐分鐘走勢。
 *
 * 另有專屬端點而非沿用 fetchHistory：/api/history 後面接了一串只對日 K 有意義的
 * 後處理（官方收盤校正、補洞、缺漏偵測、除權息合併），分時資料走那條路會壞得很安靜。
 * @param {string} code
 */
export function fetchIntraday(code) {
  return callApi('intraday', { code });
}

/**
 * 取得融資融券資料。
 * @param {string[]} codes
 */
export function fetchMargin(codes) {
  return callApi('margin', { codes: codes.join(',') });
}

/**
 * 取得多檔的當日三大法人買賣超。
 * @param {string[]} codes
 */
export function fetchInstitutional(codes) {
  return callApi('institutional', { codes: codes.join(',') });
}

/**
 * 取得單檔的三大法人買賣超歷史序列。
 *
 * 需要伺服器端設有 FINMIND_TOKEN。未設定時回傳 available 為 false，
 * 呼叫端應據此顯示提示，而不是當成沒有資料。
 * @param {string} code
 * @param {number} [days=30]
 * @returns {Promise<{ available: boolean, series: object[], reason?: string }>}
 */
export function fetchInstitutionalHistory(code, days = 30) {
  return callApi('institutional', { codes: code, days });
}

/**
 * 取得本益比、股價淨值比、殖利率。
 * @param {string[]} codes
 */
export function fetchValuation(codes) {
  return callApi('valuation', { codes: codes.join(',') });
}

/**
 * 取得單檔的基本面深度指標：估值分位帶、月營收年增、利潤率、ROE、股利紀錄。
 *
 * 全部由伺服器以程式計算，不經過語言模型。
 * @param {string} code
 */
export function fetchFundamentals(code) {
  return callApi('fundamentals', { code });
}

/**
 * 取得同業估值比較：同產業的本益比、股價淨值比、殖利率統計與本檔在其中的位置。
 *
 * 與 fetchFundamentals 的分位帶互補：那個回答「相對自己過去貴不貴」，
 * 這個回答「相對同業貴不貴」。同樣由伺服器以程式計算，不經過語言模型。
 * @param {string} code
 */
export function fetchPeers(code) {
  return callApi('peers', { code });
}

/**
 * 取得即將除權息的標的清單（全市場，已公告的區間約往後兩個月）。
 * 單次請求涵蓋所有代號，由前端自行比對持股。
 *
 * 帶入 codes 時，伺服器會對其中確實即將除息的那幾檔補上現金股利發放日。
 * 發放日不在證交所與櫃買的預告表裡，要另外查 FinMind，因此只對需要的代號查。
 *
 * @param {string[]} [codes]
 */
export function fetchExDividend(codes = []) {
  return callApi('exdividend', codes.length ? { codes: codes.join(',') } : {});
}

/**
 * 取得加權指數與櫃買指數的即時報價與日 K。
 *
 * 兩個指數一次取回，不分別請求——它們永遠一起顯示，拆成兩趟只是多一次往返。
 */
export function fetchMarketIndices({ withCandles = true } = {}) {
  // 盤中每分鐘更新報價，但日 K 一天只會多一根，沒必要跟著重抓一年份。
  return callApi('marketindex', withCandles ? {} : { candles: '0' });
}

/**
 * 取得全市場代號名稱對照表。資料量約 2000 筆，載入後應快取於記憶體。
 */
export function fetchUniverse() {
  return callApi('universe');
}

/**
 * 送出 AI 型態分析請求。
 *
 * 支撐壓力價位由前端以 src/lib/levels.js 算好後帶入，伺服器只負責呼叫模型解讀。
 * 模型不產生任何價格數字，這樣回傳的價位才可逐項驗證。
 *
 * @param {object} payload { code, name, price, levels, indicators, recent }
 * @returns {Promise<{ available: boolean, analysis?: object, reason?: string }>}
 */
export async function fetchAnalysis(payload) {
  const res = await fetch('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(json?.error ?? `AI 分析回應 ${res.status}`);
  }
  return json;
}
