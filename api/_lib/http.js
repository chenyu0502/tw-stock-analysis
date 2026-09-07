/**
 * 上游 API 的 HTTP 取用工具。
 *
 * 這一層存在的理由：參考站把抓取放在瀏覽器端，靠公開 CORS proxy 繞過跨域限制，
 * proxy 隨時可能失效或限流。改由伺服器端直連上游，沒有跨域問題，也能自己控管重試。
 */

/** 部分上游（Yahoo、TWSE MIS）對預設 UA 會擋或限流，統一帶瀏覽器 UA。 */
const DEFAULT_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
};

/**
 * 一次嘗試至少要有的時間。剩餘預算低於此值就不再送出，
 * 免得發出一個注定被截斷的請求，白白佔用上游額度。
 */
const MIN_ATTEMPT_MS = 1500;

/**
 * 帶逾時與重試的 fetch。
 * @param {string} url
 * @param {{
 *   method?: string,
 *   body?: string,
 *   headers?: Record<string,string>,
 *   timeoutMs?: number,
 *   retries?: number,
 *   deadline?: number|null
 * }} [options] deadline 為整段流程的絕對截止時間（Date.now() 基準）
 * @returns {Promise<Response>}
 */
export async function fetchWithRetry(url, options = {}) {
  // 逾時與重試次數的乘積必須留在 vercel.json 設定的 maxDuration 之內，
  // 否則函式會被平台中斷，使用者只會看到沒有訊息的 504。
  //
  // 光靠這兩個參數不夠：呼叫端若把同一份請求對多個上游依序嘗試，乘積會再翻倍。
  // deadline 是整段流程的絕對截止時間，用來把總時間釘死，
  // 每次嘗試只能用到剩餘時間，不夠就直接放棄而不是硬送出去等平台砍。
  const {
    method = 'GET',
    body,
    headers = {},
    timeoutMs = 8000,
    retries = 2,
    deadline = null,
  } = options;
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const remaining = deadline === null ? Infinity : deadline - Date.now();
    if (remaining <= MIN_ATTEMPT_MS) {
      throw lastError ?? new Error('已逾時，來不及送出請求');
    }
    const effectiveTimeout = Math.min(timeoutMs, remaining);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), effectiveTimeout);
    try {
      const res = await fetch(url, {
        method,
        body,
        headers: { ...DEFAULT_HEADERS, ...headers },
        signal: controller.signal,
      });
      clearTimeout(timer);
      // 5xx 與 429 值得重試，4xx 其餘狀況重試沒有意義，直接回傳讓上層處理。
      if (res.status >= 500 || res.status === 429) {
        lastError = new Error(`上游回應 ${res.status}`);
      } else {
        return res;
      }
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
    }
    // 指數退避：400ms、800ms、1600ms。
    // 上游忙碌（503）時立刻重試多半還是被拒，等待一段時間成功率明顯較高。
    // 退避本身也要吃剩餘預算，否則會在時間已經不夠時還先睡一秒。
    if (attempt < retries) {
      const backoff = 400 * 2 ** attempt;
      const left = deadline === null ? Infinity : deadline - Date.now();
      if (left <= MIN_ATTEMPT_MS + backoff) break;
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }
  throw lastError ?? new Error('未知的上游錯誤');
}

/**
 * 取得上游 JSON，失敗時拋出帶有可讀訊息的錯誤。
 *
 * **「HTTP 200 但內容不是 JSON」也算失敗，而且要重試。**
 *
 * 證交所 MIS 忙碌或重整時會回一個狀態碼 200 的 HTML 錯誤頁。
 * fetchWithRetry 的重試條件是 5xx 與 429，這種回應完全攔不到——
 * 解析又發生在重試迴圈之外，於是上游一次抽風就直接變成使用者眼前的錯誤，
 * 儘管下一次請求通常立刻就成功。實測同一時段連打二十次全部正常，
 * 代表這類失敗是零星的，重試一次就能吸收掉。
 *
 * 第二趟刻意不再重試（retries: 0），整體成本最多就是多打一次上游，
 * 不會讓一個壞掉的上游把函式的時間預算耗光。
 *
 * @param {string} url
 * @param {object} [options] 同 fetchWithRetry
 * @returns {Promise<*>}
 */
export async function fetchJson(url, options = {}) {
  const host = new URL(url).hostname;
  const passes = [options, { ...options, retries: 0 }];
  let lastError;

  for (let i = 0; i < passes.length; i += 1) {
    if (i > 0) {
      // 時間不夠就不要再送，理由同 fetchWithRetry 的 MIN_ATTEMPT_MS。
      const left = options.deadline == null ? Infinity : options.deadline - Date.now();
      if (left <= MIN_ATTEMPT_MS) break;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }

    const res = await fetchWithRetry(url, passes[i]);
    // 4xx 重試沒有意義，直接拋出，不進入第二趟。
    if (!res.ok) {
      throw new Error(`上游 ${host} 回應 ${res.status}`);
    }
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      lastError = new Error(`上游 ${host} 暫時無法提供資料（回應不是 JSON），請稍後再試`);
    }
  }

  throw lastError;
}

/**
 * 把可能帶逗號或全形符號的數值字串轉為數字，無法解析時回傳 null。
 * @param {*} value
 * @returns {number|null}
 */
export function toNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const cleaned = String(value).replace(/[,\s"']/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '--') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}
