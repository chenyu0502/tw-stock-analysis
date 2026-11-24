// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { quoteHandler } from './handlers.js';

/**
 * 報價端點的取價與補價。
 *
 * 這些情形全是線上真的發生過的，不是想像出來的邊界：跌停鎖死時 MIS 三個價格
 * 欄位都空、收盤後官方日行情還沒公布、以及持股一多就整批不補價。
 */

const J = (body) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

/** MIS 的一列報價，只填 quoteHandler 會讀的欄位。 */
function misRow(code, over = {}) {
  return {
    c: code,
    n: '測試',
    ex: 'tse',
    y: '100.0000',
    u: '110.0000',
    w: '90.0000',
    o: '99.0000',
    h: '101.0000',
    l: '98.0000',
    v: '500',
    d: '20261124',
    t: '10:30:00',
    z: '99.0000',
    b: '98.9000',
    a: '99.1000',
    ...over,
  };
}

const realNow = Date.now;

/** 把時間釘在指定的台北時刻，收盤校正的閘門才測得準。 */
function freezeTaipei(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const utc = Date.UTC(2026, 10, 24, h - 8, m, 0);
  Date.now = () => utc;
}

/**
 * 架設上游。
 * @param {object[]} rows MIS 回傳的列
 * @param {{ yahoo?: number|null, official?: number|null }} [upstream]
 *   yahoo 為 null 代表取不到；official 為 null 代表官方尚未公布
 */
function stubUpstreams(rows, { yahoo = null, official = null } = {}) {
  const calls = { mis: 0, yahoo: 0, official: 0 };
  globalThis.fetch = vi.fn(async (url) => {
    const u = String(url);
    if (u.includes('mis.twse')) {
      calls.mis += 1;
      return J({ msgArray: rows });
    }
    if (u.includes('STOCK_DAY') || u.includes('tpex')) {
      calls.official += 1;
      if (official === null) return J({ stat: 'OK', fields: [], data: [] });
      return J({
        stat: 'OK',
        fields: ['日期', '成交股數', '成交金額', '開盤價', '最高價', '最低價', '收盤價', '漲跌價差', '成交筆數'],
        data: [['115/11/24', '1,000', '1,000', '99.00', '101.00', '98.00', official.toFixed(2), '0.00', '10']],
      });
    }
    if (u.includes('query1.finance.yahoo')) {
      calls.yahoo += 1;
      if (yahoo === null) throw new Error('Yahoo 取不到');
      return J({
        chart: {
          result: [{ meta: { regularMarketPrice: yahoo }, indicators: { quote: [{ close: [yahoo] }] } }],
        },
      });
    }
    throw new Error(`未預期的上游：${u}`);
  });
  return calls;
}

// 代號每次都換新的，否則會打到上一個測試留下的伺服器端快取。
let seq = 1000;
const nextCode = () => String((seq += 1));

beforeEach(() => freezeTaipei('10:30'));
afterEach(() => {
  Date.now = realNow;
  vi.restoreAllMocks();
});

describe('現價的取值順序', () => {
  it('z 有效時直接用，不碰委託簿也不打 Yahoo', async () => {
    const code = nextCode();
    const calls = stubUpstreams([misRow(code, { z: '99.0000' })]);
    const q = (await quoteHandler({ codes: code })).body.quotes[code];
    expect(q.price).toBe(99);
    expect(calls.yahoo).toBe(0);
  });

  it('z 無效時退回最佳委買（盤前掛單的既有行為）', async () => {
    const code = nextCode();
    stubUpstreams([misRow(code, { z: '-', b: '98.5000', a: '99.5000', v: '0' })]);
    expect((await quoteHandler({ codes: code })).body.quotes[code].price).toBe(98.5);
  });

  it('跌停鎖死：買盤被吃光，退回最佳委賣', async () => {
    const code = nextCode();
    stubUpstreams([misRow(code, { z: '-', b: '', a: '90.0000' })]);
    const q = (await quoteHandler({ codes: code })).body.quotes[code];
    expect(q.price).toBe(90);
    expect(q.change).toBe(-10);
  });

  it('z 回 0.0000 視為無效，不得算成 -100%', async () => {
    const code = nextCode();
    stubUpstreams([misRow(code, { z: '0.0000', b: '', a: '90.0000' })]);
    expect((await quoteHandler({ codes: code })).body.quotes[code].price).toBe(90);
  });

  it('盤前（成交量為零）三欄皆空時才退回昨收', async () => {
    const code = nextCode();
    stubUpstreams([misRow(code, { z: '-', b: '', a: '', v: '0' })]);
    const q = (await quoteHandler({ codes: code })).body.quotes[code];
    expect(q.price).toBe(100);
    expect(q.change).toBe(0);
  });

  it('已有成交量卻三欄皆空、Yahoo 也取不到 → null，絕不退回昨收偽裝成平盤', async () => {
    const code = nextCode();
    stubUpstreams([misRow(code, { z: '-', b: '', a: '', v: '500' })], { yahoo: null });
    const q = (await quoteHandler({ codes: code })).body.quotes[code];
    expect(q.price).toBeNull();
    expect(q.change).toBeNull();
  });
});

