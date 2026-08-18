import { useState } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { X } from 'lucide-react';
import Header from './components/Header.jsx';
import TabBar from './components/TabBar.jsx';
import UpdateBanner from './components/UpdateBanner.jsx';
import AnalysisTab from './components/tabs/AnalysisTab.jsx';
import HoldingsTab from './components/tabs/HoldingsTab.jsx';
import PerformanceTab from './components/tabs/PerformanceTab.jsx';
import AiTab from './components/tabs/AiTab.jsx';
import { clearError } from './store/marketSlice.js';

export default function App() {
  const [tab, setTab] = useState('analysis');
  const dispatch = useDispatch();
  const error = useSelector((s) => s.market.error);

  return (
    <div className="min-h-full">
      <UpdateBanner />
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
        {tab === 'performance' && <PerformanceTab />}
        {tab === 'ai' && <AiTab />}
      </main>

      <TabBar active={tab} onChange={setTab} />
    </div>
  );
}
