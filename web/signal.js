// 评分引擎 + 目标利润可行性分析
import { sma, rsi, macd, atr, pricePercentile } from './indicators.js';

// ============ 一、综合评分 (-10 ~ +10) ============
// 四个维度独立打分后相加。正分偏多（适合买），负分偏空（适合卖）。
// 滚动价格分位：每根 K线各自回看 lookback 根，只用当时可见的数据
function percentileSeries(h, l, c, lookback) {
  const out = new Array(c.length).fill(null);
  for (let i = 1; i < c.length; i++) {
    const start = Math.max(0, i - lookback + 1);
    let hi = -Infinity, lo = Infinity;
    for (let j = start; j <= i; j++) { if (h[j] > hi) hi = h[j]; if (l[j] < lo) lo = l[j]; }
    out[i] = hi === lo ? 50 : ((c[i] - lo) / (hi - lo)) * 100;
  }
  return out;
}

// 一次性算好所有指标序列。SMA/RSI/MACD 天然只用 i 及之前的数据，不含未来函数。
function computeIndicators(bars) {
  const h = bars.map((b) => b.high);
  const l = bars.map((b) => b.low);
  const c = bars.map((b) => b.close);
  return {
    h, l, c,
    m20: sma(c, 20), m60: sma(c, 60), m120: sma(c, 120),
    r: rsi(c, 14), mac: macd(c),
    p20: percentileSeries(h, l, c, 20),
    p60: percentileSeries(h, l, c, 60),
    p120: percentileSeries(h, l, c, 120),
  };
}

// 在第 i 根 K线上评分。回测和实时面板共用同一套规则，避免两边逻辑漂移。
export function scoreAt(ind, i) {
  const { m20, m60, m120, r, mac } = ind;
  const last = i;
  const parts = [];

  // 1) 趋势：均线排列  -3 ~ +3
  let trend = 0, trendTxt = '数据不足';
  if (m20[last] !== null && m60[last] !== null && m120[last] !== null) {
    if (m20[last] > m60[last] && m60[last] > m120[last]) { trend = 3; trendTxt = '多头排列'; }
    else if (m20[last] < m60[last] && m60[last] < m120[last]) { trend = -3; trendTxt = '空头排列'; }
    else if (m20[last] > m60[last]) { trend = 1.5; trendTxt = '短期偏多'; }
    else { trend = -1.5; trendTxt = '短期偏空'; }
  } else if (m20[last] !== null && m60[last] !== null) {
    trend = m20[last] > m60[last] ? 1.5 : -1.5;
    trendTxt = m20[last] > m60[last] ? '短期偏多' : '短期偏空';
  }
  parts.push({ name: '趋势', score: trend, text: trendTxt, max: 3 });

  // 2) 位置：价格分位（低位得正分 —— 低位才有买入价值）  -3 ~ +3
  const pct = ind.p60[i];
  let pos = 0;
  if (pct !== null) {
    if (pct < 20) pos = 3;
    else if (pct < 35) pos = 1.5;
    else if (pct <= 65) pos = 0;
    else if (pct <= 80) pos = -1.5;
    else pos = -3;
  }
  parts.push({ name: '位置', score: pos, text: pct === null ? '—' : `近60根 ${pct.toFixed(0)}% 分位`, max: 3 });

  // 3) 动能：MACD 交叉方向 + 柱体是否放大  -2 ~ +2
  let mom = 0, momTxt = '—';
  if (mac.dif[last] !== null && mac.dea[last] !== null && mac.hist[last - 1] !== null) {
    const above = mac.dif[last] > mac.dea[last];
    const growing = Math.abs(mac.hist[last]) > Math.abs(mac.hist[last - 1]);
    mom = above ? (growing ? 2 : 1) : (growing ? -2 : -1);
    momTxt = (above ? '金叉' : '死叉') + (growing ? '·动能增强' : '·动能减弱');
  }
  parts.push({ name: '动能', score: mom, text: momTxt, max: 2 });

  // 4) 超买超卖：RSI  -2 ~ +2
  const rv = r[last];
  let ob = 0, obTxt = '—';
  if (rv !== null) {
    if (rv < 30) { ob = 2; obTxt = `RSI ${rv.toFixed(0)} 超卖`; }
    else if (rv < 40) { ob = 1; obTxt = `RSI ${rv.toFixed(0)} 偏冷`; }
    else if (rv <= 60) { ob = 0; obTxt = `RSI ${rv.toFixed(0)} 中性`; }
    else if (rv <= 70) { ob = -1; obTxt = `RSI ${rv.toFixed(0)} 偏热`; }
    else { ob = -2; obTxt = `RSI ${rv.toFixed(0)} 超买`; }
  }
  parts.push({ name: '超买超卖', score: ob, text: obTxt, max: 2 });

  let total = parts.reduce((s, p) => s + p.score, 0);

  // ---- 冲突检测 ----
  // 「价格在低位」+「空头排列」不是机会，是下跌中继。这种组合下位置得分必须失效，
  // 否则系统会在下跌趋势里持续发出买入信号 —— 这是散户亏损最主要的形态。
  const warnings = [];
  if (pos > 0 && trend <= -3) {
    total -= pos;
    warnings.push('低位 + 空头排列 = 下跌中继，低位不代表机会。位置分已作废。');
  }
  if (pos < 0 && trend >= 3) {
    total -= pos;
    warnings.push('高位 + 多头排列 = 上涨趋势中，高位不必然回调。位置分已作废。');
  }
  // 短周期与长周期背离
  const p20 = ind.p20[i];
  const p120 = ind.p120[i];
  if (p20 !== null && p120 !== null && p120 - p20 > 40) {
    warnings.push(`短周期低位(${p20.toFixed(0)}%)但长周期高位(${p120.toFixed(0)}%)：大涨后的回调途中，容易高位接刀。`);
  }

  total = Math.max(-10, Math.min(10, total));

  let action = 'hold', actionTxt = '观望 · 不操作';
  if (total >= 4) { action = 'buy'; actionTxt = '买入区'; }
  else if (total <= -4) { action = 'sell'; actionTxt = '卖出区'; }

  return { total, parts, warnings, action, actionTxt };
}

