/**
 * 同業估值比較。
 *
 * **這個檔案完全不經過語言模型。** 產業中位數、分位與排名都是可逐項驗證的算術，
 * 與 fundamentals.js 的分位帶、levels.js 的價位是同一個原則：數字由程式算，
 * 模型只負責解讀。
 *
 * 為什麼需要這一層：估值分位帶回答的是「這檔相對自己過去貴不貴」，
 * 那個問題有一個盲點——整個產業一起重評價時，個股的歷史分位會長期停在高檔，
 * 看起來永遠很貴；反過來，產業結構性衰退時歷史分位會長期在低檔，
 * 看起來永遠便宜。加上同業的橫向座標才分得出「這檔貴」與「這個產業貴」。
 *
 * 資料來源分兩塊：
 * 1. 產業分類取自 FinMind TaiwanStockInfo（需 FINMIND_TOKEN），一次取回全市場。
 * 2. 估值數字重用 /api/valuation 已經抓好的全市場快照，不另外呼叫上游。
 */

import { fetchJson } from './http.js';
import { withPartialCache, TTL } from './cache.js';
import { percentileRank } from './fundamentals.js';

const FINMIND = 'https://api.finmindtrade.com/api/v4/data';

/**
 * 統計需要的最少同業家數（含自己）。
 *
 * 少於這個數量時中位數幾乎等於任一檔的值，「高於同業中位數」這句話沒有資訊量。
 * 此時仍回傳同業名單供人工對照，但把 sufficient 標為 false，
 * 讓介面與模型都知道不能拿這組統計下結論。
 */
const MIN_PEERS = 5;

/** 同業明細在自己上下各取幾檔。 */
const NEIGHBOR_SPAN = 5;

/**
 * 非個股的產業分類。
 *
 * ETF、ETN、受益證券、存託憑證沒有可比較的本業，把它們算進產業中位數
 * 只會汙染樣本——ETF 的「本益比」是成分股的加權結果，與個股的意義不同。
 */
const NON_COMPANY = /ETF|ETN|受益證券|存託憑證|大盤|Index/i;

/* ------------------------------------------------------------------ */
/* 純計算                                                              */
/* ------------------------------------------------------------------ */

/** 取排序後樣本的分位數值。 */
function quantile(sorted, ratio) {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * ratio));
  return sorted[index];
}

/**
 * 單一指標的同業統計。
 *
 * 分位的方向與 fundamentals.js 一致：數值代表「高於同業中多少比例的家數」。
 * 本益比與股價淨值比的分位越高代表越貴，殖利率相反，這個差異由介面與提示詞說明，
 * 不在這裡用「貴」「便宜」下結論。
 *
 * @param {number[]} values 同業（含自己）的有效數值
 * @param {number|null} self 本檔數值
 * @returns {object|null}
 */
function summarizeMetric(values, self) {
  if (values.length === 0) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const hasSelf = Number.isFinite(self) && self > 0;

  return {
    self: hasSelf ? self : null,
    samples: sorted.length,
    min: sorted[0],
    p25: quantile(sorted, 0.25),
    median: quantile(sorted, 0.5),
    p75: quantile(sorted, 0.75),
    max: sorted[sorted.length - 1],
    percentile: hasSelf ? percentileRank(sorted, self) : null,
    // 由小到大的名次，1 為最低。本益比的第 1 名是最低本益比，不是「最好」，
    // 因此介面必須連同指標名稱一起顯示，不可單獨呈現名次。
    rank: hasSelf ? sorted.filter((v) => v < self).length + 1 : null,
  };
}

/**
 * 從同業清單中取出本檔上下鄰近的幾檔。
 *
 * 不取「產業龍頭」，因為免費資料源沒有市值，用成交值代替會在冷門股身上失真。
 * 估值鄰居對「這檔的估值落在同業的哪一段」這個問題更直接：
 * 看得到自己上面與下面各是誰，數字才有對照。
 *
 * @param {object[]} rows 已排序的同業列
 * @param {string} code
 * @param {number} span
 * @returns {object[]}
 */
function pickNeighbors(rows, code, span) {
  const size = span * 2 + 1;
  if (rows.length <= size) return rows;

  const index = rows.findIndex((r) => r.code === code);
  if (index < 0) return rows.slice(0, size);

  // 先以本檔為中心取窗，再把超出邊界的部分往回推，
  // 讓清單在頭尾兩端也維持同樣長度，而不是只剩半截。
  const start = Math.min(Math.max(0, index - span), rows.length - size);
  return rows.slice(start, start + size);
}

