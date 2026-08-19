/**
 * 價格對均線的二日法則狀態。
 *
 * **不經過語言模型，也不產生任何買賣指令。** 這裡只回答一件事：
 * 價格相對均線目前處於什麼狀態、依據是哪幾個數字。要不要因此加減碼是使用者的決定。
 *
 * 與 indicators.js 的 crossState 的差別是**時序**：
 * 那個回答「兩條均線目前誰在上面」，這個回答「跌破第幾天了、確認了沒有」。
 * 同樣是「跌破均線」，第一天與確認後的意義完全不同，前者常是假跌破。
 *
 * 二日法則：
 *   收盤跌破均線的當天只算警戒（Day 1）。隔天若最低價再破前一天的最低價，
 *   才視為跌破確認；沒破則視為未確認，多半是洗盤。
 *   突破反之，看隔天最高價有沒有過前一天的最高價。
 *
 * 這是一個常見的交易慣例，**不是被證明有效的方法**。
 * 它的價值在於把「跌破」拆成可驗證的階段，而不是宣稱能預測方向。
 */

import { sma } from './indicators.js';

/**
 * 各狀態的顯示文字與方向。方向用於介面上色，與台股紅漲綠跌一致。
 *
 * short 是清單掃視用的簡稱，steady 表示「這是持續狀態，不是剛發生的事件」。
 * 二十幾檔的清單裡，多數會停在均線上或均線下，那是常態不是訊息；
 * 把常態調暗，剛跌破或剛確認的那幾檔才會跳出來。
 */
export const STANCE_LABEL = {
  WATCH_BREAKDOWN: { label: '跌破觀察中', short: '跌破觀察', side: 'down', steady: false },
  BEARISH_CONFIRMED: { label: '跌破確認', short: '跌破確認', side: 'down', steady: false },
  BREAKDOWN_FAILED: { label: '跌破未確認', short: '跌破未成立', side: 'up', steady: false },
  BELOW: { label: '均線之下', short: '均線下', side: 'down', steady: true },
  WATCH_BREAKOUT: { label: '突破觀察中', short: '突破觀察', side: 'up', steady: false },
  BULLISH_CONFIRMED: { label: '突破確認', short: '突破確認', side: 'up', steady: false },
  BREAKOUT_FAILED: { label: '突破未確認', short: '突破未成立', side: 'down', steady: false },
  ABOVE: { label: '均線之上', short: '均線上', side: 'up', steady: true },
  UNKNOWN: { label: '資料不足', short: '資料不足', side: 'flat', steady: true },
};

/** 數字格式化，僅用於敘述文字。 */
function f(value, digits = 2) {
  return Number.isFinite(value) ? value.toFixed(digits) : '—';
}

/**
 * 找出最近一次收盤穿越均線的位置。
 *
 * 只認「收盤價」的穿越，不看盤中觸及。盤中戳破均線再拉回極為常見，
 * 用那個判定會讓狀態一天到晚跳動，失去參考價值。
 *
 * @param {number[]} closes
 * @param {(number|null)[]} line
 * @returns {{index:number, direction:'up'|'down'}|null}
 */
function lastCross(closes, line) {
  for (let i = closes.length - 1; i >= 1; i -= 1) {
    const now = line[i];
    const prev = line[i - 1];
    if (now === null || prev === null) break;
    if (closes[i - 1] <= prev && closes[i] > now) return { index: i, direction: 'up' };
    if (closes[i - 1] >= prev && closes[i] < now) return { index: i, direction: 'down' };
  }
  return null;
}

/**
 * 判定價格對單一均線的二日法則狀態。
 *
 * @param {object[]} candles 需含 date、high、low、close
 * @param {number} period 均線天數
 * @returns {object|null} 資料不足時回傳 null
 */