// 实时面板用：只算最后一根
export function score(bars) {
  return scoreAt(computeIndicators(bars), bars.length - 1);
}

// 回测用：算出每一根的评分
export function scoreSeries(bars) {
  const ind = computeIndicators(bars);
  return { ind, scores: bars.map((_, i) => scoreAt(ind, i)) };
}

// ============ 二、屏障模拟 ============
// 对历史上每一个入场点，逐根 K线检查：是先触及目标价，还是先触及止损价？
// 同一根 K线内两者都触及时，一律判为止损 —— 保守假设，避免高估胜率。
export function barrierSim(bars, holdBars, targetPct, stopPct) {
  let win = 0, loss = 0, none = 0;
  let noneRetSum = 0;             // 未触发时按到期市价平仓的真实涨跌幅之和
  const limit = bars.length - holdBars - 1;
  if (limit <= 20) return null;   // 样本太少，不给结论

  for (let i = 0; i <= limit; i++) {
    const entry = bars[i].close;
    let done = false;
    for (let j = i + 1; j <= i + holdBars; j++) {
      const up = (bars[j].high / entry - 1) * 100;
      const dn = (bars[j].low / entry - 1) * 100;
      if (dn <= -stopPct) { loss++; done = true; break; }
      if (up >= targetPct) { win++; done = true; break; }
    }
    if (!done) {
      none++;
      // 两条线都没碰到 = 持有到期按市价平仓。之前这里当成「只亏手续费」，
      // 等于凭空丢掉了这部分真实盈亏，未触发比例越高误差越大。
      noneRetSum += (bars[i + holdBars].close / entry - 1) * 100;
    }
  }
  const total = win + loss + none;
  // 窗口高度重叠 —— 相邻入场点共用绝大部分 K线，不是独立样本。
  // 真正的独立样本数约等于 总样本 / 持有根数。
  const effective = Math.floor(total / holdBars);
  return {
    total,
    effective,
    winRate: win / total,
    lossRate: loss / total,
    noneRate: none / total,
    noneAvgRet: none ? noneRetSum / none : 0,   // 未触发时的平均到期涨跌幅 (%)
  };
}

