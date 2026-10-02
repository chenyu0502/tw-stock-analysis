import { healthColor } from '../lib/format.js';
import { MIN_COVERAGE } from '../lib/health.js';

/**
 * 體質燈號的精簡版，用在清單與卡片標題的名稱旁邊。
 *
 * **一律連同文字標籤顯示，不做成純色圓點。** 配色（強健琥珀、健康綠、普通灰、
 * 偏弱紅）與台股漲跌色相反——本站紅代表上漲、綠代表下跌——少了文字，
 * 紅色燈號會被讀成「今天跌」或「今天漲」，而它講的是體質，與當天漲跌無關。
 *
 * 還沒算出來時回傳 null 而不是佔位符：清單上二十幾檔會逐檔陸續載入，
 * 擺一排「—」只是雜訊。涵蓋率不足是**已經算完的結論**，那個要顯示出來。
 *
 * @param {{ health: object|null, showScore?: boolean }} props
 */
export default function HealthBadge({ health, showScore = false }) {
  if (!health) return null;

  const { light, total, coverage } = health;
  const thin = coverage < MIN_COVERAGE;
  const label = light ? light.label : '資料不足';

  return (
    <span
      className={`shrink-0 rounded border px-1.5 py-0.5 text-[11px] leading-none ${healthColor(
        light?.key
      )}`}
      title={
        thin
          ? `體質可評項目得分 ${total}，涵蓋率僅 ${coverage}%，不給等級。ETF 無財報屬正常情形。`
          : `體質總分 ${total}／100，涵蓋率 ${coverage}%。描述體質強弱，不是買賣建議。`
      }
    >
      {label}
      {showScore && !thin && <span className="tabular ml-1 opacity-70">{total}</span>}
    </span>
  );
}
