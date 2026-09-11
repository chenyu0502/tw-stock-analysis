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
5. 各時間週期的操作立場只能以技術面狀態描述（偏多、偏空、中性、觀望），
   並說明依據與觀察條件。
   **不得出現具體的買賣指令、目標價、停損價或部位配置比例**，
   也不得使用「建議買進」「應該賣出」這類祈使語氣。行動由使用者自行決定。
6. 判斷各週期立場時，請分別依據對應的資料：
   短線看 KD、MACD、5 日乖離、量能比與最近的支撐壓力距離；
   中線看 20 與 60 日均線關係、型態、法人近 5 日與近 20 日買賣超、融資融券；
   長線看 120 日均線方向、現價在期間區間中的位置、估值分位（自身歷史與同業兩軸）
   與獲利品質。
   對應資料缺漏時，直接說明資料不足，不要用其他週期的資料硬推。
7. 估值判斷的規則：
   分位、中位數、名次、每股盈餘、利潤率、營收年增、股東權益報酬率等數字
   全部由使用者提供，**你不可以自行計算、推估或修改任何數字**，
   需要提到時只能原樣引用。估值等級不是買賣建議。
   估值要分成兩個獨立的座標軸判斷，不可混為一談：
   （一）縱向，相對這檔自己的歷史區間，依據為【估值與基本面】的分位。
   （二）橫向，相對同產業其他公司，依據為【同業比較】的中位數、分位與名次。
   兩軸可能給出相反的訊號，那本身就是重要資訊：歷史分位高但同業分位低，
   代表整個產業一起重評價；歷史分位低但同業分位高，代表這檔相對同業並不便宜，
   只是自己曾經更貴。遇到這種情形必須明講，不可只取其中一邊。
   綜合等級要同時考慮兩軸與獲利表現——高分位若有獲利成長支撐，
   與高分位卻伴隨獲利衰退，意義完全不同。
   沒有提供估值資料時（例如 ETF），對應的等級填「資料不足」並說明原因。
8. 同業比較的規則：
   產業分類、同業家數、中位數、四分位與名次全部由使用者提供，
   **不可自行加入未列出的公司，也不可自行判斷誰是同業**。
   產業分類是粗分類，同一分類內的公司可能規模、產品線、毛利結構差異極大
   （例如控股公司與單一產品廠），因此橫向比較的結論必須說明這個限制。
   標示同業家數不足時，不得用那組中位數下結論，只能說樣本太少無法比較。
   沒有提供同業資料時，橫向等級填「資料不足」並說明原因。
9. 風險綜述只能引用「已偵測風險」區塊中提供的項目，
   **不得自行新增未列出的風險**。請說明這些項目之間的關聯，
   以及其中哪一項最需要注意、理由是什麼。沒有提供任何項目時，
   說明目前未觸發門檻，並提醒這不等於沒有風險。
