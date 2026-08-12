# 台股分析

台股投資組合的技術面、籌碼面與損益追蹤工具。

## 目前完成度

| 分頁 | 狀態 | 內容 |
|---|---|---|
| 分析 | 已完成 | 標的清單管理、K 線與雙均線圖、技術指標、估值、籌碼面、均線參數回測最佳化 |
| 持股 | 已完成 | 部位記錄、加權平均成本、市值與未實現損益、資金水位、集中度風險警示 |
| 績效 | 待實作 | 規格未定 |
| 資金 | 待實作 | 規格未定 |
| AI | 待實作 | 第一版不接 AI |

## 環境需求

- Node.js 20 以上（開發機實測 v24.19.0）
- npm 11 以上

## 安裝與啟動

```bash
npm install
```

```bash
npm run dev
```

開發伺服器啟動於 <http://localhost:5173>。

## 環境變數

複製 `.env.example` 為 `.env.local` 後填入。

| 變數 | 必要 | 說明 |
|---|---|---|
| `VITE_FIREBASE_*` | 否 | Firebase 網頁設定。未填時以純本機模式運作，資料只存 localStorage |
| `FINMIND_TOKEN` | 否 | FinMind API token。僅用於三大法人的歷史序列查詢，當日買賣超不需要 |

`VITE_` 前綴的變數會打包進前端，屬公開資訊；`FINMIND_TOKEN` 沒有前綴，只在伺服器端使用，不會外洩。

### Firebase 設定

1. Authentication 啟用 Google 登入。
2. Authentication → Settings → 授權網域，加入 `localhost` 與正式網域。
3. Firestore Database → 規則，貼上 `firestore.rules` 的內容後發布。

未完成上述設定時，應用程式仍可使用，只是沒有登入與跨裝置同步。

## 架構

```
api/                     資料代理層
  _lib/http.js           帶重試與逾時的上游取用
  _lib/cache.js          伺服器端記憶體快取
  _lib/handlers.js       所有端點的實作（純函式）
  _lib/adapter.js        接到 Vercel serverless function 介面
  *.js                   Vercel function 進入點
src/
  lib/indicators.js      技術指標與回測
  lib/firebase.js        登入與雲端同步
  lib/format.js          顯示格式化（含台股紅漲綠跌慣例）
  lib/excel.js           Excel 與 JSON 匯入匯出
  services/stockApi.js   前端資料取用
  store/                 Redux 狀態與持久化
  components/            UI
vite-plugin-local-api.js 開發模式的 API 中介層
```

### 為什麼要有 `api/` 這一層

台股資料來源（證交所、櫃買中心、Yahoo Finance）都不允許瀏覽器直接跨域呼叫。
常見做法是繞經公開 CORS proxy，但那些 proxy 不穩定、有流量限制，且會看到全部請求內容。

這個專案改由自己的伺服器端直連上游：

- 開發時由 `vite-plugin-local-api.js` 掛在 dev server 的 `/api/*`
- 正式環境由 Vercel 把 `api/*.js` 部署成 serverless function

兩邊呼叫的是同一份 `handlers.js`，不會出現只在其中一邊會壞的問題。

## 資料來源

| 資料 | 來源 | 端點 |
|---|---|---|
| 即時報價 | 證交所 MIS | `mis.twse.com.tw/stock/api/getStockInfo.jsp` |
| 歷史 K 線 | Yahoo Finance | `query1.finance.yahoo.com/v8/finance/chart` |
| 上市融資融券 | 證交所 OpenAPI | `/v1/exchangeReport/MI_MARGN` |
| 上櫃融資融券 | 櫃買中心 OpenAPI | `/v1/tpex_mainboard_margin_balance` |
| 上市三大法人 | 證交所官網 | `/rwd/zh/fund/T86` |
| 上櫃三大法人 | 櫃買中心 OpenAPI | `/v1/tpex_3insti_daily_trading` |
| 上市估值 | 證交所 OpenAPI | `/v1/exchangeReport/BWIBBU_ALL` |
| 上櫃估值 | 櫃買中心 OpenAPI | `/v1/tpex_mainboard_peratio_analysis` |
| 代號對照 | 兩者合併 | `STOCK_DAY_ALL` 與 `tpex_mainboard_quotes` |

上游欄位名稱極不一致：證交所融資融券用中文鍵名，櫃買中心的三大法人鍵名帶有不規則空格，
證交所 OpenAPI 並未提供 T86。因此 `handlers.js` 一律以樣式比對取值，不寫死鍵名。

### 單位慣例

對外一律以「張」為股票數量單位。上游來源單位不一致（法人資料為股、融資融券為張、
Yahoo 成交量為股），全部在 `handlers.js` 換算完畢，前端不需處理單位。

## 技術指標

`src/lib/indicators.js` 提供 SMA、EMA、MACD (12,26,9)、KD (9,3,3)、RSI (14)、
乖離率、布林通道、ATR，以及均線交叉狀態判定。

所有函式回傳與輸入等長的陣列，資料不足處填 `null`，可直接與 K 線序列對齊繪圖。

### 均線參數回測

「回測最佳化」掃描 68 組短長均線組合，以只做多的交叉策略回測，選出報酬率最高者。

實作上的兩個取捨：

1. **用隔日開盤價成交，不用當日收盤價。** 訊號要到當日收盤才成立，若以當日收盤價成交
   等於用了未來資訊，會高估績效。
2. **候選參數刻意不做全範圍暴力搜尋。** 組合數過多會嚴重過度配適，選出的參數對未來沒有意義。

最大回檔採逐日結算帳面權益，不是只在平倉時取樣。只看平倉會讓一組全部獲利出場的參數
算出零回檔，但持倉期間可能經歷過三成的帳面虧損，那才是實際交易時會讓人出場的數字。

回測結果同時顯示買進持有報酬率作為對照組。策略贏不過買進持有就沒有使用價值。

## 部署

推送到 GitHub 後於 Vercel 匯入專案，框架選 Vite，並在專案設定中加入環境變數
（`VITE_FIREBASE_*` 與 `FINMIND_TOKEN`）。`vercel.json` 已設定好 SPA 轉址規則與 API 路徑排除。

部署後記得到 Firebase Authentication 的授權網域加入 Vercel 網域，否則登入會失敗。

## 免責聲明

本工具整理公開資訊並計算技術指標，不構成投資建議。回測的歷史績效不保證未來結果。
