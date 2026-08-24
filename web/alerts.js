// 价格提醒 —— 本地存储 + 浏览器通知 + 页内弹窗 + 提示音
const KEY = 'mm_alerts_v1';

let alerts = load();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }   // 隐私模式 / 禁用存储时静默降级
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(alerts)); } catch { /* 存不了就只在本次会话有效 */ }
}

export function list(symbol) {
  return symbol ? alerts.filter((a) => a.symbol === symbol) : alerts.slice();
}

export function add(symbol, price, curPrice, tolPct, note) {
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) return { ok: false, msg: '价格无效' };
  if (alerts.some((a) => a.symbol === symbol && Math.abs(a.price - p) < p * 1e-6)) {
    return { ok: false, msg: '这个价位已经设过了' };
  }
  alerts.push({
    id: (alerts.reduce((m, a) => Math.max(m, a.id), 0) || 0) + 1,
    symbol,
    price: p,
    // 方向在创建时按当时价格锁定，之后价格怎么动都不改，否则会来回反复触发
    dir: p >= curPrice ? 'up' : 'down',
    tolPct: Number.isFinite(+tolPct) && +tolPct >= 0 ? +tolPct : 0.1,
    note: note || '',
    fired: false,
    firedAt: null,
  });
  save();
  return { ok: true };
}

export function remove(id) {
  alerts = alerts.filter((a) => a.id !== id);
  save();
}

export function reset(id) {
  const a = alerts.find((x) => x.id === id);
  if (a) { a.fired = false; a.firedAt = null; save(); }
}

export function clearFired(symbol) {
  alerts = alerts.filter((a) => !(a.fired && (!symbol || a.symbol === symbol)));
  save();
}

// 触发价：向上的提醒提前 tol 触发（接近就提醒），向下的同理
export function triggerPrice(a) {
  return a.dir === 'up'
    ? a.price * (1 - a.tolPct / 100)
    : a.price * (1 + a.tolPct / 100);
}

// 返回本次新触发的提醒。已触发过的不再重复。
export function check(symbol, price) {
  const fired = [];
  for (const a of alerts) {
    if (a.symbol !== symbol || a.fired) continue;
    const t = triggerPrice(a);
    if ((a.dir === 'up' && price >= t) || (a.dir === 'down' && price <= t)) {
      a.fired = true;
      a.firedAt = Date.now();
      fired.push({ ...a, hitPrice: price });
    }
  }
  if (fired.length) save();
  return fired;
}

// ---------- 通知 ----------
export function permissionState() {
  if (!('Notification' in window)) return 'unsupported';
  return Notification.permission;      // default / granted / denied
}

export async function requestPermission() {
  if (!('Notification' in window)) return 'unsupported';
  try { return await Notification.requestPermission(); } catch { return Notification.permission; }
}

export function notify(title, body) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return false;
  try {
    new Notification(title, { body, tag: 'mm-alert-' + Date.now() });
    return true;
  } catch { return false; }
}

// 提示音 —— 用 WebAudio 现场合成，不依赖任何音频文件
let audioCtx = null;
export function beep(times = 2) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    for (let i = 0; i < times; i++) {
      const t0 = audioCtx.currentTime + i * 0.28;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, t0);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.25, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
      osc.connect(gain); gain.connect(audioCtx.destination);
      osc.start(t0); osc.stop(t0 + 0.24);
    }
  } catch { /* 浏览器不允许自动播放时静默跳过 */ }
}