10. 禁止使用 emoji。`;

/**
 * 單一時間週期的立場定義。
 *
 * stance 以列舉限定，介面才能據此上色。開放自由文字會出現「偏多但需觀察」
 * 這類無法歸類的值，介面就無從呈現。
 */
const TIMEFRAME_SCHEMA = {
  type: 'object',
  properties: {
    stance: { type: 'string', enum: ['偏多', '偏空', '中性', '觀望'] },
    basis: { type: 'string', description: '判斷依據，說明用到哪些指標或價位，六十字以內' },
    watch: { type: 'string', description: '關鍵觀察條件，需引用提供的價位或指標數值，四十字以內' },
  },
  required: ['stance', 'basis', 'watch'],
};

/**
 * 單一估值座標軸的定義。
 *
 * 縱向（相對自己歷史）與橫向（相對同業）共用同一個形狀，介面才能並排呈現，
 * 兩軸訊號相反時一眼就看得出來——那正是最值得注意的情況。
 */
const AXIS_SCHEMA = {
  type: 'object',
  properties: {
    level: { type: 'string', enum: ['偏高', '中性', '偏低', '資料不足'] },
    note: {
      type: 'string',
      description: '依據，須引用提供的分位、中位數或名次，六十字以內',
    },
  },
  required: ['level', 'note'],
};

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
    timeframes: {
      type: 'object',
      description: '短中長線的技術面立場',
      properties: {
        short: { ...TIMEFRAME_SCHEMA, description: '短線，數日至兩週' },
        medium: { ...TIMEFRAME_SCHEMA, description: '中線，數週至數月' },
        long: { ...TIMEFRAME_SCHEMA, description: '長線，數月以上' },
      },
      required: ['short', 'medium', 'long'],
    },
    valuation: {
      type: 'object',
      description:
        '估值解讀。分成「相對自己歷史」與「相對同業」兩個座標軸，再給綜合等級。皆非買賣建議。',
      properties: {
        level: {
          type: 'string',
          enum: ['偏高', '中性', '偏低', '資料不足'],
          description: '綜合兩個座標軸與獲利表現後的等級',
        },
        vsHistory: { ...AXIS_SCHEMA, description: '相對這檔自己的歷史估值區間' },
        vsPeers: { ...AXIS_SCHEMA, description: '相對同產業其他公司' },
        drivers: {
          type: 'array',
          description:
            '撐住或壓抑目前估值的具體因素，兩到四項。每項須引用提供的獲利、成長或' +
            '同業數字，並說明它是往上撐還是往下壓。不可引用未提供的數字。',
          items: { type: 'string' },
        },
        basis: {
          type: 'string',
          description:
            '綜合等級的依據，須說明兩個座標軸的訊號一致還是相反，以及為何得出這個綜合結論，' +
            '一百字以內',
        },
        watch: { type: 'string', description: '什麼情況下這個判斷會改變，四十字以內' },
      },
      required: ['level', 'vsHistory', 'vsPeers', 'drivers', 'basis', 'watch'],
    },
    riskSummary: {
      type: 'string',
      description:
        '把「已偵測風險」的項目串成一段，說明彼此關聯與哪一項最需要注意。' +
        '只能引用提供的項目，不可新增。無項目時說明未觸發門檻。一百二十字以內',
    },
    summary: { type: 'string', description: '整體技術面結論，八十字以內' },
    risks: {
      type: 'array',
      description: '這份判讀的風險或盲點，兩到三項',
      items: { type: 'string' },
    },
  },
  required: [
    'pattern',
    'levelNotes',
    'keyLevel',
    'scenarios',
    'timeframes',
    'valuation',
    'riskSummary',
    'summary',
    'risks',
  ],
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
  const {
    code,
    name,
    price,
    levels,
    indicators,
    recent,
    valuation,
    chips,
    fundamentals,
    peers,
    risks,
  } = input;

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
120 日均線：${fmt(indicators.ma120)}（近 20 日變化 ${fmt(indicators.ma120Slope)}%）
均線狀態：${indicators.crossLabel}
乖離率：5 日 ${fmt(indicators.bias5)}%，20 日 ${fmt(indicators.bias20)}%
ATR(14)：${fmt(indicators.atr)}

【近期走勢】
統計期間：${recent.periodDays} 個交易日
期間最高 ${fmt(recent.high)}，期間最低 ${fmt(recent.low)}
現價位於期間區間的 ${fmt(recent.pricePosition)}% 位置（0% 為期間最低，100% 為期間最高）
近 20 日漲跌：${fmt(recent.change20)}%
近 5 日均量與近 20 日均量比：${fmt(recent.volumeRatio)}

${buildValuationBlock(valuation, fundamentals)}

${buildPeerBlock(peers)}

${buildChipBlock(chips)}

${buildRiskBlock(risks)}

請依上述資料完成以下工作：
1. 判斷目前的價格型態。
2. 解讀每個支撐壓力價位的意義。
3. 分別給出短線、中線、長線的技術面立場，各自說明依據與觀察條件。
4. 估值判讀，依序完成三件事：
   先判斷相對自己歷史區間的水位，再判斷相對同業的水位，
   最後說明兩者一致還是相反，並給出綜合等級與支撐或壓抑估值的具體因素。
5. 把已偵測風險串成一段綜述，指出哪一項最需要注意。

再次提醒：只能引用上方提供的數字，不可自行產生或計算任何數字。
兩個估值座標軸要分開判斷，不可用其中一邊的數字去解釋另一邊。
風險綜述只能引用已列出的項目。
所有結論都不得包含買賣指令、目標價或停損價。`;
}

