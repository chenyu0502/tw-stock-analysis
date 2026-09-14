/**
 * 台股資料的更新時段判定。
 *
 * 用途是決定「現在自動重抓資料有沒有意義」。收盤之後價格不會再變動，
 * 一個整晚沒關的分頁若照樣每五分鐘打一次上游，一夜就是上百次無謂請求。
 */

/**
 * 一律以台北時間判定，不使用裝置的本機時區。
 *
 * 使用者在國外時本機時區會整個判錯，而這個判斷決定要不要自動更新，
 * 判錯的症狀是「畫面上的數字整天不動」——從介面完全看不出原因，
 * 會被當成程式壞掉。
 */
const FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Taipei',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  // 不指定 hourCycle 時，部分執行環境會把午夜格式化為 24，讓分鐘數多出一天。
  hourCycle: 'h23',
});

/** 起點取 08:30：早於 09:00 開盤，試撮期間的參考價已經在跳動。 */
const OPEN_MINUTES = 8 * 60 + 30;

/**
 * 終點取 18:00。
 *
 * 不是13:30 收盤就結束——融資融券、三大法人、估值這幾項都是收盤後才陸續發布，
 * 那段時間的自動更新正是把當日數字補齊的時機。
 */
const CLOSE_MINUTES = 18 * 60;

const TRADING_WEEKDAYS = new Set(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);

/**
 * 取得台北時間的星期與當日分鐘數。
 * @param {Date} date
 * @returns {{ weekday: string, minutes: number }}
 */
function taipeiParts(date) {
  const map = {};
  for (const part of FORMATTER.formatToParts(date)) map[part.type] = part.value;
  return {
    weekday: map.weekday,
    minutes: Number(map.hour) * 60 + Number(map.minute),
  };
}

/**
 * 現在是否處於「資料可能變動」的時段。
 *
 * **只看星期與時間，不判斷國定假日與颱風假。** 要做到精準就得維護一份交易日曆，
 * 還得處理補行上班日，成本與效益不成比例。判錯的代價只是假日多打幾次上游，
 * 而那些請求本來就有伺服器快取擋著。
 *
 * @param {Date} [date=new Date()]
 * @returns {boolean}
 */
export function isMarketDataWindow(date = new Date()) {
  const { weekday, minutes } = taipeiParts(date);
  if (!TRADING_WEEKDAYS.has(weekday)) return false;
  return minutes >= OPEN_MINUTES && minutes < CLOSE_MINUTES;
}
