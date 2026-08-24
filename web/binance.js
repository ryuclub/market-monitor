// Binance 行情接入 —— REST 拉历史，WebSocket 推实时
const REST = 'https://api.binance.com/api/v3';
const WS = 'wss://stream.binance.com:9443/ws';

// 拉取历史 K线，limit 最大 1000
export async function fetchKlines(symbol, interval, limit = 1000) {
  const url = `${REST}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance ${res.status}: ${await res.text()}`);
  const raw = await res.json();
  return raw.map((k) => ({
    time: k[0] / 1000,       // lightweight-charts 用秒
    open: +k[1],
    high: +k[2],
    low: +k[3],
    close: +k[4],
    volume: +k[5],
  }));
}

// 24 小时行情摘要
export async function fetch24h(symbol) {
  const res = await fetch(`${REST}/ticker/24hr?symbol=${symbol}`);
  if (!res.ok) throw new Error(`Binance ${res.status}`);
  const d = await res.json();
  return {
    last: +d.lastPrice,
    changePct: +d.priceChangePercent,
    high: +d.highPrice,
    low: +d.lowPrice,
    volume: +d.quoteVolume,
  };
}

// 订阅实时 K线，断线自动重连
export function subscribeKlines(symbol, interval, onBar, onStatus) {
  let ws = null, closed = false, retry = 0, timer = null;

  const connect = () => {
    if (closed) return;
    const stream = `${symbol.toLowerCase()}@kline_${interval}`;
    ws = new WebSocket(`${WS}/${stream}`);

    ws.onopen = () => { retry = 0; onStatus?.('connected'); };

    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (!m.k) return;
      onBar({
        time: m.k.t / 1000,
        open: +m.k.o,
        high: +m.k.h,
        low: +m.k.l,
        close: +m.k.c,
        volume: +m.k.v,
        closed: m.k.x,          // 该根 K线是否已收盘
      });
    };

    ws.onerror = () => onStatus?.('error');

    ws.onclose = () => {
      if (closed) return;
      onStatus?.('reconnecting');
      const delay = Math.min(30000, 1000 * 2 ** retry++);
      timer = setTimeout(connect, delay);
    };
  };

  connect();
  return () => { closed = true; clearTimeout(timer); ws?.close(); };
}
