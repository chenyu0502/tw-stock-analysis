import { useState } from 'react';
import { ExternalLink, KeyRound } from 'lucide-react';
import { GEMINI_KEY_PATTERN, getGeminiKey, maskGeminiKey, setGeminiKey } from '../lib/geminiKey.js';

/**
 * AI 頁上方的 Gemini API 金鑰設定。
 *
 * 台股開放給所有登入的使用者後，AI 解讀要用每個人自己的金鑰。
 * 金鑰只存在這台瀏覽器（按帳號分開），送出分析時才交給伺服器轉給 Google。
 *
 * @param {{ highlight?: boolean }} props highlight：剛才的分析因為沒有金鑰而失敗，把區塊標示出來
 */
export default function GeminiKeyPanel({ highlight = false }) {
  const [saved, setSaved] = useState(() => getGeminiKey());
  const [editing, setEditing] = useState(() => !getGeminiKey());
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');

  function handleSave(e) {
    e.preventDefault();
    const value = draft.trim();
    if (!GEMINI_KEY_PATTERN.test(value)) {
      setError('金鑰格式不正確：應為 20 字以上的英數字（Google AI Studio 產生的金鑰通常以 AIza 開頭）。');
      return;
    }
    if (!setGeminiKey(value)) {
      setError('無法儲存（瀏覽器可能是無痕模式或停用了本機儲存）。');
      return;
    }
    setSaved(value);
    setDraft('');
    setError('');
    setEditing(false);
  }

  function handleRemove() {
    setGeminiKey('');
    setSaved('');
    setDraft('');
    setEditing(true);
  }

  if (saved && !editing) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/50 px-3 py-2 text-xs text-slate-400">
        <KeyRound size={14} className="text-emerald-400" aria-hidden="true" />
        <span>
          Gemini API Key：<span className="tabular text-slate-200">{maskGeminiKey(saved)}</span>
          （只存在這台瀏覽器）
        </span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="rounded border border-slate-700 px-2 py-1 text-slate-300 transition hover:border-slate-500 hover:text-white"
        >
          更換
        </button>
        <button
          type="button"
          onClick={handleRemove}
          className="rounded border border-rose-900/70 px-2 py-1 text-rose-300 transition hover:border-rose-700"
        >
          移除
        </button>
      </div>
    );
  }

  return (
    <form
      onSubmit={handleSave}
      className={`space-y-2 rounded-xl border p-4 ${
        highlight ? 'border-amber-600 bg-amber-950/30' : 'border-slate-800 bg-slate-900/60'
      }`}
    >
      <div className="flex items-center gap-2 text-sm font-medium text-slate-100">
        <KeyRound size={16} className="text-amber-400" aria-hidden="true" />
        AI 解讀需要你自己的 Gemini API Key
      </div>
      <p className="text-xs leading-relaxed text-slate-400">
        金鑰只存在這台瀏覽器，送出分析時由伺服器轉交給 Google，不會被儲存；費用與額度算在你自己的 Google
        帳號。上方的價位結構、估值與風險提示是程式計算的，不需要金鑰。
        <a
          href="https://aistudio.google.com/apikey"
          target="_blank"
          rel="noreferrer"
          className="ml-1 inline-flex items-center gap-0.5 text-sky-400 hover:text-sky-300"
        >
          到 Google AI Studio 取得金鑰 <ExternalLink size={11} aria-hidden="true" />
        </a>
      </p>
      <div className="flex flex-wrap gap-2">
        <label htmlFor="gemini-key" className="sr-only">
          Gemini API Key
        </label>
        <input
          id="gemini-key"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="貼上你的 Gemini API Key"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setError('');
          }}
          className="tabular min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-sky-600 focus:outline-none"
        />
        <button
          type="submit"
          disabled={!draft.trim()}
          className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-sky-500 disabled:opacity-40"
        >
          儲存
        </button>
        {saved && (
          <button
            type="button"
            onClick={() => {
              setEditing(false);
              setDraft('');
              setError('');
            }}
            className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 transition hover:border-slate-500"
          >
            取消
          </button>
        )}
      </div>
      {error && <p className="text-xs text-rose-300">{error}</p>}
    </form>
  );
}
