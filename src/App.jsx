import { useState } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { X } from 'lucide-react';
import Header from './components/Header.jsx';
import TabBar from './components/TabBar.jsx';
import AnalysisTab from './components/tabs/AnalysisTab.jsx';
import HoldingsTab from './components/tabs/HoldingsTab.jsx';
import PendingTab from './components/tabs/PendingTab.jsx';
import { clearError } from './store/marketSlice.js';

/** 待實作分頁的功能清單，來自參考站的功能盤點。 */
const PENDING_SPECS = {
  performance: [
    '每日損益月曆',
    '週損益、當月損益、累積損益',
    '逐檔損益明細（可與券商對帳）',
    '每月損益走勢圖',
    '歷年績效總覽（年末淨值、年度績效、累積績效）',
  ],
  capital: [
    '三桶資金調度與資金瀑布',
    '進場區間判定（區間低、區間高、是否在區間）',
    '資金來源判定與 A/B/C 分類倉位',
    '賣出紀律規則（減碼指令、下車梯排程、破線）',
    '銀行現金水位與增資紀錄',
  ],
  ai: [
    '型態分析與支撐壓力區間推估',
    '短中長線操作建議',
    '風險與盲點提示',
    'AI 深度估值評估',
  ],
};

export default function App() {
  const [tab, setTab] = useState('analysis');
  const dispatch = useDispatch();
  const error = useSelector((s) => s.market.error);

  return (
    <div className="min-h-full">
      <Header />

      {error && (
        <div className="mx-auto max-w-5xl px-4 pt-3">
          <div className="flex items-start gap-2 rounded-lg border border-rose-800/60 bg-rose-950/40 p-3 text-xs text-rose-300">
            <span className="flex-1">資料取用失敗：{error}</span>
            <button type="button" onClick={() => dispatch(clearError())} className="shrink-0">
              <X size={14} />
            </button>
          </div>
        </div>
      )}

      {/* 底部保留空間，避免內容被固定導覽列遮住。 */}
      <main className="mx-auto max-w-5xl px-4 py-4 pb-24">
        {tab === 'analysis' && <AnalysisTab />}
        {tab === 'holdings' && <HoldingsTab />}
        {tab === 'performance' && <PendingTab title="績效追蹤" items={PENDING_SPECS.performance} />}
        {tab === 'capital' && <PendingTab title="資金調度" items={PENDING_SPECS.capital} />}
        {tab === 'ai' && <PendingTab title="AI 分析" items={PENDING_SPECS.ai} />}
      </main>

      <TabBar active={tab} onChange={setTab} />
    </div>
  );
}