export function maStance(candles, period) {
  if (!Array.isArray(candles) || candles.length < period + 2 || period <= 0) return null;

  const closes = candles.map((c) => c.close);
  const line = sma(closes, period);
  const last = candles.length - 1;
  const ma = line[last];
  if (ma === null) return null;

  const close = closes[last];
  const above = close >= ma;
  const cross = lastCross(closes, line);
  // 收盤剛好等於均線時，說「之上」或「之下」都不準確。
  const sideWord = close === ma ? '等於' : above ? '之上' : '之下';

  const base = {
    period,
    ma,
    close,
    date: candles[last].date,
    // 距離均線多遠。同樣是「站上均線」，貼著走與拉開一成的意義不同。
    distancePercent: ma === 0 ? null : ((close - ma) / ma) * 100,
    crossDate: cross ? candles[cross.index].date : null,
    daysSince: cross ? last - cross.index : null,
    trigger: null,
  };

  // 從未穿越（資料範圍內一直在同一側）。
  if (!cross) {
    return {
      ...base,
      state: above ? 'ABOVE' : 'BELOW',
      description:
        `收盤 ${f(close)} ${close === ma ? '等於' : '位於'} ${period} 日均線 ${f(ma)}` +
        `${close === ma ? '' : ' ' + sideWord}（相距 ${f(base.distancePercent)}%），` +
        `統計範圍內未出現收盤穿越`,
    };
  }

  const crossBar = candles[cross.index];
  const daysSince = base.daysSince;

  // 穿越當天：只是警戒，尚未進入驗證。
  if (daysSince === 0) {
    const down = cross.direction === 'down';
    return {
      ...base,
      state: down ? 'WATCH_BREAKDOWN' : 'WATCH_BREAKOUT',
      description:
        `今日收盤 ${f(close)} ${down ? '跌破' : '站上'} ${period} 日均線 ${f(ma)}（第 1 天）。` +
        `明日${down ? '最低價若跌破今日最低 ' + f(crossBar.low) : '最高價若突破今日最高 ' + f(crossBar.high)}` +
        `，即為二日法則確認`,
    };
  }

  // 穿越後的隔一天就是驗證日，之後的狀態沿用那天的結論。
  const verifyBar = candles[cross.index + 1];
  const down = cross.direction === 'down';
  const confirmed = down ? verifyBar.low < crossBar.low : verifyBar.high > crossBar.high;

  const trigger = {
    date: verifyBar.date,
    value: down ? verifyBar.low : verifyBar.high,
    reference: down ? crossBar.low : crossBar.high,
  };

  // 驗證日當天：這是狀態剛定案的時刻，敘述要講清楚結論。
  if (daysSince === 1) {
    return {
      ...base,
      trigger,
      state: confirmed
        ? down
          ? 'BEARISH_CONFIRMED'
          : 'BULLISH_CONFIRMED'
        : down
          ? 'BREAKDOWN_FAILED'
          : 'BREAKOUT_FAILED',
      description: confirmed
        ? `二日法則${down ? '跌破' : '突破'}確認：今日${down ? '最低 ' : '最高 '}` +
          `${f(trigger.value)} 已${down ? '跌破' : '突破'}前一日的 ${f(trigger.reference)}`
        : `${down ? '跌破' : '突破'}未獲確認：今日${down ? '最低 ' : '最高 '}` +
          `${f(trigger.value)} 未${down ? '跌破' : '突破'}前一日的 ${f(trigger.reference)}`,
    };
  }

  // 驗證日之後：回到單純的位置描述，但保留當初是否確認過。
  return {
    ...base,
    trigger,
    state: above ? 'ABOVE' : 'BELOW',
    description:
      `收盤 ${f(close)} ${close === ma ? '等於' : '位於'} ${period} 日均線 ${f(ma)}` +
      `${close === ma ? '' : ' ' + sideWord}（相距 ${f(base.distancePercent)}%）。` +
      `最近一次收盤${down ? '跌破' : '站上'}在 ${base.crossDate}（${daysSince} 個交易日前），` +
      `當時二日法則${confirmed ? '已確認' : '未確認'}`,
  };
}

/* ------------------------------------------------------------------ */
/* 回測：二日法則到底有沒有用                                           */
/* ------------------------------------------------------------------ */

/**
 * 台股單趟來回的交易成本：買進手續費 0.1425% 加賣出證交稅 0.3%。
 * 與 indicators.js 的回測採同一個數字，兩邊的結果才能直接比較。
 */
const FEE_RATE = 0.004425;

/**
 * 以訊號函式跑一次只做多的回測。
 *
 * 兩個與 indicators.js 相同的關鍵約定：
 * 1. **隔日開盤成交。** 訊號要到當日收盤才成立，用當日收盤價成交等於使用未來資訊。
 * 2. **逐日結算帳面權益。** 只在平倉時取樣，一組全部獲利出場的參數會算出零回檔，
 *    但持倉期間可能經歷過三成的帳面虧損，那才是實際會讓人出場的數字。
 *
 * @param {object[]} candles
 * @param {number} start 開始判定訊號的索引
 * @param {(i:number) => 'buy'|'sell'|null} signalAt
 * @returns {object}
 */
