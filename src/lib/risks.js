/**
 * 規則型風險偵測。
 *
 * **不經過語言模型。** 每一條都是可查核的門檻判斷：輸入相同就得到相同結果，
 * 而且每一項都附上觸發它的實際數值，使用者可以自行驗證，也可以不同意。
 *
 * 模型產生的風險提示每次跑可能講不一樣的東西，也無從得知它是根據什麼。
 * 這裡的作法相反——先把有依據的部分列清楚，模型（若要用）只負責串成敘述。
 *
 * 門檻的取法：能用相對值就不用絕對值。「本益比 30 倍」對不同產業意義天差地遠，
 * 「本益比高於自己過去五年的 85% 時間」則是同一檔股票跟自己比，跨標的都成立。
 */

/** 嚴重度，用於排序與上色。 */
export const SEVERITY = { high: 3, medium: 2, low: 1 };

/** 各條規則的門檻。集中於此，調整時不必翻遍整個檔案。 */
export const THRESHOLDS = {
  /** 估值分位：高於此比例的歷史時間即提示 */
  pePercentileHigh: 85,
  pbPercentileHigh: 85,
  /** 5 日乖離率（%），正負皆適用 */
  bias5Extreme: 8,
  /** 20 日乖離率（%） */
  bias20Extreme: 15,
  /** 近 5 日均量對近 20 日均量的比值，低於此值視為量能萎縮 */
  volumeShrink: 0.6,
  /** 現價位於期間區間的百分位，高於此值視為相對高檔 */
  pricePositionHigh: 90,
  /** 券資比（%） */
  shortMarginRatioHigh: 30,
  /**
   * 融資暴增：張數與增幅要同時達標。
   *
   * 只看張數會讓大型股天天觸發（融資餘額本來就數萬張），
   * 只看增幅則小型股一點風吹草動就報警。兩個都要才有意義。
   */
  marginSurgeLots: 500,
  marginSurgePercent: 20,
  /** 融券暴增 */
  shortSurgeLots: 200,
  shortSurgePercent: 30,
  /** 資券同增：兩邊都增加超過此比例 */
  bothRisePercent: 10,
  /** 融券大量回補的張數 */
  shortCoverLots: 200,
  /**
   * 資增券減的門檻。
   *
   * 參考站這一條沒有設幅度門檻，於是「融資多一張、融券少一張」也算數——
   * 實測五檔就有兩檔觸發，等於天天在響。加上幅度要求才篩得出真正的異常。
   */
  marginUpPercent: 3,
  shortDownPercent: -20,
  /** 月營收年增率（%），低於此值視為衰退 */
  revenueYoyWeak: 0,
  /** 毛利率較去年同期下滑的百分點 */
  marginDropPoints: 3,
  /** 負債比（%） */
  debtRatioHigh: 60,
  /** 配發率（%），超過代表配的比賺的多 */
  payoutRatioHigh: 100,
  /** 法人連續賣超天數 */
  institutionalSellStreak: 5,
  /** RSI 超買 */
  rsiOverbought: 75,
  /**
   * 除息日在幾天內才提醒。
   *
   * 預告表涵蓋約兩個月，但兩個月後的除息現在不構成需要注意的事，
   * 全部列出只會把真正接近的那幾檔淹沒。
   */
  exDividendWithinDays: 30,
};

/**
 * 兩個日期字串相差幾天。用 UTC 正午避開時區與日光節約造成的差一天。
 * @param {string} from YYYY-MM-DD
 * @param {string} to YYYY-MM-DD
 * @returns {number|null}
 */
