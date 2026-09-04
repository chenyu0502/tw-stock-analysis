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
 *
 * 配息在除息日當天以「持股數 × 每股配息」計入現金。收盤價是未還原的原始價格，
 * 除息當天會直接跌掉配息金額，不補這筆現金的話那天會憑空多出一筆等於配息的虧損。
 * 實際入帳通常在除息後一個多月，這裡採除息日應計制，與券商對帳單的現金餘額會有時間差。
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
      // 匯入的持股可能沒有成本均價。若原樣帶入 undefined，權益曲線在累計現金變動時
      // 會算出 NaN，而 NaN 會擴散到整條曲線——月曆每一格、當月損益、年度報酬全部變成
      // NaN 或破折號，畫面上完全看不出是「有一檔缺成本」造成的。
      // 補零的意思是「不知道當初付了多少」：現金回推會失準，但其餘數字仍然可用。
      price: Number.isFinite(h.avgCost) ? h.avgCost : 0,
      fee: 0,
      realized: null,
      synthetic: true,
    }));

  return [...transactions, ...synthetic].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 比對交易紀錄累加出來的股數與持股清單，回傳每檔的差額。
 *
 * 權益曲線的股數是由交易紀錄逐筆累加，持股頁則直接採用持股清單。
 * 兩者只要不一致，兩頁就會各說各話，而且完全沒有跡象——
 * 持股頁的市值正確，績效頁的每日損益卻整段等比例放大或縮小。
 * 實際遇到的情形是交易紀錄被重複匯入，每日損益因此變成大約兩倍。
 *
 * 持股清單是使用者直接維護、也是持股頁採用的來源，可信度較高，
 * 因此以它為準：差額補進期初部位，讓曲線的終點股數必然等於持股清單。
 *
 * @param {object[]} transactions 已正規化的交易紀錄
 * @param {object[]} holdings
 * @returns {Record<string, number>} 代號 → 應補進期初部位的股數（僅列出不為零者）
 */
export function reconcileShares(transactions, holdings) {
  const net = {};
  for (const t of transactions) net[t.code] = (net[t.code] ?? 0) + t.shares;

  const target = {};
  for (const h of holdings) target[h.code] = (target[h.code] ?? 0) + h.shares;

  const adjustments = {};
  // 交易紀錄裡出現過的代號都要檢查。已出清的標的不在持股清單中，目標股數為零。
  for (const code of new Set([...Object.keys(net), ...Object.keys(target)])) {
    const diff = (target[code] ?? 0) - (net[code] ?? 0);
    if (diff !== 0) adjustments[code] = diff;
  }
  return adjustments;
}

/* ------------------------------------------------------------------ */
/* 權益曲線                                                            */
/* ------------------------------------------------------------------ */

/**
 * 依即時報價判斷今天是不是交易日。
 *
 * MIS 的 tradeDate 是 YYYYMMDD 的成交日期，休市日會停在最後一個交易日。
 * 拿它當依據，就不需要在前端維護一份台股行事曆，颱風假也不會判斷錯。
 *
 * @param {Record<string, object>} quotes
 * @param {string} todayDate YYYY-MM-DD
 * @returns {boolean}
 */
function quotesAreFromToday(quotes, todayDate) {
  const compact = todayDate.replace(/-/g, '');
  return Object.values(quotes ?? {}).some((q) => q?.tradeDate === compact);
}

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
 * @param {Record<string, {candles: object[], dividends?: {date:string, amount:number}[]}>} params.historyByCode
 *        各檔歷史 K 線與除權息事件
 * @param {string|null} [params.startDate] 統計起算日，早於此日的交易併入期初部位
 * @param {Record<string, object>} [params.quotes] 即時報價，用於把曲線最後一天改以現價評價
 * @param {string|null} [params.todayDate] 今日日期，僅在曲線最後一天等於今日時才套用現價
 * @param {object[]|null} [params.holdings] 目前持股。帶入後曲線的終點股數會校正為與持股清單一致
 * @returns {{date:string, cash:number, positionValue:number, netWorth:number, netFlow:number, pnl:number, cumulativePnl:number, cumulativeDividend:number}[]}
 */
