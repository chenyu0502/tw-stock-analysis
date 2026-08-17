/**
 * 型態分析與支撐壓力解讀。
 *
 * 分工原則：價位由前端以 src/lib/levels.js 從歷史資料算出，這裡不讓模型產生任何價格。
 * 模型只做兩件事：辨識型態、解讀既有價位的意義。
 *
 * 理由是語言模型對長數列的精確數值推理並不可靠，可能給出看似合理但不對應任何
 * 轉折點的價位。那種數字拿來設停損沒有依據。改由程式算價位、模型負責敘述，
 * 數字可逐項驗證，敘述也仍有價值。
 */

import { generateJson } from './gemini.js';

const SYSTEM_INSTRUCTION = `你是一位台股技術分析師，服務對象是有經驗的個人投資人。

輸出規則：
1. 一律使用台灣繁體中文，不得混用簡體字。
2. 支撐與壓力價位由使用者提供，那些數字是從歷史資料計算而得。
   你只能解讀這些價位，**絕對不可以自行產生、修改或推估任何價格數字**。
   需要提到價位時，只能引用提供的數字。
3. 型態判斷必須有依據，說明是根據哪些價格結構或指標得出。
   資料不足以判定明確型態時，直接說「型態未明」，不要硬套一個名稱。
4. 語氣務實、分析導向。禁止使用「一定」「必漲」「保證」這類斷言。
5. 不得提供投資建議或買賣指令，只做技術面的客觀描述。
6. 禁止使用 emoji。`;

/** Gemini 的結構化輸出定義。用 responseSchema 保證格式，不靠提示詞約束。 */
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    pattern: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '型態名稱，無法判定時填「型態未明」' },
        stage: { type: 'string', description: '目前處於該型態的哪個階段' },
        evidence: { type: 'string', description: '判定依據，說明根據哪些價格結構或指標' },
        confidence: { type: 'string', enum: ['高', '中', '低'] },
      },
      required: ['name', 'stage', 'evidence', 'confidence'],
    },
    levelNotes: {
      type: 'array',
      description: '對每個提供的支撐壓力價位的解讀，順序與提供的順序一致',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string', description: '例如「支撐1」「壓力2」' },
          significance: { type: 'string', description: '這個價位為什麼重要，一到兩句' },
        },
        required: ['label', 'significance'],
      },
    },
    keyLevel: {
      type: 'string',
      description: '在提供的價位中，目前最關鍵的是哪一個，以及原因',
    },
    scenarios: {
      type: 'object',
      properties: {
        upside: { type: 'string', description: '突破上方壓力代表的意義' },
        downside: { type: 'string', description: '跌破下方支撐代表的意義' },
      },
      required: ['upside', 'downside'],
    },
    summary: { type: 'string', description: '整體技術面結論，八十字以內' },
    risks: {
      type: 'array',
      description: '這份判讀的風險或盲點，兩到三項',
      items: { type: 'string' },
    },
  },
  required: ['pattern', 'levelNotes', 'keyLevel', 'scenarios', 'summary', 'risks'],
};

/**
 * 把數字格式化為兩位小數的字串，null 轉為「無資料」。
 * @param {number|null|undefined} value
 * @returns {string}
 */
function fmt(value) {
  return Number.isFinite(value) ? value.toFixed(2) : '無資料';
}

/**
 * 組出送給模型的分析內容。
 *
 * 刻意不送完整 K 線序列。模型不需要逐日資料就能做型態判讀，
 * 送整串反而會誘使它自行從數列裡挑價格，違反「價位不由模型產生」的原則。
 *
 * @param {object} input
 * @returns {string}
 */