// ============ 三、目标利润可行性 ============
export function feasibility(bars, cfg) {
  const { capital, targetProfit, positionPct, holdBars, feeRate, fxRate } = cfg;
  const c = bars.map((b) => b.close);
  const h = bars.map((b) => b.high);
  const l = bars.map((b) => b.low);
  const price = c[c.length - 1];
  const atrPct = (atr(h, l, c, 14).at(-1) / price) * 100;

  // 仓位（人民币 → USDT）
  const posCNY = capital * (positionPct / 100);
  const posUSDT = posCNY / fxRate;

  // 需要的毛涨幅 —— 精确解，不用 x ≈ 利润/仓位 + 2f 这个一阶近似。
  // 买入：拿到手 qty = 仓位×(1-f)/P0    卖出：收回 qty×P1×(1-f)
  // 净利 = 仓位×(1-f)²×(1+x) - 仓位 = 目标
  //   =>  x = (1 + 目标/仓位) / (1-f)² - 1
  // 近似式在目标较大时会少算 x·f，例如目标 500 元会短 0.5 元。
  const needPct = ((1 + targetProfit / posCNY) / ((1 - feeRate) ** 2) - 1) * 100;
  const feeCost = posCNY * (1 - (1 - feeRate) ** 2);   // 来回手续费实际支出

  // 止损：1.5 倍 ATR，但不小于 1%
  const stopPct = Math.max(1, atrPct * 1.5);
  const stopLoss = posCNY * (stopPct / 100) + feeCost;

  // 历史屏障模拟
  const sim = barrierSim(bars, holdBars, needPct, stopPct);

  // 基准：同一批入场点，什么都不做，单纯持有 holdBars 根后平仓。
  // 不跟这个比，「期望值为正」可能只是因为样本区间在上涨，跟策略无关。
  let holdEV = null;
  {
    const limit = bars.length - holdBars - 1;
    if (limit > 20) {
      let sum = 0, n = 0;
      for (let i = 0; i <= limit; i++) { sum += (c[i + holdBars] / c[i] - 1) * 100; n++; }
      holdEV = posCNY * (sum / n / 100) - feeCost;
    }
  }

  // 只保留止损、去掉止盈的期望值。用来把「少赚的钱」拆开归因：
  // ev → noTPev 之间的差是止盈的代价，noTPev → holdEV 之间的差是止损的代价。
  // 不拆开就只能笼统说「别设止盈」，而实际上止损往往才是大头。
  let noTPev = null;
  {
    const lim = bars.length - holdBars - 1;
    if (lim > 20) {
      let sum = 0, n = 0;
      for (let i = 0; i <= lim; i++) {
        const e = c[i];
        let ret = null;
        for (let j = i + 1; j <= i + holdBars; j++) {
          if ((l[j] / e - 1) * 100 <= -stopPct) { ret = -stopPct; break; }
        }
        if (ret === null) ret = (c[i + holdBars] / e - 1) * 100;
        sum += posCNY * ret / 100 - feeCost; n++;
      }
      noTPev = sum / n;
    }
  }

  // 期望值 = 胜率×目标利润 - 败率×止损亏损 + 未触发率×(到期市价平仓的真实盈亏 - 手续费)
  let ev = null, rr = null, noneCash = null;
  if (sim) {
    noneCash = posCNY * (sim.noneAvgRet / 100) - feeCost;
    ev = sim.winRate * targetProfit - sim.lossRate * stopLoss + sim.noneRate * noneCash;
    rr = targetProfit / stopLoss;
  }

  // 手续费占目标利润的比例 —— 超过 30% 说明目标定得太小或仓位太小
  const feeRatio = feeCost / targetProfit;

  // 结论分级
  let verdict, verdictClass, reasons = [];
  if (!sim) {
    verdict = '样本不足';
    verdictClass = 'warn';
    reasons.push('当前周期下历史数据不够长，无法给出可信统计。换更短的周期或更短的持有时长。');
  } else {
    if (feeRatio > 0.5) reasons.push(`手续费吃掉目标利润的 ${(feeRatio * 100).toFixed(0)}%，仓位太小或目标太低。`);
    else if (feeRatio > 0.3) reasons.push(`手续费占目标利润 ${(feeRatio * 100).toFixed(0)}%，偏高。`);

    if (needPct > atrPct * Math.sqrt(holdBars) * 1.5) {
      reasons.push(`需要 ${needPct.toFixed(2)}% 的涨幅，但该周期典型波动只有 ${(atrPct * Math.sqrt(holdBars)).toFixed(2)}%，目标偏离现实。`);
    }
    if (rr < 1) reasons.push(`盈亏比 ${rr.toFixed(2)}，赚的比亏的少 —— 需要 ${(100 / (1 + rr)).toFixed(0)}% 以上胜率才不亏。`);

    if (ev > targetProfit * 0.15) { verdict = '可行'; verdictClass = 'up'; }
    else if (ev > 0) { verdict = '勉强可行'; verdictClass = 'warn'; }
    else { verdict = '不可行'; verdictClass = 'down'; }

    if (ev <= 0) reasons.push(`历史期望值为负（${ev.toFixed(1)} 元/次），长期执行必亏。`);

    // ---- 目标够不够得着，优先于期望值 ----
    // 期望值可以靠「没触发止盈、拿到期」那部分吃到行情上涨而转正，但那笔钱跟
    // 「能否赚到目标金额」无关。历史上几乎没涨到过目标价，就是够不着，不能叫可行。
    if (sim.winRate < 0.05) {
      const src = noneCash > 0
        ? `期望值里的钱来自「没到目标、拿到期」那部分（占 ${(sim.noneRate * 100).toFixed(0)}%），是行情自己涨的，不是止盈赚的。`
        : '';
      reasons.push(`历史上只有 ${(sim.winRate * 100).toFixed(1)}% 的情况涨到过目标价 —— 这个目标基本够不着。${src}`);
      verdict = '目标够不着';
      verdictClass = 'down';
    }

    // ---- 跑不赢「买入后什么都不做」，这套操作就没有意义 ----
    // 只在策略本身赚钱时才降级为「不如不动」。若 ev 已经是负的，「本身就亏」比
    // 「不如持有」更严重，必须保留 ‘不可行’，否则真正的问题会被盖掉。
    if (holdEV !== null && ev > 0 && ev <= holdEV) {
      reasons.push(`同期「买入后不操作」的期望值是 ${holdEV.toFixed(1)} 元，比这套止盈止损操作还高 ${(holdEV - ev).toFixed(1)} 元。频繁操作在做负功。`);
      verdict = '不如不动';
      verdictClass = 'down';
    } else if (holdEV !== null && ev <= 0 && ev <= holdEV) {
      reasons.push(`同期「买入后不操作」期望值 ${holdEV.toFixed(1)} 元，也高于这套操作。`);
    }

    // ---- 统计可信度的两个致命陷阱 ----
    // 1) 窗口重叠：持有时间越长，独立样本越少，胜率越不可信
    if (sim.effective < 30) {
      reasons.push(`独立样本仅约 ${sim.effective} 个（窗口高度重叠），胜率 ${(sim.winRate * 100).toFixed(0)}% 不可信。缩短持有时长或换更短周期。`);
      // 「勉强可行」以前能绕过这道降级，导致 22 个样本也敢报正面结论
      if (verdict === '可行' || verdict === '勉强可行') { verdict = '存疑'; verdictClass = 'warn'; }
    }
    // 2) 样本区间本身是单边行情：模拟只做多，牛市样本必然虚高
    const drift = (c.at(-1) / c[0] - 1) * 100;
    if (Math.abs(drift) > 15) {
      reasons.push(`回看区间整体${drift > 0 ? '上涨' : '下跌'} ${Math.abs(drift).toFixed(0)}%，模拟只做多方向，${drift > 0 ? '胜率被牛市抬高，换到震荡或下跌行情会显著变差' : '胜率被熊市压低'}。`);
      if (drift > 15 && verdictClass === 'up') { verdict = '存疑'; verdictClass = 'warn'; }
    }
  }

  return {
    price, posCNY, posUSDT, needPct, stopPct, atrPct, targetProfitNet: targetProfit,
    feeCost, feeRatio, stopLoss, sim, ev, rr,
    verdict, verdictClass, reasons, noneCash, holdEV, noTPev,
    targetPrice: price * (1 + needPct / 100),
    stopPrice: price * (1 - stopPct / 100),
    // 达成目标所需的典型波动参照
    typicalMove: atrPct * Math.sqrt(holdBars),
  };
}