/**
 * 估值與基本面區塊。
 *
 * 有深度資料時一律優先採用：分位帶告訴模型「目前貴不貴是相對自己而言」，
 * 利潤率與營收年增則讓它能判斷這個估值水位有沒有獲利支撐。
 * 只給當下的本益比數字，模型無從判斷那是高是低，只會憑印象亂猜。
 *
 * 缺資料時明確寫出，讓模型知道長線判斷少了哪一塊，而不是留白讓它自行想像。
 *
 * @param {object|null} valuation /api/valuation 的當下快照
 * @param {object|null} fundamentals 壓縮後的深度基本面
 * @returns {string}
 */
function buildValuationBlock(valuation, fundamentals) {
  if (!fundamentals) {
    if (!valuation) {
      return '【估值與基本面】無資料（估值等級請填「資料不足」並說明原因）';
    }
    return `【估值與基本面】僅有當下數值，無歷史分位可比較
本益比：${fmt(valuation.peRatio)}
股價淨值比：${fmt(valuation.pbRatio)}
現金殖利率：${fmt(valuation.dividendYield)}%`;
  }

  const band = (label, b, unit = '') => {
    if (!b) return `${label}：無資料`;
    return (
      `${label}：${fmt(b.current)}${unit}` +
      `（位於自己過去 ${b.samples} 個交易日的 ${fmt(b.percentile)}% 分位，中位數 ${fmt(b.median)}${unit}）`
    );
  };

  const lines = [
    '【估值與基本面】縱向座標，與這檔自己的過去比較。' +
      '分位為「目前值高於過去多少比例的交易日」',
    band('本益比', fundamentals.pe, ' 倍'),
    band('股價淨值比', fundamentals.pb, ' 倍'),
    band('現金殖利率', fundamentals.dividendYield, '%'),
  ];

  const m = fundamentals.margins;
  const ago = fundamentals.marginsYearAgo;
  if (m) {
    const withAgo = (now, before) =>
      ago && Number.isFinite(before) ? `${fmt(now)}%（去年同期 ${fmt(before)}%）` : `${fmt(now)}%`;
    lines.push(
      `毛利率：${withAgo(m.gross, ago?.gross)}`,
      `營業利益率：${withAgo(m.operating, ago?.operating)}`,
      `淨利率：${withAgo(m.net, ago?.net)}`
    );
  }
  lines.push(
    `每股盈餘（近四季合計）：${fmt(fundamentals.epsTtm)}`,
    `股東權益報酬率：${fmt(fundamentals.roe)}%`,
    `月營收年增率：單月 ${fmt(fundamentals.revenueYoy)}%，近三月 ${fmt(fundamentals.revenueYoy3m)}%`,
    `負債比：${fmt(fundamentals.debtRatio)}%`
  );
  if (fundamentals.dividend) {
    const d = fundamentals.dividend;
    lines.push(
      `現金股利：${fmt(d.latestCash)} 元，已連續配發 ${d.consecutiveCashYears} 年` +
        (Number.isFinite(d.payoutRatio) ? `，配發率 ${fmt(d.payoutRatio)}%` : '')
    );
  }
  return lines.join('\n');
}

/**
 * 同業比較區塊。
 *
 * 這一段補的是估值分位帶看不到的東西。歷史分位只能回答「這檔相對自己貴不貴」，
 * 整個產業一起重評價時，個股的歷史分位會長期停在高檔，看起來永遠很貴；
 * 產業結構性衰退時則反過來，看起來永遠便宜。加上橫向座標才分得出
 * 「這檔貴」與「這個產業貴」。
 *
 * 家數不足時照樣把數字送出去，但明寫出來，否則模型會拿三家公司的中位數
 * 當成產業水準下結論。
 *
 * @param {object|null} peers 壓縮後的同業比較
 * @returns {string}
 */
