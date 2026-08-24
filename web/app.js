import { fetchKlines, fetch24h, subscribeKlines } from './binance.js';
import { sma, bollinger, rsi, macd, atr, pricePercentile, swingPoints, clusterLevels } from './indicators.js';
import { score, feasibility, finalAdvice, entryLevels } from './signal.js';
import { backtest } from './backtest.js';
import * as Alerts from './alerts.js';

// 各周期对应的秒数 —— 用于把「持有 N 小时」换算成「持有几根 K线」
const INTERVAL_SEC = { '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };

const $ = (id) => document.getElementById(id);
const LC = window.LightweightCharts;

let symbol = 'BTCUSDT';
let interval = '1h';
let bars = [];          // 全量 K线
let unsubscribe = null;
let lastSupports = [];  // render() 算出的支撑位，买入价位参考要复用
let lastPrice = 0;      // 最新成交价，提醒判定方向时用

// ---------- 图表初始化 ----------
const baseOpts = {
  layout: { background: { color: '#0e1116' }, textColor: '#8b949e', fontSize: 11 },
  grid: { vertLines: { color: '#1a1f27' }, horzLines: { color: '#1a1f27' } },
  rightPriceScale: { borderColor: '#262d38' },
  timeScale: { borderColor: '#262d38', timeVisible: true, secondsVisible: false },
  crosshair: { mode: LC.CrosshairMode.Normal },
};

const mainChart = LC.createChart($('main-chart'), baseOpts);
const rsiChart = LC.createChart($('rsi-chart'), {
  ...baseOpts,
  timeScale: { ...baseOpts.timeScale, visible: false },
});

const candleS = mainChart.addCandlestickSeries({
  upColor: '#26a69a', downColor: '#ef5350',
  borderUpColor: '#26a69a', borderDownColor: '#ef5350',
  wickUpColor: '#26a69a', wickDownColor: '#ef5350',
});
const ma20S = mainChart.addLineSeries({ color: '#58a6ff', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
const ma60S = mainChart.addLineSeries({ color: '#d29922', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
const bbUpS = mainChart.addLineSeries({ color: '#3f4b5b', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
const bbLoS = mainChart.addLineSeries({ color: '#3f4b5b', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });

// 成交量叠加在主图底部
const volS = mainChart.addHistogramSeries({
  priceFormat: { type: 'volume' }, priceScaleId: 'vol', priceLineVisible: false, lastValueVisible: false,
});
mainChart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
mainChart.priceScale('right').applyOptions({ scaleMargins: { top: 0.06, bottom: 0.22 } });

const rsiS = rsiChart.addLineSeries({ color: '#bc8cff', lineWidth: 1, priceLineVisible: false });
rsiS.createPriceLine({ price: 70, color: '#ef5350', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '' });
rsiS.createPriceLine({ price: 30, color: '#26a69a', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '' });

// 两张图的时间轴联动
let syncing = false;
const sync = (from, to) => from.timeScale().subscribeVisibleLogicalRangeChange((r) => {
  if (syncing || !r) return;
  syncing = true; to.timeScale().setVisibleLogicalRange(r); syncing = false;
});
sync(mainChart, rsiChart);
sync(rsiChart, mainChart);

new ResizeObserver(() => {
  mainChart.applyOptions({ width: $('main-chart').clientWidth, height: $('main-chart').clientHeight });
  rsiChart.applyOptions({ width: $('rsi-chart').clientWidth, height: $('rsi-chart').clientHeight });
}).observe(document.body);

// ---------- 工具 ----------
const line = (times, vals) => times
  .map((t, i) => ({ time: t, value: vals[i] }))
  .filter((p) => p.value !== null && p.value !== undefined && !Number.isNaN(p.value));

const fmt = (n, d = 2) => (n === null || n === undefined || Number.isNaN(n))
  ? '—' : n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

const fmtVol = (n) => n >= 1e9 ? (n / 1e9).toFixed(2) + 'B'
  : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : fmt(n, 0);

function showErr(msg) {
  const e = $('err');
  if (!msg) { e.style.display = 'none'; return; }
  e.textContent = msg; e.style.display = 'block';
}

// ---------- 渲染 ----------
function render() {
  if (bars.length < 30) return;

  const t = bars.map((b) => b.time);
  const h = bars.map((b) => b.high);
  const l = bars.map((b) => b.low);
  const c = bars.map((b) => b.close);

  candleS.setData(bars.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close })));
  volS.setData(bars.map((b) => ({
    time: b.time, value: b.volume,
    color: b.close >= b.open ? 'rgba(38,166,154,.4)' : 'rgba(239,83,80,.4)',
  })));

  const m20 = sma(c, 20), m60 = sma(c, 60), m120 = sma(c, 120);
  const bb = bollinger(c, 20, 2);
  const r = rsi(c, 14);
  const mac = macd(c);
  const a = atr(h, l, c, 14);

  ma20S.setData(line(t, m20));
  ma60S.setData(line(t, m60));
  bbUpS.setData(line(t, bb.upper));
  bbLoS.setData(line(t, bb.lower));
  rsiS.setData(line(t, r));

  const last = c.length - 1;
  const price = c[last];

  // 价格分位
  const pctCfg = [[20, 'p20', 'b20'], [60, 'p60', 'b60'], [120, 'p120', 'b120']];
  for (const [lb, pid, bid] of pctCfg) {
    const pct = pricePercentile(h, l, c, lb);
    $(pid).textContent = pct === null ? '—' : pct.toFixed(1) + '%';
    $(bid).style.width = (pct === null ? 0 : Math.max(0, Math.min(100, pct))) + '%';
  }

  // RSI
  const rv = r[last];
  $('rsiv').innerHTML = rv === null ? '—'
    : '<span class="' + (rv > 70 ? 'down' : rv < 30 ? 'up' : '') + '">'
      + rv.toFixed(1) + (rv > 70 ? ' 超买' : rv < 30 ? ' 超卖' : '') + '</span>';

  // MACD —— 找最近一次交叉
  let cross = '—';
  if (mac.dif[last] !== null && mac.dea[last] !== null) {
    const above = mac.dif[last] > mac.dea[last];
    let ago = 0;
    for (let i = last; i > 0; i--) {
      if (mac.dif[i - 1] === null || mac.dea[i - 1] === null) break;
      if ((mac.dif[i - 1] > mac.dea[i - 1]) !== above) break;
      ago++;
    }
    cross = '<span class="' + (above ? 'up' : 'down') + '">'
      + (above ? '金叉' : '死叉') + ' ' + ago + ' 根前</span>';
  }
  $('macdv').innerHTML = cross;

  // 均线排列
  let arrange = '数据不足';
  if (m20[last] !== null && m60[last] !== null && m120[last] !== null) {
    if (m20[last] > m60[last] && m60[last] > m120[last]) arrange = '<span class="up">多头排列</span>';
    else if (m20[last] < m60[last] && m60[last] < m120[last]) arrange = '<span class="down">空头排列</span>';
    else arrange = '纠缠 · 震荡';
  } else if (m20[last] !== null && m60[last] !== null) {
    arrange = m20[last] > m60[last] ? '<span class="up">短期偏多</span>' : '<span class="down">短期偏空</span>';
  }
  $('mav').innerHTML = arrange;

  // 布林带位置 %B
  if (bb.upper[last] !== null) {
    const pb = ((price - bb.lower[last]) / (bb.upper[last] - bb.lower[last])) * 100;
    $('bbv').textContent = pb.toFixed(0) + '%' + (pb > 100 ? ' 上轨外' : pb < 0 ? ' 下轨外' : '');
  }

  // ATR —— 换算成建议止损幅度
  if (a[last] !== null) {
    $('atrv').textContent = fmt(a[last]) + ' (' + (a[last] / price * 100).toFixed(2) + '%)';
  }

  // 支撑压力 —— 聚类容差随波动率自适应，否则同一个 0.6% 在 1h 图偏松、在 4h/1d 图偏紧
  const atrPct = a[last] !== null ? (a[last] / price) * 100 : 0.6;
  const tol = Math.min(3, Math.max(0.4, atrPct * 1.5));
  const sw = swingPoints(h, l, 5);
  // 按触碰次数过滤会在「价格处于区间高位」时把附近价位全部滤掉（附近的都是新的、只碰过 1 次），
  // 反而只剩下 15% 开外的老价位。所以按距离取，触碰次数只作为强度展示。
  const levels = clusterLevels(sw.highs.concat(sw.lows), tol)
    .filter((x) => Math.abs(x.price / price - 1) <= 0.2);
  const resist = levels.filter((x) => x.price > price).sort((x, y) => x.price - y.price).slice(0, 4);
  const support = levels.filter((x) => x.price < price).sort((x, y) => y.price - x.price).slice(0, 4);

  const draw = (el, list, cls) => {
    el.innerHTML = list.length
      ? list.map((x) => '<div class="lv"><span class="' + cls + '">' + fmt(x.price) + '</span>'
          + '<span class="t">' + ((x.price / price - 1) * 100).toFixed(2) + '% · '
          + x.touches + ' 次</span></div>').join('')
      : '<div class="t">当前区间内无明显价位</div>';
  };
  draw($('res'), resist, 'down');
  draw($('sup'), support, 'up');
  lastSupports = support;

  renderSignal();
}

// ---------- 评分 + 可行性 ----------
function renderSignal() {
  if (bars.length < 60) return;

  // --- 综合评分 ---
  const s = score(bars);
  $('act').textContent = s.actionTxt;
  $('act').className = 'verdict ' + s.action;
  $('scoreval').textContent = (s.total > 0 ? '+' : '') + s.total.toFixed(1);
  $('scoremark').style.left = ((s.total + 10) / 20 * 100) + '%';
  $('parts').innerHTML = s.parts.map((p) => {
    const cls = p.score > 0 ? 'up' : p.score < 0 ? 'down' : '';
    return '<div class="part"><span class="pn">' + p.name + ' · ' + p.text + '</span>'
      + '<span class="ps ' + cls + '">' + (p.score > 0 ? '+' : '') + p.score + '</span></div>';
  }).join('');
  $('warns').innerHTML = s.warnings.map((w) => '<div class="warn-item">⚠ ' + w + '</div>').join('');

  // --- 目标利润可行性 ---
  const num = (id, dflt) => {
    const v = parseFloat($(id).value);
    return Number.isFinite(v) && v > 0 ? v : dflt;
  };
  const holdHours = parseFloat($('i-hold').value);
  const holdBars = Math.max(1, Math.round(holdHours * 3600 / INTERVAL_SEC[interval]));

  const f = feasibility(bars, {
    capital: num('i-cap', 10000),
    targetProfit: num('i-tgt', 100),
    positionPct: Math.min(100, num('i-pos', 20)),
    holdBars,
    feeRate: num('i-fee', 0.1) / 100,
    fxRate: num('i-fx', 7.2),
  });

  $('fv').textContent = f.verdict + (f.sim ? '' : '');
  $('fv').className = 'verdict ' + f.verdictClass;
  $('f-need').textContent = f.needPct.toFixed(2) + '%';
  $('f-typ').textContent = f.typicalMove.toFixed(2) + '%  (' + holdBars + ' 根)';
  $('f-tp').textContent = fmt(f.targetPrice);
  $('f-sp').textContent = fmt(f.stopPrice) + '  (-' + f.stopPct.toFixed(2) + '%)';
  $('f-pos').textContent = fmt(f.posCNY, 0) + ' 元 / ' + fmt(f.posUSDT, 0) + ' U';
  $('f-fee').textContent = fmt(f.feeCost, 1) + ' 元 (占目标 ' + (f.feeRatio * 100).toFixed(0) + '%)';
  $('f-sl').textContent = fmt(f.stopLoss, 1) + ' 元';
  $('f-rr').innerHTML = f.rr === null ? '—'
    : '<span class="' + (f.rr >= 1 ? 'up' : 'down') + '">' + f.rr.toFixed(2) + '</span>';
  $('f-wr').innerHTML = f.sim
    ? (f.sim.winRate * 100).toFixed(1) + '%  <span style="color:var(--dim);font-size:11px">(独立样本 '
      + f.sim.effective + ')</span>'
    : '样本不足';
  $('f-ev').innerHTML = f.ev === null ? '—'
    : '<span class="' + (f.ev > 0 ? 'up' : 'down') + '">'
      + (f.ev > 0 ? '+' : '') + f.ev.toFixed(1) + ' 元</span>';
  $('f-hold').textContent = f.holdEV === null ? '—' : (f.holdEV > 0 ? '+' : '') + f.holdEV.toFixed(1) + ' 元';
  if (f.ev !== null && f.holdEV !== null) {
    const ex = f.ev - f.holdEV;
    $('f-ex').innerHTML = '<span class="' + (ex > 0 ? 'up' : 'down') + '">'
      + (ex > 0 ? '+' : '') + ex.toFixed(1) + ' 元</span>';
  } else {
    $('f-ex').textContent = '—';
  }
  // --- 建议买入价：客观结构位 + 挂单成交概率 ---
  const levels = entryLevels(bars, {
    holdBars,
    targetProfit: num('i-tgt', 100),
    posCNY: f.posCNY,
    feeRate: num('i-fee', 0.1) / 100,
    supports: lastSupports,
  });
  const pd = f.price >= 1000 ? 2 : 4;
  $('ent-list').innerHTML = levels.map((x) => {
    const isNow = x.dropPct < 0.05;
    const fr = x.fillRate === null ? '—'
      : isNow ? '立即成交' : (x.fillRate * 100).toFixed(0) + '% 能等到';
    return '<div class="ent' + (isNow ? ' now' : '') + '">'
      + '<div class="ent-l"><div class="ent-n">' + x.label + '</div>'
      + '<div class="ent-b">' + x.basis + '</div></div>'
      + '<div class="ent-r"><div class="ent-p">' + fmt(x.price, pd) + '</div>'
      + '<div class="ent-d">' + (isNow ? '现价' : '-' + x.dropPct.toFixed(2) + '%')
      + ' · ' + fr + '</div>'
      + '<div class="ent-d">卖出 ' + fmt(x.targetPrice, pd) + '</div></div></div>';
  }).join('') || '<div class="t">无可用价位</div>';

  // --- 交易计划：纯算术，不含预测。这部分的数字是可以保证准确的 ---
  const qty = f.posUSDT / f.price;
  const digits = f.price >= 1000 ? 2 : 4;
  $('pl-buy').textContent = fmt(f.price, digits);
  $('pl-sell').textContent = fmt(f.targetPrice, digits);
  $('pl-need').textContent = '+' + f.needPct.toFixed(2) + '%  (' + fmt(f.targetPrice - f.price, digits) + ')';
  $('pl-stop').textContent = fmt(f.stopPrice, digits);
  $('pl-stoppct').textContent = '-' + f.stopPct.toFixed(2) + '%  (' + fmt(f.price - f.stopPrice, digits) + ')';
  $('pl-qty').textContent = qty.toFixed(qty < 1 ? 6 : 3) + ' ' + symbol.replace('USDT', '');
  $('pl-cost').textContent = fmt(f.posCNY, 0) + ' 元 / ' + fmt(f.posUSDT, 2) + ' USDT';
  $('pl-fee').textContent = fmt(f.feeCost, 2) + ' 元';
  $('pl-win').textContent = '+' + fmt(f.targetProfitNet ?? 0, 0) + ' 元';
  $('pl-loss').textContent = '-' + fmt(f.stopLoss, 0) + ' 元';
  // 单笔风险占本金比例 —— 通用风控标准是不超过 2%
  const capNow = num('i-cap', 10000);
  const riskPct = f.stopLoss / capNow * 100;
  const riskCls = riskPct <= 1 ? 'up' : riskPct <= 2 ? '' : 'down';
  const riskTag = riskPct <= 1 ? ' 保守' : riskPct <= 2 ? ' 适中' : ' 偏高';
  $('pl-risk').innerHTML = '<span class="' + riskCls + '">'
    + riskPct.toFixed(2) + '% 本金' + riskTag + '</span>';
  // 历史参照：这个涨幅在过去出现得频不频繁 —— 是事实统计，不是预测
  $('pl-ref').textContent = f.sim
    ? `参照：过去 ${bars.length} 根 K线里，从任意一点起 ${holdBars} 根内涨到 +${f.needPct.toFixed(2)}% 的比例是 `
      + `${(f.sim.winRate * 100).toFixed(1)}%（先跌到止损的占 ${(f.sim.lossRate * 100).toFixed(1)}%）。`
      + '这是历史频率，不是对这一次的预测。'
    : '历史样本不足，无法给出频率参照。';

  // 汇总可一键设提醒的价位
  quickTargets = [
    { label: '卖出目标', price: f.targetPrice },
    { label: '止损', price: f.stopPrice },
    ...levels.filter((x) => x.dropPct >= 0.05).map((x) => ({ label: x.label, price: x.price })),
  ].filter((q) => Number.isFinite(q.price) && q.price > 0);
  renderAlerts();

  // --- 最终结论：合并评分与可行性，避免两块面板互相矛盾 ---
  const adv = finalAdvice(s, f);
  $('fin-title').textContent = adv.title;
  $('fin-title').className = 'final ' + adv.level;
  $('fin-why').textContent = adv.why;

  renderBacktest();

  $('f-why').innerHTML = f.reasons.map((r) => '<div class="warn-item">· ' + r + '</div>').join('');
}

// ---------- 价格提醒 ----------
let quickTargets = [];   // 由计划/买入价位提供的一键添加价位

// 提醒价在主图上画成横线，价格轴带标签 —— 看图时一直可见
let alertLines = [];
let alertSig = '';
function syncAlertLines() {
  // 价格每跳一次 renderAlerts 就会走一遍，提醒没变化时直接跳过重建，避免横线闪烁
  const sig = Alerts.list(symbol).map((a) => a.id + ':' + a.price + ':' + a.fired).join('|') + '@' + symbol;
  if (sig === alertSig) return;
  alertSig = sig;
  for (const ln of alertLines) {
    try { candleS.removePriceLine(ln); } catch { /* 图表已重建则忽略 */ }
  }
  alertLines = Alerts.list(symbol).map((a) => candleS.createPriceLine({
    price: a.price,
    color: a.fired ? '#5c6672' : (a.dir === 'up' ? '#26a69a' : '#ef5350'),
    lineWidth: 1,
    lineStyle: a.fired ? 3 : 2,          // 已触发用点线，待触发用虚线
    axisLabelVisible: true,
    title: (a.fired ? '✓ ' : '🔔 ') + (a.note || (a.dir === 'up' ? '涨到' : '跌到')),
  }));
}

// 顶栏常驻：距离最近的一个未触发提醒还差多少
function renderAlertBadge() {
  const pending = Alerts.list(symbol).filter((a) => !a.fired);
  if (!pending.length || !lastPrice) { $('al-badge').innerHTML = ''; return; }
  const near = pending.reduce((best, a) => {
    const d = Math.abs(a.price / lastPrice - 1);
    return best === null || d < best.d ? { a, d } : best;
  }, null);
  const gap = (near.a.price / lastPrice - 1) * 100;
  $('al-badge').innerHTML = '🔔 ' + fmt(near.a.price, 2)
    + ' <span class="' + (gap >= 0 ? 'up' : 'down') + '">'
    + (gap >= 0 ? '+' : '') + gap.toFixed(2) + '%</span>'
    + (pending.length > 1 ? ' <span style="color:var(--dim)">+' + (pending.length - 1) + '</span>' : '');
}

function renderAlerts() {
  const items = Alerts.list(symbol);
  const pd = 2;
  syncAlertLines();
  renderAlertBadge();
  $('al-list').innerHTML = items.length
    ? items.sort((a, b) => b.price - a.price).map((a) => {
        const t = Alerts.triggerPrice(a);
        const arrow = a.dir === 'up' ? '↑ 涨到' : '↓ 跌到';
        const status = a.fired
          ? '<span style="color:var(--warn)">已触发 · 点右侧重置</span>'
          : `${arrow} ${fmt(t, pd)} 时提醒` + (a.tolPct > 0 ? `（提前 ${a.tolPct}%）` : '');
        // 图标与图上的横线保持一致：待触发 🔔，已触发 ✓
        const icon = a.fired ? '✓' : '🔔';
        return '<div class="al-item' + (a.fired ? ' fired' : '') + '">'
          + '<div><div class="al-p"><span class="al-i">' + icon + '</span>' + fmt(a.price, pd) + '</div>'
          + '<div class="al-m">' + status + (a.note ? ' · ' + a.note : '') + '</div></div>'
          + '<div style="flex-shrink:0">'
          + (a.fired ? '<button class="al-x" data-reset="' + a.id + '" title="重置">↺</button>' : '')
          + '<button class="al-x" data-del="' + a.id + '" title="删除">×</button>'
          + '</div></div>';
      }).join('')
    : '<div class="al-m">还没有设置提醒</div>';

  $('al-quick').innerHTML = quickTargets
    .map((q, i) => '<button data-quick="' + i + '">+ ' + q.label + ' ' + fmt(q.price, pd) + '</button>')
    .join('');

  const perm = Alerts.permissionState();
  const permTxt = {
    granted: '桌面通知已开启。',
    denied: '桌面通知被浏览器拒绝了，只能靠页内弹窗和提示音 —— 可在地址栏左侧的锁形图标里改回来。',
    default: '还没开启桌面通知，建议点上面的按钮授权。',
    unsupported: '这个浏览器不支持桌面通知，只有页内弹窗和提示音。',
  }[perm];
  $('al-note').innerHTML = permTxt
    + '<br><b>提醒只在本页面开着时有效</b>（关掉标签页就不再检查价格）。'
    + '价格由 WebSocket 实时推送，触发一次后自动停止，需要再用点 ↺ 重置。';
  $('al-perm').style.display = perm === 'granted' || perm === 'unsupported' ? 'none' : '';
}

function popAlert(fired) {
  const lines = fired.map((a) => {
    const dir = a.dir === 'up' ? '涨到' : '跌到';
    return `${symbol} 已${dir} <b>${fmt(a.hitPrice, 2)}</b>`
      + `<br><span style="color:var(--dim);font-size:12.5px">你设的提醒价 ${fmt(a.price, 2)}`
      + (a.tolPct > 0 ? `，接近阈值 ${a.tolPct}%` : '') + '</span>';
  });
  $('modal-title').textContent = fired.length > 1 ? `${fired.length} 个价格提醒` : '价格提醒';
  $('modal-body').innerHTML = lines.join('<hr style="border:0;border-top:1px solid #262d38;margin:11px 0">');
  $('modal').classList.add('on');
  Alerts.beep(2);
  Alerts.notify(
    symbol + ' 价格提醒',
    fired.map((a) => `${a.dir === 'up' ? '涨到' : '跌到'} ${fmt(a.hitPrice, 2)}（设定 ${fmt(a.price, 2)}）`).join('\n'),
  );
  // 标签页在后台时，用标题闪烁兜底
  flashTitle();
}

let flashTimer = null;
const BASE_TITLE = document.title;
function flashTitle() {
  clearInterval(flashTimer);
  let on = false, n = 0;
  flashTimer = setInterval(() => {
    document.title = (on = !on) ? '🔔 价格提醒！' : BASE_TITLE;
    if (++n > 40) { clearInterval(flashTimer); document.title = BASE_TITLE; }
  }, 700);
}

$('al-add').addEventListener('click', () => {
  const r = Alerts.add(symbol, $('al-px').value, lastPrice, $('al-tol').value, '');
  if (!r.ok) { $('al-note').innerHTML = '<span style="color:var(--down)">' + r.msg + '</span>'; return; }
  $('al-px').value = '';
  renderAlerts();
});
$('al-perm').addEventListener('click', async () => { await Alerts.requestPermission(); Alerts.beep(1); renderAlerts(); });
$('al-list').addEventListener('click', (e) => {
  const del = e.target.dataset.del, rst = e.target.dataset.reset;
  if (del) Alerts.remove(+del);
  else if (rst) Alerts.reset(+rst);
  else return;
  renderAlerts();
});
$('al-quick').addEventListener('click', (e) => {
  const i = e.target.dataset.quick;
  if (i === undefined) return;
  const q = quickTargets[+i];
  Alerts.add(symbol, q.price, lastPrice, $('al-tol').value, q.label);
  renderAlerts();
});
$('modal-ok').addEventListener('click', () => {
  $('modal').classList.remove('on');
  clearInterval(flashTimer);
  document.title = BASE_TITLE;
  renderAlerts();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('modal').classList.contains('on')) $('modal-ok').click();
});

// ---------- 回测 ----------
function renderBacktest() {
  const iv = (id, dflt) => {
    const v = parseFloat($(id).value);
    return Number.isFinite(v) ? v : dflt;
  };
  const r = backtest(bars, {
    entryScore: iv('b-in', 4),
    exitScore: iv('b-out', 0),
    stopATR: iv('b-stop', 2),
    exitOnMA: $('b-ma').value === '1',
    feeRate: (parseFloat($('i-fee').value) || 0.1) / 100,
    capital: parseFloat($('i-cap').value) || 10000,
  });

  if (!r) {
    ['b-ret', 'b-bh', 'b-ex', 'b-tc', 'b-wr', 'b-pf', 'b-dd', 'b-bhdd']
      .forEach((id) => { $(id).textContent = '—'; });
    $('b-warn').innerHTML = '<div class="warn-item">K线不足，无法回测。</div>';
    return;
  }

  const pct = (v) => '<span class="' + (v >= 0 ? 'up' : 'down') + '">'
    + (v >= 0 ? '+' : '') + v.toFixed(1) + '%</span>';
  $('b-ret').innerHTML = pct(r.totalReturn);
  $('b-bh').innerHTML = pct(r.bhReturn);
  $('b-ex').innerHTML = pct(r.excess);
  $('b-tc').textContent = r.tradeCount + ' 笔';
  $('b-wr').textContent = (r.winRate * 100).toFixed(0) + '%';
  $('b-pf').innerHTML = r.profitFactor === null ? '—'
    : '<span class="' + (r.profitFactor > 1 ? 'up' : 'down') + '">'
      + r.profitFactor.toFixed(2) + '</span>';
  $('b-dd').textContent = r.maxDrawdown.toFixed(1) + '%';
  $('b-bhdd').textContent = r.bhMaxDrawdown.toFixed(1) + '%';

  const w = [];
  if (r.tradeCount < 20) w.push(`只有 ${r.tradeCount} 笔交易，样本太少，这个结果不可信。`);
  if (r.profitFactor !== null && r.profitFactor <= 1) w.push(`盈利因子 ${r.profitFactor.toFixed(2)} ≤ 1，这套规则在这段历史上是亏钱的。`);
  if (r.excess < 0) w.push(`跑输买入持有 ${Math.abs(r.excess).toFixed(1)}%。`);
  w.push('这是在一段历史上的结果，换一段就会不同。回测赚钱不代表未来赚钱，回测亏钱基本可以确定未来也亏。');
  $('b-warn').innerHTML = w.map((x) => '<div class="warn-item">· ' + x + '</div>').join('');
}

['b-in', 'b-out', 'b-stop', 'b-ma'].forEach((id) => {
  $(id).addEventListener('input', renderBacktest);
  $(id).addEventListener('change', renderBacktest);
});

// ---------- 加载与订阅 ----------
async function load() {
  showErr('');
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  $('dot').className = 'dot';
  $('status').textContent = '加载中…';

  try {
    bars = await fetchKlines(symbol, interval, 1000);
    render();
    mainChart.timeScale().fitContent();

    const t24 = await fetch24h(symbol);
    $('h24').textContent = fmt(t24.high);
    $('l24').textContent = fmt(t24.low);
    $('v24').textContent = '$' + fmtVol(t24.volume);
    updatePrice(t24.last, t24.changePct);
  } catch (e) {
    showErr('行情加载失败：' + e.message + '（检查网络能否直连 api.binance.com）');
    $('dot').className = 'dot error';
    $('status').textContent = '失败';
    return;
  }

  unsubscribe = subscribeKlines(symbol, interval,
    (bar) => {
      const lastBar = bars[bars.length - 1];
      if (lastBar && bar.time === lastBar.time) {
        bars[bars.length - 1] = bar;
      } else if (!lastBar || bar.time > lastBar.time) {
        bars.push(bar);
        if (bars.length > 1500) bars.shift();
      }
      render();
      updatePrice(bar.close, null);
    },
    (s) => {
      $('dot').className = 'dot ' + s;
      const label = { connected: '实时', reconnecting: '重连中…', error: '连接异常' };
      $('status').textContent = label[s] || s;
    });
}

let refPrice = null;
function updatePrice(price, chgPct) {
  lastPrice = price;
  const fired = Alerts.check(symbol, price);
  if (fired.length) popAlert(fired);
  renderAlertBadge();
  const digits = price >= 1000 ? 2 : price >= 1 ? 4 : 6;
  $('last').textContent = fmt(price, digits);
  if (chgPct !== null) refPrice = price / (1 + chgPct / 100);
  if (refPrice) {
    const p = (price / refPrice - 1) * 100;
    $('chg').textContent = (p >= 0 ? '+' : '') + p.toFixed(2) + '%';
    $('chg').className = 'chg ' + (p >= 0 ? 'up' : 'down');
  }
}

// ---------- 交互 ----------
$('symbol').addEventListener('change', (e) => {
  symbol = e.target.value; refPrice = null; renderAlerts(); load();
});
$('tfs').addEventListener('click', (e) => {
  const b = e.target.closest('.tf');
  if (!b) return;
  document.querySelectorAll('.tf').forEach((x) => x.classList.remove('on'));
  b.classList.add('on');
  interval = b.dataset.i;
  load();
});

// 交易设置改动后立即重算（纯本地计算，不用重新拉数据）
['i-cap', 'i-tgt', 'i-pos', 'i-hold', 'i-fee', 'i-fx'].forEach((id) => {
  $(id).addEventListener('input', renderSignal);
  $(id).addEventListener('change', renderSignal);
});

// 每 30 秒刷新 24h 摘要（WS 只推 K线，不推 24h 统计）
setInterval(async () => {
  try {
    const t = await fetch24h(symbol);
    $('h24').textContent = fmt(t.high);
    $('l24').textContent = fmt(t.low);
    $('v24').textContent = '$' + fmtVol(t.volume);
    refPrice = t.last / (1 + t.changePct / 100);
  } catch (e) { /* 静默：WS 仍在推价格 */ }
}, 30000);

load();