// ============ 四、最终结论 ============
// 评分面板和可行性面板可能互相矛盾。这里合并成一句话，避免用户不知道该听谁的。
// 优先级：可行性 > 评分。评分说的是「方向」，可行性说的是「按你的计划操作后还剩多少钱」。
export function finalAdvice(s, f) {
  const ex = (f.ev !== null && f.holdEV !== null) ? f.ev - f.holdEV : null;

  if (!f.sim) {
    return { level: 'hold', title: '无法判断',
      why: '当前周期下历史样本不足，换更短周期或更短持有时长再看。' };
  }
  if (s.action === 'sell') {
    return { level: 'sell', title: '不要买入',
      why: `评分 ${s.total.toFixed(1)} 处于卖出区，方向偏空。已有持仓可考虑减仓，空仓不要进场。` };
  }
  if (f.ev <= 0) {
    return { level: 'sell', title: '不要按这个计划下单',
      why: `按你设的目标和止损，历史期望值是 ${f.ev.toFixed(1)} 元/次，长期执行必亏。`
        + (s.action === 'buy' ? '方向虽然偏多，但计划本身是亏的。' : '') };
  }
  if (ex !== null && ex <= 0) {
    // 把少赚的钱拆成止盈和止损两笔，别把锅全推给止盈 —— 实测止损常常是更大的一头
    const tpCost = f.noTPev !== null ? f.noTPev - f.ev : null;      // 止盈砍掉的
    const slCost = f.noTPev !== null ? f.holdEV - f.noTPev : null;  // 止损砍掉的
    let detail = `少赚约 ${Math.abs(ex).toFixed(0)} 元。`;
    let title = '方向可以，但止盈止损设得太紧';
    if (tpCost !== null && slCost !== null) {
      detail = `其中止盈砍掉 ${tpCost.toFixed(0)} 元，止损砍掉 ${slCost.toFixed(0)} 元。`;
      if (slCost > tpCost * 1.3) title = '方向可以，但止损设得太紧';
      else if (tpCost > slCost * 1.3) title = '方向可以，但止盈设得太低';
    }
    return { level: 'warn', title,
      why: `策略期望 ${f.ev.toFixed(1)} 元，同期买入不动是 ${f.holdEV.toFixed(1)} 元。` + detail
        + '把目标放宽、止损放远，或者干脆不设直接持有。' };
  }
  if (s.action === 'buy') {
    return { level: 'buy', title: '可以考虑买入',
      why: `评分 ${s.total.toFixed(1)} 在买入区，且这套计划的期望值(${f.ev.toFixed(1)}元)高于买入不动(${f.holdEV.toFixed(1)}元)。`
        + `止损务必设在 ${f.stopPrice.toFixed(0)}。` };
  }
  return { level: 'hold', title: '观望',
    why: `评分 ${s.total.toFixed(1)} 未达买入区(+4)。计划本身可行，但现在不是入场时机。` };
}

