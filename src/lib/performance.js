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
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 補上缺漏的建倉交易。
 *
 * 使用者可能直接輸入現有部位而沒有對應的交易紀錄（例如從券商匯入既有庫存）。
 * 這些部位若不補一筆建倉交易，權益曲線會少算它們的市值。
 * 補的交易以持股的建立日期與平均成本為準，並標記為 synthetic 以便介面區分。
 *
 * @param {object[]} holdings
 * @param {object[]} transactions
 * @returns {object[]} 依日期排序的完整交易紀錄
 */
export function normalizeTransactions(holdings, transactions) {
  const covered = new Set(transactions.map((t) => t.code));

  const synthetic = holdings
    .filter((h) => !covered.has(h.code) && h.shares > 0)
    .map((h) => ({
      id: `synthetic-${h.code}`,
      code: h.code,
      date: h.openedAt ?? toDateString(h.addedAt ?? Date.now()),
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
 * @returns {{date:string, cash:number, positionValue:number, netWorth:number, netFlow:number, pnl:number, cumulativePnl:number}[]}
 */
export function buildEquityCurve({ transactions, cashFlows = [], currentCash = 0, historyByCode }) {
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
  const inception = [
    ...transactions.map((t) => t.date),
    ...cashFlows.map((c) => c.date),
  ].sort()[0];
  const startIndex = inception ? Math.max(0, allDates.findIndex((d) => d >= inception)) : 0;
  const dates = allDates.slice(startIndex === -1 ? 0 : startIndex);
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
    };
    entry.pnl += row.pnl;
    entry.netFlow += row.netFlow;
    entry.endNetWorth = row.netWorth;
    map.set(year, entry);
  }

  const years = [...map.values()];
  let cumulativePnl = 0;
  // 累積報酬的分母是「累計投入資本」：期初淨值加上歷年淨入金。
  // 若只用第一年的期初淨值，日後每次增資都會把累積報酬率灌水。
  let cumulativeBase = years[0]?.startNetWorth ?? 0;

  return years.map((entry) => {
    const base = entry.startNetWorth + entry.netFlow;
    cumulativePnl += entry.pnl;
    cumulativeBase += entry.netFlow;
    return {
      ...entry,
      returnPercent: base > 0 ? (entry.pnl / base) * 100 : null,
      cumulativeReturnPercent: cumulativeBase > 0 ? (cumulativePnl / cumulativeBase) * 100 : null,
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
 * 這是盤中即時試算，資料來源是報價的漲跌值，與權益曲線的收盤結算會有落差，
 * 收盤後兩者應趨於一致。
 *
 * @param {object[]} holdings
 * @param {Record<string, object>} quotes
 * @returns {{ total:number, items:{code:string, shares:number, change:number|null, pnl:number|null}[] }}
 */
export function todayPnl(holdings, quotes) {
  const items = holdings.map((h) => {
    const change = quotes[h.code]?.change ?? null;
    return {
      code: h.code,
      name: quotes[h.code]?.name ?? h.code,
      shares: h.shares,
      change,
      changePercent: quotes[h.code]?.changePercent ?? null,
      pnl: change === null ? null : change * h.shares,
    };
  });

  return {
    total: items.reduce((acc, i) => acc + (i.pnl ?? 0), 0),
    items: items.sort((a, b) => (b.pnl ?? 0) - (a.pnl ?? 0)),
  };
}