/**
 * 組出同業比較報告。
 *
 * @param {object} params
 * @param {string} params.code
 * @param {Record<string, {industry: string, name: string}>} params.industries 全市場產業分類
 * @param {Record<string, object>} params.valuations 全市場估值快照
 * @returns {object}
 */
export function buildPeerReport({ code, industries, valuations }) {
  const own = industries[code];

  if (!own?.industry) {
    return {
      available: false,
      code,
      reason: '查無此標的的產業分類，無法做同業比較',
    };
  }
  if (NON_COMPANY.test(own.industry)) {
    return {
      available: false,
      code,
      industry: own.industry,
      // ETF 走到這裡是正常結果，不是失敗。訊息要講清楚，
      // 否則使用者會以為是資料抓不到而反覆重試。
      reason: `此標的的分類為「${own.industry}」，沒有可比較的本業，不適用同業比較`,
    };
  }

  // 同產業且拿得到估值的個股。ETF 與受益證券即使被分到同一類也一律排除。
  const members = [];
  for (const [peerCode, info] of Object.entries(industries)) {
    if (info.industry !== own.industry) continue;
    if (NON_COMPANY.test(info.industry)) continue;
    const v = valuations[peerCode];
    if (!v) continue;
    members.push({
      code: peerCode,
      name: v.name || info.name || peerCode,
      pe: positive(v.peRatio),
      pb: positive(v.pbRatio),
      dividendYield: positive(v.dividendYield),
    });
  }

  if (members.length === 0) {
    return {
      available: false,
      code,
      industry: own.industry,
      reason: '同產業個股皆無估值資料，無法比較',
    };
  }

  const self = members.find((m) => m.code === code) ?? null;
  const valuesOf = (key) => members.map((m) => m[key]).filter((v) => v !== null);

  // 排序時把沒有本益比的排在最後：虧損公司沒有本益比，
  // 若當成 0 會排到最前面，看起來像是全產業最便宜的一檔。
  const sorted = [...members].sort((a, b) => {
    if (a.pe === null && b.pe === null) return a.code.localeCompare(b.code);
    if (a.pe === null) return 1;
    if (b.pe === null) return -1;
    return a.pe - b.pe;
  });

  return {
    available: true,
    code,
    industry: own.industry,
    peerCount: members.length,
    // 樣本不足時統計照算照回傳，但標示出來，由介面與模型決定要不要據此下結論。
    sufficient: members.length >= MIN_PEERS,
    metrics: {
      pe: summarizeMetric(valuesOf('pe'), self?.pe ?? null),
      pb: summarizeMetric(valuesOf('pb'), self?.pb ?? null),
      dividendYield: summarizeMetric(
        valuesOf('dividendYield'),
        self?.dividendYield ?? null
      ),
    },
    neighbors: pickNeighbors(sorted, code, NEIGHBOR_SPAN).map((m) => ({
      ...m,
      self: m.code === code,
    })),
  };
}

/** 只接受正數。本益比為零或負數代表虧損或無資料，不該進入統計。 */
function positive(value) {
  return Number.isFinite(value) && value > 0 ? value : null;
}

/* ------------------------------------------------------------------ */
/* 產業分類                                                            */
/* ------------------------------------------------------------------ */

/**
 * 取得全市場的產業分類對照表。
 *
 * TaiwanStockInfo 一次回傳上市與上櫃的全部代號，因此只打一次，快取一天。
 * 產業分類幾乎不會變動，TTL 設短只是平白消耗 FinMind 的每小時額度。
 *
 * @param {string} token
 * @returns {Promise<Record<string, {industry: string, name: string, type: string}>>}
 */
export async function loadIndustryMap(token) {
  return withPartialCache('industry:map', TTL.FUNDAMENTAL, async () => {
    const json = await fetchJson(`${FINMIND}?dataset=TaiwanStockInfo`, {
      headers: { Authorization: `Bearer ${token}` },
      timeoutMs: 15000,
      retries: 1,
    });
    const rows = Array.isArray(json?.data) ? json.data : [];

    const map = {};
    for (const row of rows) {
      const id = String(row.stock_id ?? '').trim();
      const industry = String(row.industry_category ?? '').trim();
      // 同一代號可能同時出現在不同市場別的列，先到先留即可，內容是一樣的。
      if (!id || !industry || map[id]) continue;
      map[id] = {
        industry,
        name: String(row.stock_name ?? '').trim(),
        type: String(row.type ?? '').trim(),
      };
    }

    // 全市場約兩千檔，數量遠低於此代表這次只拿到殘缺的回應，
    // 用短 TTL 讓下一次請求重試，而不是把壞資料鎖住一整天。
    return { value: map, complete: Object.keys(map).length > 500 };
  });
}
