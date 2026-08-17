/**
 * 從外部試算表匯入週記帳。
 *
 * 對應「菡萏咖啡.xlsx」的損益表版面：
 *   工作表名稱　YYYY損益表　或　YYYY損益表 (可橙)
 *   第 3 列　　 標題：記帳日期、總成本、即時庫存、買進、賣出、總損益、當周損益金額、…
 *   第 4 列起　 每週一列，通常記在星期五
 *
 * 這份資料用來補上系統開始記錄之前的月走勢與歷年績效。權益曲線只能從有交易紀錄
 * 或建倉日之後開始算，更早的歷史必須由外部資料提供。
 */

/** 標題列所在的列號（1-based）。 */
const HEADER_ROW = 3;
/** 資料列的範圍，超出此範圍的內容是表格下方的附註。 */
const FIRST_DATA_ROW = 4;
const LAST_DATA_ROW = 55;

/**
 * 找出工作表中符合損益表命名規則的名稱。
 *
 * @param {string[]} sheetNames
 * @returns {{ name:string, year:number, account:string }[]}
 */
export function findLedgerSheets(sheetNames) {
  const out = [];
  for (const name of sheetNames) {
    const match = /^(\d{4})損益表\s*(?:\((.+)\))?\s*$/.exec(name.trim());
    if (!match) continue;
    // 「損益表 (2)」這類是舊版備份分頁，帳戶名稱為純數字時排除。
    const account = match[2]?.trim();
    if (account && /^\d+$/.test(account)) continue;
    out.push({ name, year: Number(match[1]), account: account || '主帳戶' });
  }
  return out.sort((a, b) => a.year - b.year || a.account.localeCompare(b.account));
}

/**
 * 把試算表的日期值轉為 YYYY-MM-DD。
 *
 * SheetJS 在 cellDates 開啟時給出 Date 物件，未開啟時給出序列數字，兩者都要處理。
 * @param {*} value
 * @returns {string|null}
 */
function toIsoDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(
      value.getDate()
    ).padStart(2, '0')}`;
  }
  if (typeof value === 'number' && value > 20000 && value < 80000) {
    // Excel 的日期序列以 1899-12-30 為原點。
    const ms = Date.UTC(1899, 11, 30) + value * 86400000;
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
      d.getUTCDate()
    ).padStart(2, '0')}`;
  }
  if (typeof value === 'string') {
    const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(value.trim());
    if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  }
  return null;
}

/**
 * 把可能帶千分位或空白的數值轉為數字。
 * @param {*} value
 * @returns {number|null}
 */
function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[,\s$]/g, '');
  if (!cleaned || cleaned === '-') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * 依標題文字找出欄位索引。
 *
 * 不寫死欄位位置，因為使用者可能在表格中插入欄位。
 * @param {(string|null)[]} header
 * @param {RegExp} pattern
 * @returns {number}
 */
function columnOf(header, pattern) {
  return header.findIndex((h) => typeof h === 'string' && pattern.test(h.replace(/\s/g, '')));
}

/**
 * 解析單一工作表的週記帳。
 *
 * @param {object} XLSX SheetJS 模組
 * @param {object} worksheet
 * @returns {{ rows: object[], warning: string|null }}
 */
function parseSheet(XLSX, worksheet) {
  // header:1 取得純陣列，避免依賴標題文字當鍵名。
  const grid = XLSX.utils.sheet_to_json(worksheet, { header: 1, raw: true, defval: null });
  const header = grid[HEADER_ROW - 1] ?? [];

  const iDate = columnOf(header, /記帳日期/);
  const iCost = columnOf(header, /總成本/);
  const iInventory = columnOf(header, /即時庫存/);
  const iPnl = columnOf(header, /^總損益/);
  const iWeekPnl = columnOf(header, /當周損益金額|當週損益金額/);

  if (iDate === -1 || iCost === -1 || iInventory === -1) {
    return { rows: [], warning: '找不到「記帳日期」「總成本」「即時庫存」欄位' };
  }

  const rows = [];
  let blankValues = 0;
  for (let r = FIRST_DATA_ROW - 1; r <= LAST_DATA_ROW - 1; r += 1) {
    const line = grid[r];
    if (!line) continue;
    const date = toIsoDate(line[iDate]);
    if (!date) continue;

    const cost = toNumber(line[iCost]);
    const inventory = toNumber(line[iInventory]);
    if (cost === null || inventory === null) {
      blankValues += 1;
      continue;
    }

    rows.push({
      date,
      cost,
      inventory,
      pnl: iPnl === -1 ? inventory - cost : (toNumber(line[iPnl]) ?? inventory - cost),
      weekPnl: iWeekPnl === -1 ? null : toNumber(line[iWeekPnl]),
    });
  }

  // 公式沒有快取值時整欄會讀成空白。這通常發生在檔案由程式寫入而非 Excel 存檔，
  // 直接回報比讓使用者面對一張空表格有用。
  const warning =
    rows.length === 0 && blankValues > 0
      ? `有 ${blankValues} 列日期存在但金額為空，可能是公式沒有快取值。請先用 Excel 開啟該檔並存檔，或改上傳手動維護的版本`
      : null;

  return { rows, warning };
}

