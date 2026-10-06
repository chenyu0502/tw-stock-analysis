/**
 * 顯示格式化工具。
 *
 * 重要慣例：台股的漲跌顏色與歐美相反，紅色代表上漲、綠色代表下跌。
 * 全站顏色一律透過這裡的函式取得，不要在元件內各自判斷。
 */

/**
 * 數字格式化，null 或非數字回傳破折號。
 * @param {number|null|undefined} value
 * @param {number} [digits=2]
 * @returns {string}
 */
export function num(value, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toLocaleString('zh-TW', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/**
 * 每股配息金額格式化。
 *
 * **不能沿用 num(value, 2)。** ETF 的收益分配常見到小數第三、四位，
 * 00940 公告的 0.055 會被四捨五入成 0.06，使用者拿去跟公告或券商對帳就對不上；
 * 而這個欄位存在的目的正是拿來對帳。實際出現過的值包括
 * 0.055、0.09872、2.031861，兩位小數完全不夠。
 *
 * 因此保留上游公告的位數（上限六位）並去掉尾端多餘的零：
 * 0.055 顯示 0.055、0.12 顯示 0.12、8 顯示 8。
 *
 * @param {number|null|undefined} value
 * @returns {string}
 */
export function dividend(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toLocaleString('zh-TW', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 6,
  });
}

/**
 * 整數格式化，用於張數與股數。
 * @param {number|null|undefined} value
 * @returns {string}
 */
export function int(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return Math.round(value).toLocaleString('zh-TW');
}

/**
 * 百分比格式化。
 *
 * signed 為 true 時正值會補上正號，用於漲跌幅、報酬率、乖離率這類方向有意義的數值。
 * 殖利率、勝率、券資比這類永遠為正的比率不應加正號，維持 signed 為 false。
 * @param {number|null|undefined} value
 * @param {number} [digits=2]
 * @param {boolean} [signed=false]
 * @returns {string}
 */
export function pct(value, digits = 2, signed = false) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const sign = signed && value > 0 ? '+' : '';
  return `${sign}${value.toFixed(digits)}%`;
}

/**
 * 金額格式化，不顯示小數。
 * @param {number|null|undefined} value
 * @returns {string}
 */
export function money(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `NT$ ${Math.round(value).toLocaleString('zh-TW')}`;
}

/**
 * 取得台股慣例的漲跌顏色 class。上漲紅、下跌綠、平盤灰。
 * @param {number|null|undefined} value
 * @returns {string}
 */
export function changeColor(value) {
  if (value === null || value === undefined || !Number.isFinite(value) || value === 0) {
    return 'text-slate-400';
  }
  return value > 0 ? 'text-rose-500' : 'text-emerald-500';
}

/**
 * 判斷是否漲停或跌停。
 *
 * 漲跌停價由 MIS 直接提供（`limitUp`、`limitDown`），不需要自己用前一日收盤
 * 乘上 10% 推算——那樣會在股票股利、減資、新股上市這些情形算錯。
 *
 * 兩個判斷上的細節：
 *
 * 1. **用誤差容忍而不是等號比較。** 兩個數字雖然同源，仍是經過字串解析的浮點數，
 *    直接用 `===` 會在某些價位漏判。
 * 2. **必須當天有成交量。** 盤前沒有成交價時，`price` 會退回最佳委買價
 *    （見 quoteHandler），熱門股的漲停買盤掛單會讓它等於漲停價。那是「買盤在漲停價」，
 *    不是「漲停」，用成交量當門閂即可擋掉——盤前成交量為零。
 *
 * @param {object|null|undefined} quote
 * @returns {'up'|'down'|null}
 */
export function limitState(quote) {
  const { price, limitUp, limitDown, volume } = quote ?? {};
  if (!Number.isFinite(price) || !Number.isFinite(volume) || volume <= 0) return null;
  if (Number.isFinite(limitUp) && price >= limitUp - 0.005) return 'up';
  if (Number.isFinite(limitDown) && price <= limitDown + 0.005) return 'down';
  return null;
}

/**
 * 漲跌停時標的名稱的背景方塊 class。
 *
 * 沿用台股紅漲綠跌：漲停紅底、跌停綠底。這與體質燈號的配色方向相反，
 * 但兩者講的是不同的事——這一個講的就是當天的漲跌，用漲跌色才是對的。
 *
 * **只負責漲跌停那兩種狀態，沒有漲跌停時回空字串，平常的文字顏色由呼叫端自己決定。**
 * 原本這裡會回傳一個預設顏色，那是個陷阱：它只湊巧符合第一個使用它的地方，
 * 第二處的名稱是另一個灰階，照用就會把平常的外觀一起改掉。
 *
 * @param {'up'|'down'|null} state limitState 的結果
 * @returns {string}
 */
export function limitBlockClass(state) {
  if (state === 'up') return 'rounded bg-rose-600/90 px-1.5 py-0.5 font-medium text-white';
  if (state === 'down') return 'rounded bg-emerald-600/90 px-1.5 py-0.5 font-medium text-white';
  return '';
}

/** 漲跌停的文字說明，用於 title 屬性。 */
export function limitLabel(state) {
  if (state === 'up') return '漲停';
  if (state === 'down') return '跌停';
  return undefined;
}

/**
 * 體質燈號的顏色 class。
 *
 * 配色由使用者指定：強健琥珀、健康綠、普通灰、偏弱紅。
 *
 * **這組顏色與台股漲跌色是相反的**（本站紅代表上漲、綠代表下跌，見 changeColor），
 * 因此燈號一律連同文字標籤一起顯示，絕不只用顏色表示等級——
 * 少了文字，紅色燈號會被讀成「今天漲」。
 *
 * @param {string|null|undefined} key LIGHTS 的 key，null 代表涵蓋率不足
 * @returns {string}
 */
export function healthColor(key) {
  switch (key) {
    case 'strong':
      return 'border-amber-500/40 bg-amber-500/10 text-amber-400';
    case 'healthy':
      return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400';
    case 'fair':
      return 'border-slate-600/50 bg-slate-700/20 text-slate-300';
    case 'weak':
      return 'border-rose-500/40 bg-rose-500/10 text-rose-400';
    default:
      return 'border-slate-700/50 bg-slate-800/40 text-slate-500';
  }
}

/**
 * 依均線交叉狀態取得對應的顏色 class。
 * @param {string} state 來自 indicators.crossState 的 state 值
 * @returns {string}
 */
export function stateColor(state) {
  switch (state) {
    case 'golden':
    case 'bullish':
      return 'text-rose-500 bg-rose-500/10 border-rose-500/30';
    case 'death':
    case 'bearish':
      return 'text-emerald-500 bg-emerald-500/10 border-emerald-500/30';
    case 'pullback':
    case 'rebound':
      return 'text-amber-500 bg-amber-500/10 border-amber-500/30';
    default:
      return 'text-slate-400 bg-slate-500/10 border-slate-500/30';
  }
}