function buildPeerBlock(peers) {
  if (!peers) {
    return '【同業比較】無資料（相對同業的等級請填「資料不足」並說明原因）';
  }

  const metric = (label, m, unit = '') => {
    if (!m) return `${label}：無資料`;
    const self = Number.isFinite(m.self) ? `${fmt(m.self)}${unit}` : '無（本檔無此數值）';
    const position = Number.isFinite(m.percentile)
      ? `，位於同業 ${fmt(m.percentile)}% 分位，由低至高第 ${m.rank} 名`
      : '';
    return (
      `${label}：本檔 ${self}，同業中位數 ${fmt(m.median)}${unit}` +
      `（第一四分位 ${fmt(m.p25)}${unit}，第三四分位 ${fmt(m.p75)}${unit}，` +
      `樣本 ${m.samples} 家）${position}`
    );
  };

  const lines = [
    `【同業比較】產業分類：${peers.industry}，同產業取得估值者共 ${peers.peerCount} 家`,
    peers.sufficient
      ? '分位為「本檔數值高於同業中多少比例的家數」。本益比與股價淨值比的分位越高代表越貴，殖利率相反。'
      : '**同業家數過少，這組統計不具代表性，不得據此下橫向結論**，只能說明樣本不足。',
    metric('本益比', peers.pe, ' 倍'),
    metric('股價淨值比', peers.pb, ' 倍'),
    metric('現金殖利率', peers.dividendYield, '%'),
  ];

  if (Array.isArray(peers.neighbors) && peers.neighbors.length > 0) {
    lines.push(
      '本益比相鄰的同業（★ 為本檔）：',
      ...peers.neighbors.map(
        (n) =>
          `${n.self ? '★ ' : '  '}${n.code} ${n.name}：` +
          `本益比 ${fmt(n.pe)}，股價淨值比 ${fmt(n.pb)}，殖利率 ${fmt(n.dividendYield)}%`
      )
    );
  }

  lines.push(
    '註：產業分類為粗分類，同一分類內的公司規模與產品結構可能差異極大，' +
      '橫向比較的結論必須說明這個限制。'
  );
  return lines.join('\n');
}

/**
 * 已偵測風險區塊。
 *
 * 這些項目由 src/lib/risks.js 依固定門檻算出，每一項都附帶觸發它的實際數值。
 * 模型的工作只是說明彼此的關聯與輕重，不是重新判斷有沒有風險——
 * 那樣會得到每次都不一樣、也無從查核的清單。
 *
 * @param {object[]|null} risks
 * @returns {string}
 */
function buildRiskBlock(risks) {
  if (!Array.isArray(risks) || risks.length === 0) {
    return '【已偵測風險】無。目前沒有任何項目達到門檻（這不等於沒有風險，請於綜述中說明）';
  }
  const label = { high: '高', medium: '中', low: '低' };
  return [
    '【已偵測風險】由程式依固定門檻判定，僅能引用以下項目，不得新增',
    ...risks.map((r) => `（${label[r.severity] ?? '中'}）${r.category}：${r.message}`),
  ].join('\n');
}

/**
 * 籌碼面區塊，單位為張，正值為買超。
 * @param {object|null} chips
 * @returns {string}
 */
function buildChipBlock(chips) {
  if (!chips) return '【籌碼面】無資料（中線判斷請說明缺少籌碼依據）';

  const lines = ['【籌碼面】單位為張，正值為買超'];
  if (chips.today) {
    lines.push(
      `當日：外資 ${fmt(chips.today.foreign)}，投信 ${fmt(chips.today.trust)}，自營商 ${fmt(chips.today.dealer)}`
    );
  }
  if (chips.last5) {
    lines.push(
      `近 5 日累計：外資 ${fmt(chips.last5.foreign)}，投信 ${fmt(chips.last5.trust)}，自營商 ${fmt(chips.last5.dealer)}`
    );
  }
  if (chips.last20) {
    lines.push(
      `近 20 日累計：外資 ${fmt(chips.last20.foreign)}，投信 ${fmt(chips.last20.trust)}，自營商 ${fmt(chips.last20.dealer)}`
    );
  }
  if (chips.margin) {
    lines.push(
      `融資增減 ${fmt(chips.margin.marginChange)}，融券增減 ${fmt(chips.margin.shortChange)}，` +
        `券資比 ${fmt(chips.margin.shortMarginRatio)}%`
    );
  }
  return lines.join('\n');
}