/**
 * 讀取試算表並解析所有年度的週記帳。
 *
 * @param {File} file
 * @returns {Promise<{
 *   accounts: Record<string, object[]>,
 *   sheets: object[],
 *   warnings: string[]
 * }>}
 */
export async function parseWeeklyWorkbook(file) {
  const XLSX = await import('xlsx');
  const buffer = await file.arrayBuffer();
  // cellDates 讓日期直接變成 Date 物件，省去序列數字換算的誤差。
  const workbook = XLSX.read(buffer, { type: 'array', cellDates: true });

  const sheets = findLedgerSheets(workbook.SheetNames);
  if (sheets.length === 0) {
    throw new Error('檔案中找不到名為「YYYY損益表」的工作表');
  }

  const accounts = {};
  const warnings = [];
  const detail = [];

  for (const sheet of sheets) {
    const { rows, warning } = parseSheet(XLSX, workbook.Sheets[sheet.name]);
    if (warning) warnings.push(`${sheet.name}：${warning}`);
    if (rows.length === 0) continue;
    accounts[sheet.account] ??= [];
    accounts[sheet.account].push(...rows);
    detail.push({ ...sheet, count: rows.length, from: rows[0].date, to: rows[rows.length - 1].date });
  }

  for (const account of Object.keys(accounts)) {
    accounts[account].sort((a, b) => a.date.localeCompare(b.date));
  }

  return { accounts, sheets: detail, warnings };
}

/**
 * 由週記帳彙總每月損益。
 *
 * 優先採用試算表自己的「當周損益金額」，那是使用者維護的數字，比重新推算可靠。
 * 該欄缺漏時退回用相鄰兩筆的總損益相減。
 *
 * @param {object[]} snapshots 依日期排序的週記帳
 * @returns {{ month:string, pnl:number, endNetWorth:number }[]}
 */
export function monthlyFromSnapshots(snapshots) {
  const map = new Map();
  for (let i = 0; i < snapshots.length; i += 1) {
    const row = snapshots[i];
    const delta =
      row.weekPnl !== null && row.weekPnl !== undefined
        ? row.weekPnl
        : i === 0
          ? 0
          : row.pnl - snapshots[i - 1].pnl;

    const month = row.date.slice(0, 7);
    const entry = map.get(month) ?? { month, pnl: 0, endNetWorth: 0 };
    entry.pnl += delta;
    entry.endNetWorth = row.inventory;
    map.set(month, entry);
  }
  return [...map.values()].sort((a, b) => a.month.localeCompare(b.month));
}

/**
 * 由週記帳彙總歷年績效。
 *
 * 年度報酬率的分母採該年度的總成本，這是試算表本身的定義（當年績效 = 當年損益 ÷ 總成本），
 * 沿用同一套算法才能與原本的表格對得上。
 *
 * @param {object[]} snapshots
 * @returns {object[]}
 */
export function yearlyFromSnapshots(snapshots) {
  const map = new Map();
  for (let i = 0; i < snapshots.length; i += 1) {
    const row = snapshots[i];
    const delta =
      row.weekPnl !== null && row.weekPnl !== undefined
        ? row.weekPnl
        : i === 0
          ? 0
          : row.pnl - snapshots[i - 1].pnl;

    const year = row.date.slice(0, 4);
    const entry = map.get(year) ?? { year, pnl: 0, cost: row.cost, endNetWorth: 0, weeks: 0 };
    entry.pnl += delta;
    entry.cost = row.cost;
    entry.endNetWorth = row.inventory;
    entry.weeks += 1;
    map.set(year, entry);
  }

  const years = [...map.values()].sort((a, b) => a.year.localeCompare(b.year));
  let cumulativePnl = 0;
  // 累積報酬採逐年連乘的時間加權法。
  //
  // 不能用「累計損益 ÷ 某一年的成本」：跨年的累計損益除以單一年度的成本沒有意義，
  // 而各年度的資本規模本來就不同（本金會增減資）。連乘才能正確反映複合成長。
  let chained = 1;
  return years.map((y) => {
    cumulativePnl += y.pnl;
    const returnPercent = y.cost > 0 ? (y.pnl / y.cost) * 100 : null;
    if (returnPercent !== null) chained *= 1 + returnPercent / 100;
    return {
      ...y,
      returnPercent,
      cumulativePnl,
      cumulativeReturnPercent: (chained - 1) * 100,
    };
  });
}