function runLongOnly(candles, start, signalAt, startLong = false) {
  const closes = candles.map((c) => c.close);
  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  // 起點若已站上均線就視為持有中。
  //
  // 只認穿越事件是不夠的：一檔從頭到尾都在均線之上、期間從未跌破的股票，
  // 純事件驅動的模型會全程空手、報酬掛零，把一個順風的走勢算成沒有績效。
  // 穿越是狀態的「轉換點」，不是狀態本身。
  let entryPrice = startLong ? (candles[start + 1]?.open ?? closes[start]) : null;
  let trades = 0;
  let wins = 0;
  let barsHeld = 0;

  const markToMarket = (close) => {
    const value = entryPrice === null ? equity : equity * (close / entryPrice) * (1 - FEE_RATE);
    peak = Math.max(peak, value);
    maxDrawdown = Math.max(maxDrawdown, (peak - value) / peak);
  };

  for (let i = start; i < candles.length - 1; i += 1) {
    const signal = signalAt(i);
    const nextOpen = candles[i + 1].open ?? candles[i + 1].close;

    if (signal === 'buy' && entryPrice === null) {
      entryPrice = nextOpen;
    } else if (signal === 'sell' && entryPrice !== null) {
      const netReturn = (nextOpen / entryPrice) * (1 - FEE_RATE);
      equity *= netReturn;
      trades += 1;
      if (netReturn > 1) wins += 1;
      entryPrice = null;
    }

    if (entryPrice !== null) barsHeld += 1;
    markToMarket(closes[i]);
  }

  // 結束時仍持有部位，以最後收盤價結算，否則會漏掉尚未平倉的盈虧。
  if (entryPrice !== null) {
    const netReturn = (closes[closes.length - 1] / entryPrice) * (1 - FEE_RATE);
    equity *= netReturn;
    trades += 1;
    if (netReturn > 1) wins += 1;
  }
  markToMarket(closes[closes.length - 1]);

  const span = candles.length - 1 - start;
  return {
    totalReturn: (equity - 1) * 100,
    trades,
    winRate: trades === 0 ? null : (wins / trades) * 100,
    maxDrawdown: maxDrawdown * 100,
    // 在市場中的時間比例。報酬相近時，持倉時間較短的那個承擔的風險較小。
    exposure: span <= 0 ? null : (barsHeld / span) * 100,
  };
}

/**
 * 比較同一條均線下的三種做法。
 *
 * **對照組是「單純均線」，不是只有買進持有。** 二日法則本質上是在均線訊號上
 * 多加一道確認，因此要回答的問題是「那道確認有沒有讓結果變好」，
 * 而不是「跟著均線做贏不贏得過不動」。只跟買進持有比，
 * 會把均線本身的效果誤算成二日法則的功勞。
 *
 * @param {object[]} candles
 * @param {number} period 均線天數
 * @returns {object|null} 資料不足時回傳 null
 */
export function compareStanceStrategies(candles, period) {
  // 需要均線成形，加上訊號判定要回看兩根，再留一段樣本才有意義。
  if (!Array.isArray(candles) || period <= 0 || candles.length < period + 30) return null;

  const closes = candles.map((c) => c.close);
  const line = sma(closes, period);
  const start = period + 1;

  const crossedUpAt = (i) =>
    line[i] !== null && line[i - 1] !== null && closes[i] > line[i] && closes[i - 1] <= line[i - 1];
  const crossedDownAt = (i) =>
    line[i] !== null && line[i - 1] !== null && closes[i] < line[i] && closes[i - 1] >= line[i - 1];

  // 二日法則：穿越的隔一天要再創高（或破低）才算確認，訊號因此晚一天。
  const startLong = line[start] !== null && closes[start] > line[start];

  const twoDay = runLongOnly(
    candles,
    start,
    (i) => {
      if (crossedUpAt(i - 1) && candles[i].high > candles[i - 1].high) return 'buy';
      if (crossedDownAt(i - 1) && candles[i].low < candles[i - 1].low) return 'sell';
      return null;
    },
    startLong
  );

  // 單純均線：收盤穿越當天就動作，沒有確認這一關。
  const plain = runLongOnly(
    candles,
    start,
    (i) => {
      if (crossedUpAt(i)) return 'buy';
      if (crossedDownAt(i)) return 'sell';
      return null;
    },
    startLong
  );

  const buyHold = (closes[closes.length - 1] / closes[start] - 1) * 100;

  return {
    period,
    from: candles[start].date,
    to: candles[candles.length - 1].date,
    twoDay,
    plain,
    buyHold,
    // 二日法則相對單純均線的差距，正值代表那道確認有加分。
    edgeVsPlain: twoDay.totalReturn - plain.totalReturn,
    edgeVsBuyHold: twoDay.totalReturn - buyHold,
  };
}

/**
 * 同時判定短、長兩條均線的狀態。
 *
 * 兩條分開看是刻意的：短均線反映波動、長均線反映波段，兩者常給出不同的狀態，
 * 而那個分歧本身就是資訊。硬合成一個總結論會把它抹掉。
 *
 * @param {object[]} candles
 * @param {number} shortPeriod
 * @param {number} longPeriod
 * @returns {{short:object|null, long:object|null}}
 */
export function maStances(candles, shortPeriod, longPeriod) {
  return {
    short: maStance(candles, shortPeriod),
    long: maStance(candles, longPeriod),
  };
}