export function buildEquityCurve({
  transactions,
  cashFlows = [],
  currentCash = 0,
  historyByCode,
  startDate = null,
  quotes = {},
  todayDate = null,
  holdings = null,
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

  // 今天那一列不靠歷史 K 線補上。
  //
  // 交易日的區間是各檔歷史 K 線日期的聯集，於是「今天有沒有這一格」
  // 取決於 Yahoo 有沒有發布當日那根 K 棒——開盤前它還不存在（或收盤價為 null
  // 而被濾掉），而前端的歷史資料一天只抓一次（見 isHistoryStale）。
  // 結果是：開盤前開的分頁，月曆今天那格整天空白，重新整理才會出現。
  //
  // 但今天的市值本來就一律改用即時報價評價（見下方 liveDate），
  // 那根 K 棒從頭到尾都用不到。缺的只是「今天這個日期」而已，直接補上。
  //
  // 補在對齊交易日之前，今天成交的那幾筆才會落在今天，
  // 而不是被 `dates.find(d => d >= tx.date)` 推到最後一個歷史交易日——
  // 那正是先前「昨天那格錯了、今天那格沒顯示」的成因。
  if (
    todayDate &&
    allDates[allDates.length - 1] < todayDate &&
    quotesAreFromToday(quotes, todayDate)
  ) {
    allDates.push(todayDate);
  }

  // 各檔的除息日到每股配息金額。同一天同一檔只會有一筆。
  const divByCode = {};
  for (const code of codes) {
    divByCode[code] = new Map(
      (historyByCode[code]?.dividends ?? []).map((d) => [d.date, d.amount])
    );
  }

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

  // 交易紀錄與持股清單對不起來時，以持股清單為準，差額補進期初部位。
  //
  // 若不校正，曲線的股數會整段偏離：交易紀錄重複匯入會讓每日損益變成大約兩倍，
  // 而持股頁因為直接讀持股清單仍然正確，使用者只會看到兩頁互相矛盾卻找不到原因。
  if (holdings) {
    for (const [code, diff] of Object.entries(reconcileShares(transactions, holdings))) {
      openingShares[code] = (openingShares[code] ?? 0) + diff;
    }
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

  // 統計區間前一個交易日的期初部位市值。
  //
  // 有了它，區間第一天才有前一日淨值可比。先前第一天的損益一律歸零，
  // 設定起算日為 8/1 時，8/3 相對於 7/31 收盤的漲跌整天消失，當月損益因此短少一天。
  // 歸零原本是為了避免把期初入金算成當天的巨額虧損，但那個問題的根源是
  // 缺少前一日淨值，補上基準即可，不需要整天棄用。
  const prevDate = foundIndex > 0 ? allDates[foundIndex - 1] : null;
  let openingPositionValue = 0;
  let openingValuationOk = true;
  for (const code of codes) {
    const shares = openingShares[code] ?? 0;
    if (shares === 0) continue;
    // 個股在前一交易日可能沒有報價（停牌或當天無成交），往前找最近一筆收盤價。
    let close;
    for (let i = allDates.indexOf(prevDate); i >= 0; i -= 1) {
      close = closeByCode[code].get(allDates[i]);
      if (close !== undefined) break;
    }
    // 期初就持有卻查不到區間之前的價格，代表無從比較，第一天只能維持歸零。
    if (close === undefined) {
      openingValuationOk = false;
      break;
    }
    openingPositionValue += shares * close;
  }

  // 曲線最後一天若就是今天，改以即時報價評價。
  //
  // 歷史 K 線在前端整場快取，盤中不會重抓，今日那根 K 棒因此停在開頁當下的價格；
  // 而「今日損益」用的是每次重新整理都會更新的即時報價。兩者同源不同時點，
  // 盤中一定會愈差愈遠——使用者看到的就是月曆今天那格與今日損益對不起來。
  // 改以現價評價後，兩個數字在盤中也是同一個口徑。
  //
  // 除息日仍然一致：即時報價的昨收是除息參考價，而曲線是「原始昨收 − 配息」，兩者相等。
  const liveDate = todayDate && dates[dates.length - 1] === todayDate ? todayDate : null;

  // 完全沒有歷史股價的標的，整段用「即時報價推得的昨收」評價。
  //
  // 不這樣做的話，那一檔在今天之前的每一天都會落到價格 0，到了今天又突然以現價入帳，
  // 整個部位的市值就變成當天的假性獲利——實測一檔兩萬股的 ETF 可以憑空多出六十幾萬，
  // 月曆今天那格因此與「今日損益」差了一大截。這正是歷史股價載入失敗（例如 504）
  // 之後會看到的現象，而且只會出現在今天那一格，很難聯想到是資料缺漏。
  //
  // 用昨收當基準後，過去每一天都是同一個價格、貢獻為零，今天則貢獻
  // 「股數 × 當日漲跌」，與今日損益完全同一個口徑。
  const fallbackPrice = {};
  for (const code of codes) {
    if (closeByCode[code].size > 0) continue;
    const quote = quotes[code];
    if (Number.isFinite(quote?.price) && Number.isFinite(quote?.change)) {
      fallbackPrice[code] = quote.price - quote.change;
    }
  }

  // 先正推持股與現金變動量，再由目前現金往回推算每日現金。
  const held = { ...openingShares };
  const rows = [];
  let cumulativeCashDelta = 0;
  let cumulativeDividend = 0;

  for (const date of dates) {
    // 配息先於當日買賣結算。除息日的領息資格看的是前一交易日收盤的持股，
    // 當天才買進的部位不參與這次配息。
    for (const code of codes) {
      const amount = divByCode[code].get(date);
      if (!amount) continue;
      const shares = held[code] ?? 0;
      if (shares <= 0) continue;
      cumulativeCashDelta += shares * amount;
      cumulativeDividend += shares * amount;
    }

    const todayTx = txByDate.get(date) ?? [];
    for (const tx of todayTx) {
      held[tx.code] = (held[tx.code] ?? 0) + tx.shares;
      // 買進為資金流出（shares 為正），賣出為流入（shares 為負），手續費恆為流出。
      // 單筆金額算不出來時以零計，不讓一筆壞資料把整條曲線變成 NaN。
      const delta = tx.shares * tx.price + tx.fee;
      cumulativeCashDelta -= Number.isFinite(delta) ? delta : 0;
    }
    const netFlow = flowByDate.get(date) ?? 0;
    cumulativeCashDelta += netFlow;

    /**
     * 當日評價用的價格。
     *
     * 順序：今日的即時報價 → 當日收盤價 → 缺歷史股價時的昨收基準 → 沿用前一日。
     * 個股當日無報價（停牌或該檔資料起點較晚）時沿用前一日市值，避免淨值出現假跳空。
     */
    const priceOf = (code) => {
      const live = date === liveDate ? quotes[code]?.price : null;
      const close = closeByCode[code].get(date);
      return (
        live ?? close ?? fallbackPrice[code] ?? rows[rows.length - 1]?.priceByCode?.[code] ?? 0
      );
    };

    let positionValue = 0;
    const priceByCode = {};
    for (const code of codes) {
      const price = priceOf(code);
      priceByCode[code] = price;
      positionValue += (held[code] ?? 0) * price;
    }

    rows.push({ date, positionValue, netFlow, cumulativeCashDelta, cumulativeDividend, priceByCode });
  }

  // 目前現金對應曲線最後一日，往前每天加回之後發生的資金變動。
  const finalCashDelta = rows[rows.length - 1].cumulativeCashDelta;
  let cumulativePnl = 0;

  return rows.map((row, i) => {
    const cash = currentCash - (finalCashDelta - row.cumulativeCashDelta);
    const netWorth = cash + row.positionValue;

    let pnl = 0;
    if (i > 0) {
      const prev = rows[i - 1];
      const prevNetWorth =
        currentCash - (finalCashDelta - prev.cumulativeCashDelta) + prev.positionValue;
      pnl = netWorth - prevNetWorth - row.netFlow;
    } else if (openingValuationOk) {
      // 第一天比對的是區間前一個交易日：現金變動量尚為零，部位以前一日收盤價計算。
      // 扣掉當日淨入金後，期初入金不會被算成虧損；當天才建倉的部位也只計入
      // 成交價到收盤價的價差，不會把入金誤當損益。
      const prevNetWorth = currentCash - finalCashDelta + openingPositionValue;
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
      // 截至當日的累計配息。配息實際入帳約在除息後一個多月，「帳上現金」通常還沒收到，
      // 往回推算的歷史現金會因此整段偏低。判斷現金是否真的為負時要把這部分加回。
      cumulativeDividend: row.cumulativeDividend,
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
 *   當日損益 = 庫存股數 × 當日漲跌
 *
 * **刻意不對「今日成交」的部位做特別處理，也不扣手續費。**
 *
 * 原本會把當天成交的部位拆出來、以成交價算到現價再扣手續費，理論上比較精確。
 * 但那個做法有個前提：交易紀錄的日期等於實際成交日。實際使用上不成立——
 * 使用者是事後才登錄交易，表單的日期欄預設今天，於是幾天前買的零股會被
 * 當成今天成交，那 95 股就吃不到當天的漲跌，還被扣一次手續費。
 * 結果是畫面上的數字與券商的當日損益對不起來，而原因完全看不出來。
 *
 * 現在的算法與券商 App 的「未實現損益（今日）」同口徑：只看庫存與今日漲跌。
 * 庫存數與成本均價若與對帳單有出入，持股頁可以直接編輯校正。
 *
 * @param {object[]} holdings
 * @param {Record<string, object>} quotes
 * @returns {{ total:number, items:object[] }}
 */
export function todayPnl(holdings, quotes) {
  const items = holdings.map((h) => {
    const quote = quotes[h.code];
    const change = quote?.change ?? null;

    return {
      code: h.code,
      // 名稱留空由顯示層決定如何呈現，回填代號會讓介面出現「64886488」。
      name: quote?.name ?? '',
      // 現價與漲跌同源，一併帶出讓介面能顯示，也方便與券商畫面逐列對照。
      price: quote?.price ?? null,
      shares: h.shares,
      change,
      changePercent: quote?.changePercent ?? null,
      // 報價缺漏時不給值，不用零充數——零會被當成「今天沒漲跌」。
      pnl: change === null ? null : h.shares * change,
    };
  });

  return {
    total: items.reduce((acc, i) => acc + (i.pnl ?? 0), 0),
    items: items.sort((a, b) => (b.pnl ?? 0) - (a.pnl ?? 0)),
  };
}