// ============ 五、买入价位参考 ============
// 给的是客观结构位（均线/布林/支撑聚类），不是「会涨」的判断。
// 每个价位附带两个可验证的数字：
//   成交概率 —— 历史上 holdBars 根内回落到这个幅度的比例（挂单等不等得到）
//   卖出目标 —— 若在此价成交，赚到目标利润需要涨到多少
export function entryLevels(bars, cfg) {
  const { holdBars, targetProfit, posCNY, feeRate, supports = [] } = cfg;
  const c = bars.map((b) => b.close);
  const l = bars.map((b) => b.low);
  const price = c.at(-1);

  const m20 = sma(c, 20).at(-1);
  const sd = stddevLast(c, 20);
  const bbLower = m20 !== null && sd !== null ? m20 - 2 * sd : null;

  // 净利 = 仓位×(1-f)²×(1+x) - 仓位 = 目标  =>  x = (1+目标/仓位)/(1-f)² - 1
  const needPct = ((1 + targetProfit / posCNY) / ((1 - feeRate) ** 2) - 1) * 100;

  // 历史上从任意一点出发，holdBars 根内最低价回落到 -dropPct 的比例
  const fillRate = (dropPct) => {
    if (dropPct <= 0) return 1;
    const limit = bars.length - holdBars - 1;
    if (limit <= 20) return null;
    let hit = 0;
    for (let i = 0; i <= limit; i++) {
      const entry = c[i];
      for (let j = i + 1; j <= i + holdBars; j++) {
        if ((l[j] / entry - 1) * 100 <= -dropPct) { hit++; break; }
      }
    }
    return hit / (limit + 1);
  };

  const nearestSupport = supports.length
    ? supports.filter((s) => s.price < price).sort((a, b) => b.price - a.price)[0] : null;

  const raw = [
    { label: '现价买入', basis: '立即成交，不等回调', price },
    { label: '回踩 MA20', basis: '回到 20 周期均线', price: m20 },
    { label: '布林下轨', basis: '跌到 2 倍标准差下沿', price: bbLower },
    nearestSupport
      ? { label: '最近支撑', basis: `摆动点聚类，被触碰 ${nearestSupport.touches} 次`, price: nearestSupport.price }
      : null,
  ].filter((x) => x && x.price !== null && Number.isFinite(x.price) && x.price > 0);

  // 只保留不高于现价的价位 —— 挂在现价上方的买单没有意义
  return raw
    .filter((x) => x.price <= price * 1.0005)
    .map((x) => {
      const dropPct = (1 - x.price / price) * 100;
      return {
        ...x,
        dropPct,
        fillRate: fillRate(dropPct),
        targetPrice: x.price * (1 + needPct / 100),
        needPct,
      };
    })
    .sort((a, b) => b.price - a.price);
}

// 只要最后一根的标准差，避免为了一个值算整条序列
function stddevLast(src, period) {
  if (src.length < period) return null;
  const w = src.slice(-period);
  const m = w.reduce((s, v) => s + v, 0) / period;
  return Math.sqrt(w.reduce((s, v) => s + (v - m) ** 2, 0) / period);
}
