// 技术指标计算 —— 纯函数，输入 number[]，输出等长数组（前置 null）
export const NA = null;

export function sma(src, period) {
  const out = new Array(src.length).fill(NA);
  let sum = 0;
  for (let i = 0; i < src.length; i++) {
    sum += src[i];
    if (i >= period) sum -= src[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(src, period) {
  const out = new Array(src.length).fill(NA);
  const k = 2 / (period + 1);
  let prev = null;
  for (let i = 0; i < src.length; i++) {
    if (i === period - 1) {
      let s = 0;
      for (let j = 0; j < period; j++) s += src[j];
      prev = s / period;
      out[i] = prev;
    } else if (i >= period) {
      prev = src[i] * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

export function stddev(src, period) {
  const out = new Array(src.length).fill(NA);
  const m = sma(src, period);
  for (let i = period - 1; i < src.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += (src[j] - m[i]) ** 2;
    out[i] = Math.sqrt(s / period);
  }
  return out;
}

// 布林带：中轨 SMA20，上下轨 ±2σ
export function bollinger(src, period = 20, mult = 2) {
  const mid = sma(src, period);
  const sd = stddev(src, period);
  const upper = mid.map((v, i) => (v === NA ? NA : v + mult * sd[i]));
  const lower = mid.map((v, i) => (v === NA ? NA : v - mult * sd[i]));
  return { mid, upper, lower };
}

// RSI —— Wilder 平滑
export function rsi(close, period = 14) {
  const out = new Array(close.length).fill(NA);
  if (close.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = close[i] - close[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let ag = gain / period, al = loss / period;
  out[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = period + 1; i < close.length; i++) {
    const d = close[i] - close[i - 1];
    const g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
    ag = (ag * (period - 1) + g) / period;
    al = (al * (period - 1) + l) / period;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}

// MACD(12,26,9)
export function macd(close, fast = 12, slow = 26, signal = 9) {
  const ef = ema(close, fast), es = ema(close, slow);
  const dif = ef.map((v, i) => (v === NA || es[i] === NA ? NA : v - es[i]));
  const valid = dif.filter((v) => v !== NA);
  const sigValid = ema(valid, signal);
  const offset = dif.length - valid.length;
  const dea = new Array(close.length).fill(NA);
  for (let i = 0; i < sigValid.length; i++) dea[i + offset] = sigValid[i];
  const hist = dif.map((v, i) => (v === NA || dea[i] === NA ? NA : (v - dea[i]) * 2));
  return { dif, dea, hist };
}

// ATR —— 用于止损距离
export function atr(high, low, close, period = 14) {
  const tr = new Array(close.length).fill(NA);
  tr[0] = high[0] - low[0];
  for (let i = 1; i < close.length; i++) {
    tr[i] = Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1]));
  }
  return ema(tr, period);
}

// 价格分位：当前价在近 N 根 K线 [最低,最高] 区间的百分位
export function pricePercentile(high, low, close, lookback) {
  const n = close.length;
  if (n < 2) return NA;
  const start = Math.max(0, n - lookback);
  let hi = -Infinity, lo = Infinity;
  for (let i = start; i < n; i++) { if (high[i] > hi) hi = high[i]; if (low[i] < lo) lo = low[i]; }
  if (hi === lo) return 50;
  return ((close[n - 1] - lo) / (hi - lo)) * 100;
}

// 摆动高低点 —— 前后各 span 根都不更极端，则认定为局部极值
export function swingPoints(high, low, span = 5) {
  const highs = [], lows = [];
  for (let i = span; i < high.length - span; i++) {
    let isH = true, isL = true;
    for (let j = i - span; j <= i + span; j++) {
      if (j === i) continue;
      if (high[j] >= high[i]) isH = false;
      if (low[j] <= low[i]) isL = false;
    }
    if (isH) highs.push({ i, price: high[i] });
    if (isL) lows.push({ i, price: low[i] });
  }
  return { highs, lows };
}

// 把摆动点按价格聚类，得出真实的支撑/压力密集区
export function clusterLevels(points, tolerancePct = 0.6) {
  if (!points.length) return [];
  const sorted = [...points].sort((a, b) => a.price - b.price);
  const groups = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    const g = groups[groups.length - 1];
    const ref = g.reduce((s, p) => s + p.price, 0) / g.length;
    if (Math.abs(sorted[i].price - ref) / ref * 100 <= tolerancePct) g.push(sorted[i]);
    else groups.push([sorted[i]]);
  }
  return groups
    .map((g) => ({
      price: g.reduce((s, p) => s + p.price, 0) / g.length,
      touches: g.length,
      lastIdx: Math.max(...g.map((p) => p.i)),
    }))
    .sort((a, b) => b.touches - a.touches);
}
