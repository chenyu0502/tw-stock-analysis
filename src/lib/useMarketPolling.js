import { useEffect, useRef } from 'react';
import { isMarketDataWindow } from './marketHours.js';

/**
 * 在台股資料可能變動的時段內定時執行。
 *
 * 專門用來取代裸用的 setInterval。裸用的問題不在於它會壞，而在於它**永遠不會停**：
 * 一個整晚沒關的分頁，30 秒的輪詢就是每天約 2,880 次請求，其中大多數打的是
 * 收盤後不會再變的數字；手機把分頁丟在背景也照打，耗電耗流量，而使用者看不到結果。
 *
 * 兩道閘門：
 * 1. 分頁不在前景就跳過。
 * 2. 不在交易時段就跳過（判定見 marketHours.js）。
 *
 * 首次取得資料由呼叫端自行負責，這個 hook 只管後續的定時更新。兩者的條件不同——
 * 開頁時就算是半夜也該把最後一次收盤的數字顯示出來。
 *
 * @param {() => void} task 要定時執行的動作，不需要是穩定的參考
 * @param {number} intervalMs 間隔
 */
export function useMarketPolling(task, intervalMs) {
  // 以 ref 持有最新的 task，呼叫端就不必為了避免重設計時器而包 useCallback。
  const taskRef = useRef(task);
  useEffect(() => {
    taskRef.current = task;
  });

  // 起始值取掛載時間，而不是 0。呼叫端在掛載時已經取過一次資料，
  // 從 0 起算會讓「掛載後隨即切走再切回來」多打一次。
  const lastRunAt = useRef(Date.now());

  useEffect(() => {
    const run = () => {
      if (document.visibilityState !== 'visible') return;
      if (!isMarketDataWindow()) return;
      lastRunAt.current = Date.now();
      taskRef.current();
    };

    const timer = setInterval(run, intervalMs);

    // 回到前景時補一次。分頁放著幾小時再回來看是最常見的情境，
    // 只靠計時器會讓使用者先看到一段時間前的數字。
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      // 距上次執行未滿一個間隔就不補，否則在分頁之間來回切換會變成每切一次打一次。
      if (Date.now() - lastRunAt.current < intervalMs) return;
      run();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [intervalMs]);
}
