// 回测引擎 —— 验证「评分入场 + 趋势出场」到底赚不赚钱
//
// 与之前屏障模拟的根本区别：
//   屏障模拟：任意时刻入场，赚到固定金额就跑  →  利润被封顶
//   本引擎：  只在评分达标时入场，趋势走坏才跑  →  利润不封顶
//
// 防未来函数的两条铁律：
//   1. 第 i 根收盘后才产生信号，第 i+1 根开盘价成交（不能用当根收盘价成交）
//   2. 止损用当根最低价判定，且优先于其它出场条件（同根内先判止损，保守）
import { scoreSeries } from './signal.js';
import { atr } from './indicators.js';

export function backtest(bars, cfg = {}) {
  const {
    entryScore = 4,        // 评分 ≥ 此值才入场
    exitOnMA = true,       // 收盘跌破 MA20 出场
    exitScore = 0,         // 评分 ≤ 此值出场（null 表示不用这条）
    stopATR = 2,           // 止损 = 入场价 - stopATR × ATR
    feeRate = 0.001,
    capital = 10000,
    positionPct = 100,     // 每笔用多少比例的钱
  } = cfg;

  const { ind, scores } = scoreSeries(bars);
  const a = atr(ind.h, ind.l, ind.c, 14);
  const trades = [];

  let cash = capital;
  let pos = null;                       // { entryPx, entryIdx, qty, stopPx }
  const equity = new Array(bars.length).fill(null);

  // 从第 120 根开始 —— MA120 之前指标不完整，评分不可信
  const START = 121;
  if (bars.length <= START + 10) return null;

  for (let i = START; i < bars.length; i++) {
    const bar = bars[i];

    // ---- 1. 持仓中：先判止损（用当根最低价，保守） ----
    if (pos && bar.low <= pos.stopPx) {
      cash = pos.qty * pos.stopPx * (1 - feeRate);
      trades.push({
        entryIdx: pos.entryIdx, exitIdx: i, entryPx: pos.entryPx, exitPx: pos.stopPx,
        pnl: cash - pos.cost, reason: '止损', bars: i - pos.entryIdx,
      });
      pos = null;
    }

    // ---- 2. 持仓中：趋势走坏则在下一根开盘出场 ----
    if (pos && i + 1 < bars.length) {
      const maBreak = exitOnMA && ind.m20[i] !== null && bar.close < ind.m20[i];
      const scoreBad = exitScore !== null && scores[i].total <= exitScore;
      if (maBreak || scoreBad) {
        const px = bars[i + 1].open;
        cash = pos.qty * px * (1 - feeRate);
        trades.push({
          entryIdx: pos.entryIdx, exitIdx: i + 1, entryPx: pos.entryPx, exitPx: px,
          pnl: cash - pos.cost, reason: maBreak ? '跌破MA20' : '评分转弱', bars: i + 1 - pos.entryIdx,
        });
        pos = null;
      }
    }

    // ---- 3. 空仓中：评分达标则在下一根开盘入场 ----
    if (!pos && i + 1 < bars.length && scores[i].total >= entryScore && a[i] !== null) {
      const px = bars[i + 1].open;
      const spend = cash * (positionPct / 100);
      const qty = spend * (1 - feeRate) / px;
      pos = {
        entryPx: px, entryIdx: i + 1, qty, cost: spend,
        stopPx: px - stopATR * a[i],
      };
      cash -= spend;
    }

    equity[i] = cash + (pos ? pos.qty * bar.close : 0);
  }

  // 收盘强制平仓，否则最后一笔浮盈浮亏不计入
  if (pos) {
    const px = bars[bars.length - 1].close;
    cash += pos.qty * px * (1 - feeRate);
    trades.push({
      entryIdx: pos.entryIdx, exitIdx: bars.length - 1, entryPx: pos.entryPx, exitPx: px,
      pnl: pos.qty * px * (1 - feeRate) - pos.cost, reason: '期末平仓', bars: bars.length - 1 - pos.entryIdx,
    });
    equity[bars.length - 1] = cash;
    pos = null;
  }

  // ---- 统计 ----
  const finalEq = equity.filter((x) => x !== null).at(-1) ?? capital;
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);

  let peak = -Infinity, maxDD = 0;
  for (const e of equity) {
    if (e === null) continue;
    if (e > peak) peak = e;
    const dd = (peak - e) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  // 基准：同一段区间买入持有（同样扣来回手续费）
  const bhEntry = bars[START + 1].open;
  const bhExit = bars[bars.length - 1].close;
  const bhFinal = capital * (1 - feeRate) * (bhExit / bhEntry) * (1 - feeRate);
  let bhPeak = -Infinity, bhMaxDD = 0;
  for (let i = START + 1; i < bars.length; i++) {
    const v = capital * (bars[i].close / bhEntry);
    if (v > bhPeak) bhPeak = v;
    const dd = (bhPeak - v) / bhPeak;
    if (dd > bhMaxDD) bhMaxDD = dd;
  }

  return {
    capital,
    finalEquity: finalEq,
    totalReturn: (finalEq / capital - 1) * 100,
    tradeCount: trades.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    avgWin: wins.length ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0,
    avgLoss: losses.length ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0,
    profitFactor: losses.length && losses.reduce((s, t) => s + t.pnl, 0) !== 0
      ? Math.abs(wins.reduce((s, t) => s + t.pnl, 0) / losses.reduce((s, t) => s + t.pnl, 0)) : null,
    maxDrawdown: maxDD * 100,
    avgHoldBars: trades.length ? trades.reduce((s, t) => s + t.bars, 0) / trades.length : 0,
    feesPaid: trades.length * 2 * feeRate * capital * (positionPct / 100),
    trades,
    equity,
    // 基准
    bhReturn: (bhFinal / capital - 1) * 100,
    bhMaxDrawdown: bhMaxDD * 100,
    excess: (finalEq / capital - 1) * 100 - (bhFinal / capital - 1) * 100,
  };
}