describe('MIS 沒給價格時向 Yahoo 補價', () => {
  it('補得到就用，並標記來源', async () => {
    const code = nextCode();
    stubUpstreams([misRow(code, { z: '-', b: '', a: '', v: '500' })], { yahoo: 95 });
    const q = (await quoteHandler({ codes: code })).body.quotes[code];
    expect(q.price).toBe(95);
    expect(q.change).toBe(-5);
    expect(q.priceSource).toBe('yahoo');
  });

  it('缺價檔數超過上限時只補前 20 檔，不是整批放棄', async () => {
    // 這正是「分析頁有價、績效頁沒有」的成因：績效頁一次要三十檔，
    // 缺價數超過上限就整批不補；分析頁的清單短，同一檔反而補得到。
    const codes = Array.from({ length: 30 }, () => nextCode());
    const calls = stubUpstreams(
      codes.map((c) => misRow(c, { z: '-', b: '', a: '', v: '500' })),
      { yahoo: 95 }
    );
    const quotes = (await quoteHandler({ codes: codes.join(',') })).body.quotes;
    const filled = codes.filter((c) => quotes[c].price === 95);
    expect(filled).toHaveLength(20);
    expect(calls.yahoo).toBe(20);
    // 補不到的那些維持 null，不會變成昨收。
    expect(codes.filter((c) => quotes[c].price === null)).toHaveLength(10);
  });

  it('全部都有價格時一次 Yahoo 都不打', async () => {
    const codes = Array.from({ length: 30 }, () => nextCode());
    const calls = stubUpstreams(codes.map((c) => misRow(c)));
    await quoteHandler({ codes: codes.join(',') });
    expect(calls.yahoo).toBe(0);
  });
});

describe('收盤校正', () => {
  it('盤中完全不觸發', async () => {
    const code = nextCode();
    const calls = stubUpstreams([misRow(code)], { official: 99.5 });
    expect((await quoteHandler({ codes: code })).body.quotes[code].price).toBe(99);
    expect(calls.official).toBe(0);
  });

  it('收盤後官方已公布 → 用官方收盤價，即使 MIS 的成交時間停在盤中', async () => {
    freezeTaipei('14:40');
    const code = nextCode();
    stubUpstreams([misRow(code, { t: '11:20:00', z: '99.0000' })], { official: 99.5 });
    const q = (await quoteHandler({ codes: code })).body.quotes[code];
    expect(q.price).toBe(99.5);
    expect(q.priceSource).toBeUndefined();
  });

  it('收盤後官方未公布、MIS 沒看到收盤 → 退而用 Yahoo', async () => {
    freezeTaipei('13:45');
    const code = nextCode();
    stubUpstreams([misRow(code, { t: '11:20:00' })], { official: null, yahoo: 98 });
    const q = (await quoteHandler({ codes: code })).body.quotes[code];
    expect(q.price).toBe(98);
    expect(q.priceSource).toBe('yahoo');
  });

  it('收盤後 MIS 已看到收盤 → 信任 MIS，不問 Yahoo', async () => {
    freezeTaipei('13:45');
    const code = nextCode();
    const calls = stubUpstreams([misRow(code, { t: '13:30:00', z: '98.0000' })], {
      official: null,
      yahoo: 97,
    });
    expect((await quoteHandler({ codes: code })).body.quotes[code].price).toBe(98);
    expect(calls.yahoo).toBe(0);
  });

  it('報價不是今天的（假日）→ 整段跳過', async () => {
    freezeTaipei('14:40');
    const code = nextCode();
    const calls = stubUpstreams([misRow(code, { d: '20261123' })], { official: 99.5 });
    expect((await quoteHandler({ codes: code })).body.quotes[code].price).toBe(99);
    expect(calls.official).toBe(0);
  });
});

describe('上游回應異常', () => {
  it('MIS 沒有 msgArray 視為取用失敗，往上拋而不是回空報價', async () => {
    const code = nextCode();
    globalThis.fetch = vi.fn(async () => J({ rtmessage: 'OK' }));
    await expect(quoteHandler({ codes: code })).rejects.toThrow(/即時報價/);
  });

  it('MIS 沒回某幾檔時列在 missing，不是靜靜消失', async () => {
    const [a, b] = [nextCode(), nextCode()];
    stubUpstreams([misRow(a)]);
    const body = (await quoteHandler({ codes: `${a},${b}` })).body;
    expect(Object.keys(body.quotes)).toEqual([a]);
    expect(body.missing).toEqual([b]);
  });
});
