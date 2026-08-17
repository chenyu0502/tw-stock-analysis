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
export const DEFAULT_MODEL = 'gemini-2.5-flash';

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
export async function generateJson({
  apiKey,
  model,
  systemInstruction,
  prompt,
  schema,
  temperature = 0.2,
}) {
  const target = model || DEFAULT_MODEL;
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
    retries: 1,
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
