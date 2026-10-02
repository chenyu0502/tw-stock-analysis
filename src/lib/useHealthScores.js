import { useEffect, useMemo, useRef } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { loadFundamentals, loadPeers, loadHistory, isHistoryStale } from '../store/marketSlice.js';
import { computeHealth, trendInputFromCandles } from './health.js';

/**
 * 一次替多檔算出體質評分，供清單上的燈號使用。
 *
 * **財報必須排隊載入。** 一檔要打五個 FinMind 資料集，持有二十幾檔時一次送出就是
 * 上百個上游請求——免費方案每小時 600 次，開兩次頁面就用掉大半，而且那種請求形狀
 * 正是先前把函式打到逾時的那一種。因此改成逐檔排隊：一檔落地才送下一檔，
 * 燈號會由上往下陸續出現。
 *
 * 伺服器端的財報快取是 24 小時，因此這個排隊只有每天第一次開頁時會感覺到。
 *
 * 歷史 K 線不排隊：它走 Yahoo 與證交所，沒有額度限制，而且分析頁本來就是整批載入。
 *
 * @param {string[]} codes 要計算的代號
 * @returns {Record<string, object>} 代號對應到 computeHealth 的結果，尚未算出的不會有鍵
 */
export function useHealthScores(codes) {
  const dispatch = useDispatch();
  const fundamentalsMap = useSelector((s) => s.market.fundamentals);
  const peersMap = useSelector((s) => s.market.peers);
  const historyMap = useSelector((s) => s.market.history);

  const codesKey = codes.join(',');

  // 歷史 K 線。範圍取一年：120 日均線只需要約半年，一年已足夠，
  // 且與分析頁的個股卡片同一個範圍，不會互相覆蓋對方的快取。
  useEffect(() => {
    if (!codesKey) return;
    for (const code of codesKey.split(',')) {
      if (isHistoryStale(historyMap[code])) dispatch(loadHistory({ code, range: '1y' }));
    }
    // historyMap 刻意不列入相依，否則每寫入一筆快取就會重新觸發整批載入。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [codesKey, dispatch]);

  useSerialQueue(codesKey, fundamentalsMap, (code) => dispatch(loadFundamentals({ code })));
  useSerialQueue(codesKey, peersMap, (code) => dispatch(loadPeers({ code })));

  return useMemo(() => {
    const out = {};
    for (const code of codesKey ? codesKey.split(',') : []) {
      const fundamentals = fundamentalsMap[code];
      // 財報還沒回來就先不給燈號。只靠趨勢算出來的分數涵蓋率僅兩成，
      // 會先顯示一個「資料不足」再跳成正式等級，閃動比等待更難讀。
      if (!fundamentals) continue;

      const { price, indicators } = trendInputFromCandles(historyMap[code]?.candles ?? []);
      const health = computeHealth({
        price,
        indicators,
        fundamentals,
        peers: peersMap[code] ?? null,
      });
      if (health) out[code] = health;
    }
    return out;
  }, [codesKey, fundamentalsMap, peersMap, historyMap]);
}

/**
 * 逐檔排隊派發：一檔落地（成功或失敗）才送下一檔。
 *
 * 失敗也會前進——marketSlice 的 rejected 會把 { available: false, reason } 寫進
 * 對應的鍵，因此佇列不會卡在一檔取不到的標的上。
 *
 * @param {string} codesKey 以逗號相連的代號清單
 * @param {Record<string, object>} map 載入結果所在的 store 切片
 * @param {(code: string) => void} send 派發函式
 */
function useSerialQueue(codesKey, map, send) {
  // 已經送出過的代號。沒有這個紀錄，載入失敗的標的會被無限重送。
  const requested = useRef(new Set());
  const inFlight = useRef(null);

  useEffect(() => {
    if (!codesKey) return;
    // 上一檔還沒落地就等著。
    if (inFlight.current && !map[inFlight.current]) return;
    inFlight.current = null;

    const next = codesKey.split(',').find((c) => !map[c] && !requested.current.has(c));
    if (!next) return;

    requested.current.add(next);
    inFlight.current = next;
    send(next);
    // send 每次 render 都是新的函式，列入相依會讓這個 effect 每次都重跑。
    // 佇列的前進條件完全由 codesKey 與 map 決定，不需要它。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [codesKey, map]);
}
