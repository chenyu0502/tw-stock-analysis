/**
 * Gemini API 呼叫層。
 *
 * 金鑰只存在伺服器端環境變數，不會出現在前端 bundle 或網路請求的網址中。
 * 參考站是讓使用者把金鑰貼進網頁並存在 localStorage，那等於把金鑰暴露在瀏覽器裡，
 * 任何一段第三方腳本都讀得到。
 */

import { fetchWithRetry } from './http.js';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/** 預設模型。可用 GEMINI_MODEL 環境變數覆寫。 */
export const DEFAULT_MODEL = 'gemini-3.7-flash';

/**
 * 模型退役時的回退對象。
 *
 * Google 會讓舊模型「仍列在模型清單中，但對新使用者回傳 404」。
 * 實測 gemini-2.5 系列就是這個狀態，光看清單無法察覺，直到實際呼叫才會失敗。
 * 這個別名永遠指向當前的 flash 模型，用來把硬性中斷變成可用的降級。
 */
const FALLBACK_MODEL = 'gemini-flash-latest';

/** 判斷錯誤是否為模型不可用，這種情況重試同一個模型沒有意義。 */
function isModelUnavailable(message) {
  return /no longer available|not found|is not supported/i.test(message);
}

/**
 * 呼叫 Gemini 產生結構化 JSON。
 *
 * 使用 responseSchema 強制輸出格式，而不是在提示詞裡請模型「回傳 JSON」。
 * 後者在模型偶爾多加一段說明文字時就會解析失敗，前者由 API 層保證結構。
 *
 * @param {object} params
 * @param {string} params.apiKey
 * @param {string} [params.model]
 * @param {string} params.systemInstruction 角色與規則
 * @param {string} params.prompt 本次要分析的內容
 * @param {object} params.schema responseSchema 定義
 * @param {number} [params.temperature=0.2] 分析任務需要穩定輸出，預設偏低
 * @returns {Promise<object>} 解析後的 JSON
 */
export async function generateJson(params) {
  const target = params.model || DEFAULT_MODEL;
  try {
    return await callModel(target, params);
  } catch (err) {
    // 指定的模型已退役時改用永遠可用的別名，讓功能降級而不是整個中斷。
    if (target !== FALLBACK_MODEL && isModelUnavailable(err.message)) {
      return callModel(FALLBACK_MODEL, params);
    }
    throw err;
  }
}

/**
 * 對指定模型送出一次請求。
 * @param {string} target 模型名稱
 * @param {object} params 同 generateJson
 * @returns {Promise<object>}
 */
async function callModel(target, { apiKey, systemInstruction, prompt, schema, temperature = 0.2 }) {
  const url = `${GEMINI_BASE}/models/${encodeURIComponent(target)}:generateContent`;

  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // 金鑰放標頭而非查詢字串，避免被沿途的代理與日誌記錄下來。
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemInstruction }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: schema,
        temperature,
      },
    }),
    timeoutMs: 45000,
    // 實測 Gemini 會間歇回傳 503（模型忙碌），單次重試不足以吸收。
    // 三次重試加上退避後，總耗時最壞約 25 秒，仍在函式執行上限之內。
    retries: 3,
  });

  const text = await res.text();
  if (!res.ok) {
    // Gemini 的錯誤訊息藏在巢狀結構裡，取出來才知道是金鑰無效還是配額超限。
    let detail = text.slice(0, 300);
    try {
      detail = JSON.parse(text)?.error?.message ?? detail;
    } catch {
      /* 保留原始文字 */
    }
    throw new Error(`Gemini 回應 ${res.status}：${detail}`);
  }

  const json = JSON.parse(text);
  const candidate = json?.candidates?.[0];

  if (candidate?.finishReason && !['STOP', 'MAX_TOKENS'].includes(candidate.finishReason)) {
    throw new Error(`Gemini 未正常結束：${candidate.finishReason}`);
  }

  const payload = candidate?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  if (!payload) throw new Error('Gemini 回傳空內容');

  try {
    return JSON.parse(payload);
  } catch {
    throw new Error('Gemini 回傳的內容不是有效的 JSON');
  }
}

/**
 * 列出金鑰可用的模型，用於診斷設定問題。
 * @param {string} apiKey
 * @returns {Promise<string[]>}
 */
export async function listModels(apiKey) {
  const res = await fetchWithRetry(`${GEMINI_BASE}/models`, {
    headers: { 'x-goog-api-key': apiKey },
    timeoutMs: 15000,
    retries: 1,
  });
  const json = await res.json();
  return (json?.models ?? [])
    .filter((m) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
    .map((m) => String(m.name).replace(/^models\//, ''));
}