export function daysBetween(from, to) {
  const a = Date.parse(`${from}T12:00:00Z`);
  const b = Date.parse(`${to}T12:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

/**
 * 建立一則風險項目。
 * @param {string} id 穩定的識別碼，供介面做 key
 * @param {'high'|'medium'|'low'} severity
 * @param {string} category 分類標籤
 * @param {string} message 說明，必須包含觸發的實際數值
 * @returns {object}
 */
function risk(id, severity, category, message) {
  return { id, severity, category, message };
}

/** 格式化數字，null 一律回傳 '—'。 */
function n(value, digits = 1) {
  return Number.isFinite(value) ? value.toFixed(digits) : '—';
}

/**
 * 依規則列出風險項目。
 *
 * 每一項缺資料就跳過，不猜、也不用其他欄位硬推。
 * 回傳依嚴重度排序，同嚴重度維持規則的宣告順序，讓輸出穩定。
 *
 * @param {object} params
 * @param {object|null} [params.fundamentals] /api/fundamentals 的結果
 * @param {object|null} [params.indicators] analysisInput 的 indicators
 * @param {object|null} [params.recent] analysisInput 的 recent
 * @param {object|null} [params.chips] analysisInput 的 chips
 * @param {object|null} [params.margin] /api/margin 的單檔資料，供融資融券規則使用
 * @param {object[]} [params.chipSeries] 法人買賣超歷史，用於連續賣超判斷
 * @param {object|null} [params.dividendSchedule] 即將除權息 { date, cash, stock, kind }
 * @param {string|null} [params.today] 今日日期，供測試固定時間
 * @returns {object[]}
 */
export function detectRisks({
  fundamentals = null,
  indicators = null,
  recent = null,
  chips = null,
  margin = null,
  chipSeries = [],
  dividendSchedule = null,
  today = null,
} = {}) {
  const out = [];

  /* --- 估值 --- */
  const pe = fundamentals?.bands?.pe;
  if (pe && Number.isFinite(pe.percentile) && pe.percentile >= THRESHOLDS.pePercentileHigh) {
    out.push(
      risk(
        'pe-high',
        'medium',
        '估值',
        `本益比 ${n(pe.current)} 倍，高於自己過去 ${pe.samples} 個交易日中 ${n(pe.percentile)}% 的時間` +
          `（區間 ${n(pe.min)}～${n(pe.max)}，中位 ${n(pe.median)}）`
      )
    );
  }

  const pb = fundamentals?.bands?.pb;
  if (pb && Number.isFinite(pb.percentile) && pb.percentile >= THRESHOLDS.pbPercentileHigh) {
    out.push(
      risk(
        'pb-high',
        'medium',
        '估值',
        `股價淨值比 ${n(pb.current, 2)} 倍，位於歷史 ${n(pb.percentile)}% 分位` +
          `（區間 ${n(pb.min, 2)}～${n(pb.max, 2)}）`
      )
    );
  }

  /* --- 技術面 --- */
  if (indicators && Math.abs(indicators.bias5 ?? 0) >= THRESHOLDS.bias5Extreme) {
    const up = indicators.bias5 > 0;
    out.push(
      risk(
        'bias5',
        'medium',
        '技術面',
        `5 日乖離率 ${n(indicators.bias5)}%，${up ? '短線漲多' : '短線跌深'}，` +
          `回歸均線的力道通常在此區間轉強`
      )
    );
  }
  if (indicators && Math.abs(indicators.bias20 ?? 0) >= THRESHOLDS.bias20Extreme) {
    out.push(
      risk(
        'bias20',
        'medium',
        '技術面',
        `20 日乖離率 ${n(indicators.bias20)}%，價格已明顯偏離中期均線`
      )
    );
  }
  if (indicators && (indicators.rsi ?? 0) >= THRESHOLDS.rsiOverbought) {
    out.push(risk('rsi', 'low', '技術面', `RSI(14) 為 ${n(indicators.rsi)}，處於超買區`));
  }

  if (recent && Number.isFinite(recent.volumeRatio) && recent.volumeRatio <= THRESHOLDS.volumeShrink) {
    out.push(
      risk(
        'volume-shrink',
        'medium',
        '量能',
        `近 5 日均量僅為近 20 日均量的 ${n(recent.volumeRatio, 2)} 倍，量能萎縮，` +
          `價格變動的參考性降低`
      )
    );
  }
  if (
    recent &&
    Number.isFinite(recent.pricePosition) &&
    recent.pricePosition >= THRESHOLDS.pricePositionHigh
  ) {
    out.push(
      risk(
        'price-position',
        'low',
        '技術面',
        `現價位於近 ${recent.periodDays} 個交易日區間的 ${n(recent.pricePosition, 0)}% 位置，` +
          `處於相對高檔`
      )
    );
  }

  /* --- 籌碼面 --- */
  const streak = sellStreak(chipSeries);
  if (streak.days >= THRESHOLDS.institutionalSellStreak) {
    out.push(
      risk(
        'institutional-sell',
        'medium',
        '籌碼面',
        `外資與投信合計已連續 ${streak.days} 日賣超，期間累計 ${Math.round(streak.total).toLocaleString('zh-TW')} 張`
      )
    );
  }
  const ratio = chips?.margin?.shortMarginRatio ?? margin?.shortMarginRatio;
  if (Number.isFinite(ratio) && ratio >= THRESHOLDS.shortMarginRatioHigh) {
    out.push(risk('short-margin', 'low', '籌碼面', `券資比 ${n(ratio)}%，空方力道偏高`));
  }

  out.push(...marginAnomalies(margin));

  /* --- 基本面 --- */
  const revenue = fundamentals?.revenue;
  if (revenue && Number.isFinite(revenue.yoy3m) && revenue.yoy3m < THRESHOLDS.revenueYoyWeak) {
    out.push(
      risk(
        'revenue-decline',
        'high',
        '基本面',
        `近 3 個月營收年增率 ${n(revenue.yoy3m)}%，較去年同期衰退` +
          `（最新月份 ${revenue.latestMonth}，單月年增 ${n(revenue.yoy)}%）`
      )
    );
  }

  const margins = fundamentals?.income?.margins;
  const marginsAgo = fundamentals?.income?.marginsYearAgo;
  if (margins && marginsAgo && Number.isFinite(margins.gross) && Number.isFinite(marginsAgo.gross)) {
    const drop = marginsAgo.gross - margins.gross;
    if (drop >= THRESHOLDS.marginDropPoints) {
      out.push(
        risk(
          'margin-drop',
          'high',
          '基本面',
          `毛利率 ${n(margins.gross)}%，較去年同期的 ${n(marginsAgo.gross)}% 下滑 ${n(drop)} 個百分點`
        )
      );
    }
  }

  const debtRatio = fundamentals?.balance?.debtRatio;
  if (Number.isFinite(debtRatio) && debtRatio >= THRESHOLDS.debtRatioHigh) {
    out.push(
      risk(
        'debt-ratio',
        'low',
        '基本面',
        `負債比 ${n(debtRatio)}%（${fundamentals.balance.period}），高於六成`
      )
    );
  }

  const payout = fundamentals?.dividend?.payoutRatio;
  if (Number.isFinite(payout) && payout >= THRESHOLDS.payoutRatioHigh) {
    out.push(
      risk(
        'payout',
        'medium',
        '股利',
        `配發率 ${n(payout, 0)}%，配發金額已超過近四季每股盈餘，須動用保留盈餘`
      )
    );
  }

  /* --- 事件 --- */
  const ex = describeExDividend(dividendSchedule, today);
  if (ex) out.push(ex);

  return out.sort((a, b) => SEVERITY[b.severity] - SEVERITY[a.severity]);
}

/**
 * 即將除權息的提醒。
 *
 * 這一條與其他風險的性質不同：它不是「可能會不好」，而是「一定會發生」。
 * 除息當天股價必然扣除配息金額，帳面市值同步下降，
 * 不知情的人會以為是下跌。錢會在一個多月後入帳，只是時間差。
 *
 * 配息金額尚未定案時上游給的是「待公告實際收益分配金額」，
 * 此時金額為 null，必須寫成「金額待公告」而不是零——
 * 零會讓人以為這次不配息。
 *
 * @param {object|null} schedule { date, cash, stock, kind }
 * @param {string|null} today
 * @returns {object|null}
 */
export function describeExDividend(schedule, today = null) {
  if (!schedule?.date) return null;
  const base = today ?? new Date().toISOString().slice(0, 10);
  const days = daysBetween(base, schedule.date);
  if (days === null || days < 0 || days > THRESHOLDS.exDividendWithinDays) return null;

  const when = days === 0 ? '今日' : `${days} 天後（${schedule.date}）`;
  const parts = [];
  if (Number.isFinite(schedule.cash) && schedule.cash > 0) {
    parts.push(`每股配息 ${schedule.cash.toFixed(2)} 元`);
  }
  if (Number.isFinite(schedule.stock) && schedule.stock > 0) {
    parts.push(`無償配股率 ${schedule.stock.toFixed(4)}`);
  }
  const amount = parts.length > 0 ? parts.join('，') : '金額尚待公告';

  return risk(
    'ex-dividend',
    // 三天內視為需要注意，較遠的只是提醒。
    days <= 3 ? 'medium' : 'low',
    '事件',
    `${when}除${schedule.kind || '息'}，${amount}。` +
      `當日股價會扣除該金額，帳面市值同步下降，現金約一個多月後入帳`
  );
}

/**
 * 融資融券的異常變化。
 *
 * **只陳述事實，不標示多空方向。** 融資暴增有人讀成散戶追高、有人讀成資金流入，
 * 沒有共識；把其中一種解讀寫死在介面上，等於替使用者做了判斷。
 * 這裡只講「增加多少張、增幅多少」，方向留給使用者。
 *
 * ETF 與非信用交易個股沒有這些資料，回傳空陣列而不是零——
 * 「沒有資料」與「沒有異常」是兩件事。
 *
 * @param {object|null} m /api/margin 的單檔資料
 * @returns {object[]}
 */
function marginAnomalies(m) {
  if (!m) return [];
  const out = [];
  const lots = (v) => (Number.isFinite(v) ? Math.round(v).toLocaleString('zh-TW') : '—');

  const mc = m.marginChange;
  const mp = m.marginChangePercent;
  const sc = m.shortChange;
  const sp = m.shortChangePercent;

  if (
    Number.isFinite(mc) &&
    Number.isFinite(mp) &&
    mc >= THRESHOLDS.marginSurgeLots &&
    mp >= THRESHOLDS.marginSurgePercent
  ) {
    out.push(
      risk(
        'margin-surge',
        'medium',
        '籌碼面',
        `融資單日增加 ${lots(mc)} 張（增幅 ${n(mp)}%），餘額來到 ${lots(m.marginBalance)} 張`
      )
    );
  }

  if (
    Number.isFinite(sc) &&
    Number.isFinite(sp) &&
    sc >= THRESHOLDS.shortSurgeLots &&
    sp >= THRESHOLDS.shortSurgePercent
  ) {
    out.push(
      risk(
        'short-surge',
        'medium',
        '籌碼面',
        `融券單日增加 ${lots(sc)} 張（增幅 ${n(sp)}%），餘額來到 ${lots(m.shortBalance)} 張`
      )
    );
  }

  if (
    Number.isFinite(mp) &&
    Number.isFinite(sp) &&
    mp > THRESHOLDS.bothRisePercent &&
    sp > THRESHOLDS.bothRisePercent
  ) {
    out.push(
      risk(
        'margin-short-both-up',
        'low',
        '籌碼面',
        `融資與融券同步增加（融資 ${n(mp)}%、融券 ${n(sp)}%），多空雙方同時加碼`
      )
    );
  }

  if (
    Number.isFinite(mp) &&
    Number.isFinite(sp) &&
    mp > THRESHOLDS.marginUpPercent &&
    sp < THRESHOLDS.shortDownPercent
  ) {
    out.push(
      risk(
        'margin-up-short-down',
        'low',
        '籌碼面',
        `融資增加 ${n(mp)}%、融券減少 ${n(Math.abs(sp))}%`
      )
    );
  }

  if (Number.isFinite(sc) && -sc >= THRESHOLDS.shortCoverLots) {
    out.push(
      risk(
        'short-cover',
        'low',
        '籌碼面',
        `融券單日減少 ${lots(-sc)} 張，餘額剩 ${lots(m.shortBalance)} 張`
      )
    );
  }

  return out;
}

/**
 * 外資加投信的連續賣超天數。
 *
 * 自營商不計入：其買賣多為避險與造市部位，方向不代表對個股的看法。
 * 淨額為零視為中斷，與 chips.js 的 streak 採同一個約定。
 *
 * @param {object[]} series 由舊到新的法人買賣超序列
 * @returns {{days:number, total:number}}
 */
export function sellStreak(series) {
  if (!Array.isArray(series) || series.length === 0) return { days: 0, total: 0 };
  let days = 0;
  let total = 0;
  for (let i = series.length - 1; i >= 0; i -= 1) {
    const net = (series[i].foreign ?? 0) + (series[i].trust ?? 0);
    if (net >= 0) break;
    days += 1;
    total += net;
  }
  return { days, total };
}
