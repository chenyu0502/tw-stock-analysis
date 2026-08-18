/**
 * 績效計算。
 *
 * 核心做法是先建出每日權益曲線，其餘指標（日、週、月、年損益與報酬率）
 * 全部由這條曲線推導，不各自獨立計算。這樣可以保證各時間尺度的數字互相一致，
 * 不會出現「月損益加總不等於年損益」這類對不起來的情況。
 *
 * 每日損益的定義：
 *   當日損益 = 當日淨值 - 前一日淨值 - 當日淨入金
 * 扣掉淨入金是必要的，否則匯入一筆資金會被當成獲利。
 */

/* ------------------------------------------------------------------ */
/* 交易紀錄正規化                                                       */
/* ------------------------------------------------------------------ */

/**
 * 把日期時間戳轉為 YYYY-MM-DD。
 * @param {number} ts
 * @returns {string}
 */
function toDateString(ts) {
  const d = new Date(ts);
  // 時間戳缺漏或格式異常時 Date 會是 Invalid Date，直接格式化會產出 "NaN-NaN-NaN"。
  // 那個字串在後續的日期比大小中永遠排在數字之前，會讓統計區間退回到資料最早的一天。
  if (Number.isNaN(d.getTime())) return toDateString(Date.now());
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 補上缺漏的建倉交易。
 *
 * 使用者可能直接輸入現有部位而沒有對應的交易紀錄（例如從券商匯入既有庫存）。
 * 這些部位若不補一筆建倉交易，權益曲線會少算它們的市值。
 * 補的交易以平均成本為價格，並標記為 synthetic 以便介面區分。
 *
 * 建倉日期的取用順序是 statsStartDate、持股的 openedAt、加入系統的日期。
 *
 * statsStartDate 存在的理由：預設會用「登記進系統的那一天」，但那通常遠晚於實際買進日，
 * 導致權益曲線只從登記日開始，之前的每日損益全部缺失。
 * 若使用者的部位在某個日期之前就已買進且之後沒有異動，把起算日設到那天，
 * 曲線就能正確回推——持股數固定，缺的只是每日收盤價，而那是可以取得的。
 *
 * @param {object[]} holdings
 * @param {object[]} transactions
 * @param {string|null} [statsStartDate] 統計起算日 YYYY-MM-DD
 * @returns {object[]} 依日期排序的完整交易紀錄
 */
export function normalizeTransactions(holdings, transactions, statsStartDate = null) {
  const covered = new Set(transactions.map((t) => t.code));

  const synthetic = holdings
    .filter((h) => !covered.has(h.code) && h.shares > 0)
    .map((h) => ({
      id: `synthetic-${h.code}`,
      code: h.code,
      date: statsStartDate || h.openedAt || toDateString(h.addedAt ?? Date.now()),
      shares: h.shares,
      price: h.avgCost,
      fee: 0,
      realized: null,
      synthetic: true,
    }));

  return [...transactions, ...synthetic].sort((a, b) => a.date.localeCompare(b.date));
}

/* ------------------------------------------------------------------ */
/* 權益曲線                                                            */
/* ------------------------------------------------------------------ */

/**
 * 建立每日權益曲線。
 *
 * 歷史現金部位由目前現金往回推算，而不是從零累加：
 *   某日現金 = 目前現金 + 該日之後所有交易的資金流出 - 該日之後所有入金
 * 這樣做的理由是使用者填的「帳上現金」是實際餘額，可信度高於由不完整的
 * 交易紀錄累加出來的結果。
 *
 * @param {object} params
 * @param {object[]} params.transactions 已正規化的交易紀錄
 * @param {object[]} params.cashFlows 資金流水
 * @param {number} params.currentCash 目前帳上現金
 * @param {Record<string, {candles: object[]}>} params.historyByCode 各檔歷史 K 線
 * @param {string|null} [params.startDate] 統計起算日，早於此日的交易併入期初部位
 * @returns {{date:string, cash:number, positionValue:number, netWorth:number, netFlow:number, pnl:number, cumulativePnl:number}[]}
 */
export function buildEquityCurve({
  transactions,
  cashFlows = [],
  currentCash = 0,
  historyByCode,
  startDate = null,
}) {
  const codes = [...new Set(transactions.map((t) => t.code))];
  if (codes.length === 0) return [];

  // 各檔的日期到收盤價對照，同時收集全部交易日。
  const closeByCode = {};
  const dateSet = new Set();
  for (const code of codes) {
    const map = new Map();
    for (const candle of historyByCode[code]?.candles ?? []) {
      map.set(candle.date, candle.close);
      dateSet.add(candle.date);
    }
    closeByCode[code] = map;
  }
  const allDates = [...dateSet].sort();
  if (allDates.length === 0) return [];

  // 帳戶成立前的日期必須排除。
  //
  // 歷史股價的區間通常比帳戶存在的時間長（預設抓兩年），若從股價區間起點開始算，
  // 那段期間會因為現金是由目前餘額往回推而出現負值，導致淨值與年度報酬完全失真。
  const earliest = [...transactions.map((t) => t.date), ...cashFlows.map((c) => c.date)]
    .filter(Boolean)
    .sort()[0];

  // startDate 是硬性下界，優先於交易紀錄推得的日期。
  //
  // 先前只把它用在「補建倉」的持股上，只要有任何一筆較早的真實交易紀錄，
  // 起算日就完全失效，統計區間會被拉回到那筆交易，甚至退到歷史股價的起點。
  // 使用者設定起算日的意思是「統計從這天開始」，不是「建議值」。
  // 早於這一天的交易由下方的期初部位邏輯併入，不會遺失持股數。
  const inception = startDate && (!earliest || startDate > earliest) ? startDate : earliest;

  const foundIndex = inception ? allDates.findIndex((d) => d >= inception) : 0;
  // 找不到代表起算日晚於所有交易日，此時沒有可統計的區間。
  if (foundIndex === -1) return [];
  const dates = allDates.slice(Math.max(0, foundIndex));
  if (dates.length === 0) return [];

  // 交易日期未必落在交易日上（使用者可能填到假日），逐筆對齊到當日或之後的第一個交易日。
  // 早於歷史區間起點的交易視為期初部位，只計入持股數，不再重複計算當時的買賣損益。
  const windowStart = dates[0];
  const txByDate = new Map();
  const openingShares = Object.fromEntries(codes.map((c) => [c, 0]));
  let openingCashAdjust = 0;

  for (const tx of transactions) {
    if (tx.date < windowStart) {
      openingShares[tx.code] += tx.shares;
      continue;
    }
    const alignedDate = dates.find((d) => d >= tx.date) ?? dates[dates.length - 1];
    const list = txByDate.get(alignedDate) ?? [];
    list.push(tx);
    txByDate.set(alignedDate, list);
  }

  const flowByDate = new Map();
  for (const flow of cashFlows) {
    if (flow.date < windowStart) {
      openingCashAdjust += flow.amount;
      continue;
    }
    const alignedDate = dates.find((d) => d >= flow.date) ?? dates[dates.length - 1];
    flowByDate.set(alignedDate, (flowByDate.get(alignedDate) ?? 0) + flow.amount);
  }
  // 期初之前的入金已含在目前現金裡，不需另外處理，此變數僅供除錯時對帳。
  void openingCashAdjust;

  // 先正推持股與現金變動量，再由目前現金往回推算每日現金。
  const held = { ...openingShares };
  const rows = [];
  let cumulativeCashDelta = 0;

  for (const date of dates) {
    const todayTx = txByDate.get(date) ?? [];
    for (const tx of todayTx) {
      held[tx.code] = (held[tx.code] ?? 0) + tx.shares;
      // 買進為資金流出（shares 為正），賣出為流入（shares 為負），手續費恆為流出。
      cumulativeCashDelta -= tx.shares * tx.price + tx.fee;
    }
    const netFlow = flowByDate.get(date) ?? 0;
    cumulativeCashDelta += netFlow;

    let positionValue = 0;
    for (const code of codes) {
      const shares = held[code] ?? 0;
      if (shares === 0) continue;
      const close = closeByCode[code].get(date);
      // 個股當日無報價（停牌或該檔資料起點較晚）時沿用前一日市值，避免淨值出現假跳空。
      const price = close ?? rows[rows.length - 1]?.priceByCode?.[code] ?? 0;
      positionValue += shares * price;
    }

    const priceByCode = {};
    for (const code of codes) {
      const close = closeByCode[code].get(date);
      priceByCode[code] = close ?? rows[rows.length - 1]?.priceByCode?.[code] ?? 0;
    }

    rows.push({ date, positionValue, netFlow, cumulativeCashDelta, priceByCode });
  }

  // 目前現金對應曲線最後一日，往前每天加回之後發生的資金變動。
  const finalCashDelta = rows[rows.length - 1].cumulativeCashDelta;
  let cumulativePnl = 0;

  return rows.map((row, i) => {
    const cash = currentCash - (finalCashDelta - row.cumulativeCashDelta);
    const netWorth = cash + row.positionValue;

    // 第一天沒有前一日可比，損益必須直接定為零。
    // 若照公式算（本日淨值減前日淨值再減淨入金），期初入金會被算成當天的巨額虧損。
    let pnl = 0;
    if (i > 0) {
      const prev = rows[i - 1];
      const prevNetWorth =
        currentCash - (finalCashDelta - prev.cumulativeCashDelta) + prev.positionValue;
      pnl = netWorth - prevNetWorth - row.netFlow;
    }
    cumulativePnl += pnl;

    return {
      date: row.date,
      cash,
      positionValue: row.positionValue,
      netWorth,
      netFlow: row.netFlow,
      pnl,
      cumulativePnl,
    };
  });
}

/* ------------------------------------------------------------------ */
/* 時間尺度彙總                                                        */
/* ------------------------------------------------------------------ */

/**
 * 依月份彙總損益。
 * @param {object[]} curve buildEquityCurve 的結果
 * @returns {{month:string, pnl:number, endNetWorth:number}[]}
 */
export function aggregateByMonth(curve) {
  const map = new Map();
  for (const row of curve) {
    const month = row.date.slice(0, 7);
    const entry = map.get(month) ?? { month, pnl: 0, endNetWorth: 0 };
    entry.pnl += row.pnl;
    // 逐日覆寫，迴圈結束時自然是該月最後一個交易日的淨值。
    entry.endNetWorth = row.netWorth;
    map.set(month, entry);
  }
  return [...map.values()];
}

/**
 * 依年度彙總績效。
 *
 * 年度報酬率的分母採「年初淨值加上該年淨入金」。嚴謹做法應以入金發生的時點
 * 做時間加權，但那需要更完整的資金流水紀錄；此處採簡化版本，
 * 在年中有大額入金時報酬率會被低估，介面上必須註明這項假設。
 *
 * @param {object[]} curve
 * @returns {{year:string, pnl:number, netFlow:number, startNetWorth:number, endNetWorth:number, returnPercent:number|null, cumulativeReturnPercent:number|null}[]}
 */
export function aggregateByYear(curve) {
  const map = new Map();
  for (const row of curve) {
    const year = row.date.slice(0, 4);
    const entry = map.get(year) ?? {
      year,
      pnl: 0,
      netFlow: 0,
      startNetWorth: row.netWorth - row.pnl - row.netFlow,
      endNetWorth: 0,
      // 該年度實際涵蓋的起訖日。統計起算日設在年中時，這一列並非整年，
      // 介面必須標示出來，否則會被誤讀成全年報酬。
      firstDate: row.date,
      lastDate: row.date,
    };
    entry.pnl += row.pnl;
    entry.netFlow += row.netFlow;
    entry.endNetWorth = row.netWorth;
    entry.lastDate = row.date;
    map.set(year, entry);
  }

  const years = [...map.values()];
  let cumulativePnl = 0;
  // 累積報酬採逐年連乘的時間加權法，與匯入的週記帳採同一套算法。
  //
  // 不能用「累計損益 ÷ 累計投入資本」：各年度的資本規模不同，
  // 跨年的累計損益除以任何單一基準都會失真。連乘才能正確反映複合成長，
  // 也讓增資不會把報酬率灌水或稀釋。
  let chained = 1;

  return years.map((entry) => {
    const base = entry.startNetWorth + entry.netFlow;
    cumulativePnl += entry.pnl;
    const returnPercent = base > 0 ? (entry.pnl / base) * 100 : null;
    if (returnPercent !== null) chained *= 1 + returnPercent / 100;
    return {
      ...entry,
      returnPercent,
      cumulativePnl,
      cumulativeReturnPercent: (chained - 1) * 100,
      // 未從 1 月 1 日起算即為不完整年度。
      partial: entry.firstDate > `${entry.year}-01-05`,
    };
  });
}

/**
 * 取出指定月份的每日損益，供月曆檢視使用。
 * @param {object[]} curve
 * @param {string} month YYYY-MM
 * @returns {Map<string, number>} 日期字串對應當日損益
 */
export function dailyPnlOfMonth(curve, month) {
  const map = new Map();
  for (const row of curve) {
    if (row.date.startsWith(month)) map.set(row.date, row.pnl);
  }
  return map;
}

/* ------------------------------------------------------------------ */
/* 部位彙總                                                            */
/* ------------------------------------------------------------------ */

/**
 * 以成本法彙總目前部位。
 *
 * 持股頁與績效頁都呼叫這個函式，兩頁的總市值、未實現損益與總淨值因此不可能不一致。
 * 先前兩頁各自計算，績效頁用權益曲線的收盤價、持股頁用即時報價，
 * 盤中會顯示不同的總淨值。
 *
 * 取不到報價的部位以成本計入市值，未實現損益視為零。
 * 若改成排除該部位，總市值會在報價載入過程中大幅跳動。
 *
 * @param {object[]} holdings
 * @param {Record<string, object>} quotes
 * @param {number} [cash=0]
 * @returns {{
 *   totalCost:number, totalValue:number, unrealized:number,
 *   unrealizedPercent:number|null, netWorth:number, exposure:number|null,
 *   items:object[]
 * }}
 */
export function positionSummary(holdings, quotes, cash = 0) {
  const items = holdings.map((h) => {
    const price = quotes[h.code]?.price ?? null;
    const cost = h.avgCost * h.shares;
    const value = price === null ? null : price * h.shares;
    const profit = value === null ? null : value - cost;
    return {
      ...h,
      price,
      cost,
      value,
      profit,
      profitPercent: profit === null || cost === 0 ? null : (profit / cost) * 100,
    };
  });

  const totalCost = items.reduce((acc, r) => acc + r.cost, 0);
  const totalValue = items.reduce((acc, r) => acc + (r.value ?? r.cost), 0);
  const unrealized = totalValue - totalCost;
  const netWorth = totalValue + cash;

  return {
    totalCost,
    totalValue,
    unrealized,
    unrealizedPercent: totalCost === 0 ? null : (unrealized / totalCost) * 100,
    netWorth,
    exposure: netWorth === 0 ? null : (totalValue / netWorth) * 100,
    items,
  };
}

/* ------------------------------------------------------------------ */
/* 已實現損益                                                          */
/* ------------------------------------------------------------------ */

/**
 * 彙總已實現損益。
 *
 * 只統計 realized 有值的交易。賣出時若查無對應持股成本，realized 會是 null，
 * 那類交易不應被當成零損益計入，否則會拉低平均。
 *
 * @param {object[]} transactions
 * @param {{ from?: string, to?: string }} [range] 日期區間，含頭含尾
 * @returns {{ total:number, count:number, wins:number, winRate:number|null, items:object[] }}
 */
export function realizedSummary(transactions, range = {}) {
  const items = transactions
    .filter((t) => t.realized !== null && t.realized !== undefined)
    .filter((t) => (range.from ? t.date >= range.from : true))
    .filter((t) => (range.to ? t.date <= range.to : true))
    .sort((a, b) => b.date.localeCompare(a.date));

  const total = items.reduce((acc, t) => acc + t.realized, 0);
  const wins = items.filter((t) => t.realized > 0).length;

  return {
    total,
    count: items.length,
    wins,
    winRate: items.length === 0 ? null : (wins / items.length) * 100,
    items,
  };
}

/* ------------------------------------------------------------------ */
/* 當日損益                                                            */
/* ------------------------------------------------------------------ */

/**
 * 以即時報價計算當日逐檔損益。
 *
 * 當日損益拆成兩段相加：
 *   開盤前就持有的部位 × 當日漲跌
 * ＋ 今日成交的部位 × （現價 − 成交價）− 手續費
 *
 * 不能直接用「目前股數 × 當日漲跌」。目前股數是成交後的結果，
 * 那樣會把一整天的漲跌套用在只持有半天的部位上。
 * 例如昨收 2380、今日以 2400 買進 1000 股、現價 2420，
 * 實際只賺 20,000，用目前股數卻會算成 40,000。
 *
 * 迴圈涵蓋持股與今日交易的聯集，否則今天全數賣出的標的已不在持股清單中，
 * 當天實際的損益會整筆消失。
 *
 * 這是盤中即時試算，與權益曲線的收盤結算會有落差，收盤後兩者應趨於一致。
 *
 * @param {object[]} holdings
 * @param {Record<string, object>} quotes
 * @param {object[]} [transactions] 交易紀錄，用於還原開盤前的持股數
 * @param {string} [todayDate] 今日日期 YYYY-MM-DD
 * @returns {{ total:number, items:object[] }}
 */
export function todayPnl(holdings, quotes, transactions = [], todayDate = null) {
  const todayTx = todayDate ? transactions.filter((t) => t.date === todayDate) : [];

  const holdingMap = new Map(holdings.map((h) => [h.code, h]));
  const codes = [...new Set([...holdingMap.keys(), ...todayTx.map((t) => t.code)])];

  const items = codes.map((code) => {
    const quote = quotes[code];
    const change = quote?.change ?? null;
    const price = quote?.price ?? null;
    const shares = holdingMap.get(code)?.shares ?? 0;

    const trades = todayTx.filter((t) => t.code === code);
    const tradedShares = trades.reduce((acc, t) => acc + t.shares, 0);
    // 開盤前持股 = 目前股數 − 今日淨成交股數
    const sharesAtOpen = shares - tradedShares;

    let pnl = null;
    if (change !== null) {
      pnl = sharesAtOpen * change;
      // 今日成交的部分，改以成交價為基準計算到現價的價差。
      // 報價缺漏時無從計算這一段，整檔的當日損益就不給值，不用零充數。
      if (trades.length > 0) {
        if (price === null) {
          pnl = null;
        } else {
          for (const t of trades) {
            pnl += t.shares * (price - t.price) - (t.fee ?? 0);
          }
        }
      }
    }

    return {
      code,
      // 名稱留空由顯示層決定如何呈現，回填代號會讓介面出現「64886488」。
      name: quote?.name ?? '',
      shares,
      sharesAtOpen,
      tradedShares,
      change,
      changePercent: quote?.changePercent ?? null,
      pnl,
    };
  });

  return {
    total: items.reduce((acc, i) => acc + (i.pnl ?? 0), 0),
    items: items.sort((a, b) => (b.pnl ?? 0) - (a.pnl ?? 0)),
  };
}
