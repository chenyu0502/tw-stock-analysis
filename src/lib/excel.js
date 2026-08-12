/**
 * Excel 與 JSON 匯入匯出。
 *
 * xlsx 函式庫體積約 400KB，採動態載入，未使用匯入匯出的使用者不必付這個成本。
 */

/**
 * 把資料列匯出為 Excel 檔並觸發下載。
 * @param {object[]} rows
 * @param {string} filename
 * @param {string} [sheetName='工作表1']
 */
export async function exportExcel(rows, filename, sheetName = '工作表1') {
  const XLSX = await import('xlsx');
  const worksheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
  XLSX.writeFile(workbook, filename);
}

/**
 * 讀取使用者選取的 Excel 或 CSV 檔，回傳第一個工作表的資料列。
 * @param {File} file
 * @returns {Promise<object[]>}
 */
export async function importExcel(file) {
  const XLSX = await import('xlsx');
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { defval: '' });
}

/**
 * 把物件匯出為 JSON 檔並觸發下載。
 * @param {object} data
 * @param {string} filename
 */
export function exportJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // 立刻釋放，否則 blob 會留在記憶體直到分頁關閉。
  URL.revokeObjectURL(url);
}

/**
 * 讀取 JSON 檔。
 * @param {File} file
 * @returns {Promise<object>}
 */
export async function importJson(file) {
  return JSON.parse(await file.text());
}

/**
 * 產生匯入範例的資料列。欄位名稱與匯入解析邏輯必須一致。
 * @returns {object[]}
 */
export function watchlistTemplate() {
  return [
    { 股票代號: '2330', 短均線: 20, 長均線: 60, 備註: '範例，可自行刪除' },
    { 股票代號: '2317', 短均線: 10, 長均線: 45, 備註: '' },
  ];
}

/**
 * 產生持股匯入範例的資料列。
 * @returns {object[]}
 */
export function holdingsTemplate() {
  return [
    { 股票代號: '2330', 股數: 1000, 平均成本: 950, 備註: '範例，可自行刪除' },
    { 股票代號: '0050', 股數: 2000, 平均成本: 185, 備註: '' },
  ];
}