function buildPrompt(input) {
  const { code, name, price, levels, indicators, recent } = input;

  const levelLines = [
    ...levels.resistances.map(
      (l, i) =>
        `壓力${i + 1}：${fmt(l.price)}（距現價 ${l.distancePercent.toFixed(2)}%，` +
        `來源：${l.sources.join('、')}，歷史觸及 ${l.touches} 次，最近一次 ${l.lastTouchDate ?? '無'}）`
    ),
    `現價：${fmt(price)}`,
    ...levels.supports.map(
      (l, i) =>
        `支撐${i + 1}：${fmt(l.price)}（距現價 ${l.distancePercent.toFixed(2)}%，` +
        `來源：${l.sources.join('、')}，歷史觸及 ${l.touches} 次，最近一次 ${l.lastTouchDate ?? '無'}）`
    ),
  ].join('\n');

  return `標的：${code} ${name ?? ''}

【價位結構】（由歷史資料計算，由高至低排列）
${levelLines}

價位來源說明：
轉折點＝價格曾在此反轉的擺盪高低點
量能密集＝成交量集中換手的價格帶
均線＝20、60、120 日移動平均
區間極值＝統計期間內的最高或最低價

【技術指標】
KD(9,3,3)：K ${fmt(indicators.k)} / D ${fmt(indicators.d)}
RSI(14)：${fmt(indicators.rsi)}
MACD：DIF ${fmt(indicators.dif)}，柱狀體 ${fmt(indicators.histogram)}
均線：${indicators.maShort} 日 ${fmt(indicators.shortMa)}，${indicators.maLong} 日 ${fmt(indicators.longMa)}
均線狀態：${indicators.crossLabel}
乖離率：5 日 ${fmt(indicators.bias5)}%，20 日 ${fmt(indicators.bias20)}%
ATR(14)：${fmt(indicators.atr)}

【近期走勢】
統計期間：${recent.periodDays} 個交易日
期間最高 ${fmt(recent.high)}，期間最低 ${fmt(recent.low)}
近 20 日漲跌：${fmt(recent.change20)}%
近 5 日均量與近 20 日均量比：${fmt(recent.volumeRatio)}

請依上述資料判斷目前的價格型態，並解讀每個支撐壓力價位的意義。
再次提醒：只能引用上方提供的價位數字，不可自行產生任何價格。`;
}

/**
 * POST /api/analyze
 *
 * 請求主體：{ code, name, price, levels, indicators, recent }
 * levels 由前端的 src/lib/levels.js 計算後帶入。
 *
 * @param {object} input
 * @param {object} env
 * @returns {Promise<{status:number, body:object, noStore?:boolean}>}
 */
export async function analyzeHandler(input, env = {}) {
  const { code, price, levels, indicators, recent } = input;

  if (!env.GEMINI_API_KEY) {
    return {
      status: 200,
      noStore: true,
      body: {
        available: false,
        reason: '伺服器未設定 GEMINI_API_KEY，無法產生 AI 分析',
      },
    };
  }

  if (!code || !Number.isFinite(price)) {
    return { status: 400, body: { error: '缺少 code 或 price' } };
  }
  if (!levels || !Array.isArray(levels.supports) || !Array.isArray(levels.resistances)) {
    return { status: 400, body: { error: '缺少 levels，價位需由前端計算後帶入' } };
  }
  if (levels.supports.length === 0 && levels.resistances.length === 0) {
    return { status: 400, body: { error: '沒有可解讀的價位，資料量可能不足' } };
  }
  if (!indicators || !recent) {
    return { status: 400, body: { error: '缺少 indicators 或 recent' } };
  }

  const result = await generateJson({
    apiKey: env.GEMINI_API_KEY,
    model: env.GEMINI_MODEL,
    systemInstruction: SYSTEM_INSTRUCTION,
    prompt: buildPrompt(input),
    schema: RESPONSE_SCHEMA,
  });

  return {
    status: 200,
    noStore: true,
    body: {
      available: true,
      code,
      model: env.GEMINI_MODEL || undefined,
      analysis: result,
      // 一併回傳送出的價位，讓介面能把模型的敘述與實際數字對照，
      // 也方便日後查核模型有沒有自行捏造價格。
      levels: { supports: levels.supports, resistances: levels.resistances },
      generatedAt: new Date().toISOString(),
    },
  };
}