/**
 * 把上游錯誤翻譯成使用者看得懂、且知道該怎麼處理的說明。
 * @param {Error} err
 * @returns {string}
 */
function describeError(err) {
  const message = err?.message ?? '';

  if (/50[023]|忙碌|overload|UNAVAILABLE/i.test(message)) {
    return 'Gemini 服務目前忙碌，已自動重試仍未成功。請稍候再點一次分析。';
  }
  if (/429|quota|RESOURCE_EXHAUSTED/i.test(message)) {
    // 免費層每個模型每天各自計算，實測 gemini-3.7-flash 為每日 20 次。
    // 走到這裡代表備援模型也都用完了，講清楚是「今天用完」而不是「稍後再試」——
    // 後者會讓使用者一直重按，卻要等到隔天才會成功。
    return (
      'Gemini 今日免費額度已用盡（免費層每個模型每天各自計算，' +
      '主要與備援模型都已達上限）。可等隔日重置，或到 Google AI Studio 啟用付費方案。' +
      '上方的估值分位、獲利結構與風險提示不受影響，那些是程式計算的。'
    );
  }
  // 地區限制。這一條必須排在金鑰檢查之前：它同樣是 4xx，但原因完全不同，
  // 誤判成「金鑰無效」會讓人去重設一把本來就正確的金鑰。
  //
  // Gemini 以**發出請求的來源 IP** 判定地區，判定的不是使用者在哪裡，
  // 而是那支函式跑在哪裡。因此這個錯誤幾乎都是執行環境變了（Vercel 的函式區域、
  // 本機掛了 VPN 或代理），而不是設定被改壞。
  if (/location is not supported|FAILED_PRECONDITION/i.test(message)) {
    return (
      'Gemini 拒絕了這個地區的請求（User location is not supported）。' +
      '地區是依發出請求的來源 IP 判定，也就是這支 API 函式實際執行的位置，不是你人在哪裡。' +
      '正式站請確認 Vercel 專案的函式執行區域仍在 Google 服務的地區（目前採用東京 hnd1，' +
      '香港 hkg1 已實測不可用）；' +
      '本機開發請確認沒有掛到不支援地區的 VPN 或代理。' +
      '上方的估值分位、同業比較、獲利結構與風險提示不受影響，那些是程式計算的。'
    );
  }
  if (/API key|API_KEY_INVALID|401|403|PERMISSION/i.test(message)) {
    return 'Gemini 金鑰無效或權限不足，請確認 GEMINI_API_KEY 設定正確。';
  }
  if (/逾時|abort|timeout/i.test(message)) {
    return 'Gemini 回應逾時，請稍候再試。';
  }
  return `AI 分析失敗：${message}`;
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

  let result;
  try {
    result = await generateJson({
      apiKey: env.GEMINI_API_KEY,
      model: env.GEMINI_MODEL,
      systemInstruction: SYSTEM_INSTRUCTION,
      prompt: buildPrompt(input),
      schema: RESPONSE_SCHEMA,
    });
  } catch (err) {
    // 上游的原始訊息（例如「上游回應 503」）對使用者沒有意義，
    // 也看不出這是暫時性問題還是設定錯誤，翻譯成可行動的說明。
    return { status: 200, noStore: true, body: { available: false, reason: describeError(err) } };
  }

  return {
    status: 200,
    noStore: true,
    body: {
      available: true,
      code,
      // 實際使用的模型。配額用盡或模型退役時會自動改用備援，
      // 使用者看到的敘述可能出自不同模型，這個欄位讓那件事是可見的。
      model: result.model,
      analysis: result.data,
      // 一併回傳送出的價位，讓介面能把模型的敘述與實際數字對照，
      // 也方便日後查核模型有沒有自行捏造價格。
      levels: { supports: levels.supports, resistances: levels.resistances },
      generatedAt: new Date().toISOString(),
    },
  };
}
