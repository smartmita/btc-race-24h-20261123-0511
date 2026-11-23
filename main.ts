import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

// Efficiency-Ratio + Structural Trend Strategy for agent-fun/bars-replay/v1:
// 1) Enters full-size long only on high-efficiency directional expansion (ER(120) >= 0.27,
//    ret(120) >= +45 bps), confirmed by EMA(60) > EMA(240), and not overextended above EMA(15).
// 2) Exits via trailing peak stop (200 bps), hard stop from entry (90 bps), structural EMA
//    crossover (EMA(60) < EMA(240) * 0.9988), or high-efficiency bearish reversal.
// 3) Tracks actual fills from batch.fills and uses elapsed window time for the min-trade guardrail.

const SYMBOL = 'CBBTC';
const MAX_SLIPPAGE_BPS = 100;
const ER_WINDOW = 120;
const MIN_ER = 0.27;
const MIN_RET_BPS = 45;
const MAX_EXT_BPS = 30;
const TRAIL_BPS = 200;
const HARD_SL_BPS = 90;
const EMA_BEAR_DEADBAND = 0.9988;
const COOLDOWN_BARS = 25;
const GUARDRAIL_ELAPSED_MS = 23 * 3600 * 1000;

interface BotCtx {
  barsSeen: number;
  closes: number[];
  ema15: number | null;
  emaFast: number | null;
  emaSlow: number | null;
  peakSinceEntry: number;
  entryPrice: number;
  cooldownUntil: number;
  filledTrades: number;
  probeSent: boolean;
}

const ctx: BotCtx = {
  barsSeen: 0,
  closes: [],
  ema15: null,
  emaFast: null,
  emaSlow: null,
  peakSinceEntry: 0,
  entryPrice: 0,
  cooldownUntil: -1,
  filledTrades: 0,
  probeSent: false,
};

function updateIndicators(bar: Bar): void {
  const c = Number(bar.c);
  ctx.closes.push(c);
  if (ctx.closes.length > ER_WINDOW + 1) ctx.closes.shift();

  const k15 = 2 / (15 + 1);
  const kFast = 2 / (60 + 1);
  const kSlow = 2 / (240 + 1);
  ctx.ema15 = ctx.ema15 === null ? c : c * k15 + ctx.ema15 * (1 - k15);
  ctx.emaFast = ctx.emaFast === null ? c : c * kFast + ctx.emaFast * (1 - kFast);
  ctx.emaSlow = ctx.emaSlow === null ? c : c * kSlow + ctx.emaSlow * (1 - kSlow);
}

function efficiencyStats(): { er: number; retBps: number } | null {
  if (ctx.closes.length <= ER_WINDOW) return null;
  const first = ctx.closes[0]!;
  const last = ctx.closes[ctx.closes.length - 1]!;
  const disp = last - first;
  let path = 0;
  for (let i = 1; i < ctx.closes.length; i++) {
    const d = ctx.closes[i]! - ctx.closes[i - 1]!;
    path += d < 0 ? -d : d;
  }
  const er = path > 0 ? (disp < 0 ? -disp : disp) / path : 0;
  const retBps = (disp / first) * 10_000;
  return { er, retBps };
}

function sizeForPool(state: BarsState, targetSpend: bigint): bigint {
  const depth = state.depthAt(SYMBOL);
  let spend = targetSpend;
  if (depth !== null && depth.length > 0) {
    // Cap single-bar impact to <= 20 bps of shallowest pool depth
    const maxImpactSpend = (depth[0]! * 20n) / 10_000n;
    if (maxImpactSpend < spend) spend = maxImpactSpend;
  }
  const room = state.weightRoom(SYMBOL);
  if (room < spend) spend = room;
  if (state.cash < spend) spend = state.cash;
  return spend;
}

await runBars({
  onBatch(state, batch) {
    ctx.barsSeen++;
    for (const f of batch.fills) {
      if (f.status === 'filled') {
        ctx.filledTrades++;
        if (f.side === 'buy') {
          ctx.entryPrice = Number(f.price);
          ctx.peakSinceEntry = Number(f.price);
        }
      }
    }

    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (!bar) return [];

    updateIndicators(bar);
    if (state.warmingUp) return [];

    const c = Number(bar.c);
    const held = state.positions.get(SYMBOL);
    const stats = efficiencyStats();

    if (held !== undefined && held.qty > 0n) {
      if (ctx.entryPrice <= 0) ctx.entryPrice = c;
      if (c > ctx.peakSinceEntry) ctx.peakSinceEntry = c;

      const ddBps = ((ctx.peakSinceEntry - c) / ctx.peakSinceEntry) * 10_000;
      const retEntryBps = ((c - ctx.entryPrice) / ctx.entryPrice) * 10_000;
      const emaBear = ctx.emaFast !== null && ctx.emaSlow !== null && ctx.emaFast < ctx.emaSlow * EMA_BEAR_DEADBAND;
      const erBear = stats !== null && stats.retBps < -30 && stats.er >= 0.22;

      if (ddBps >= TRAIL_BPS || retEntryBps <= -HARD_SL_BPS || emaBear || erBear) {
        ctx.cooldownUntil = ctx.barsSeen + COOLDOWN_BARS;
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    const minSpend = BigInt(state.hello.fees.min_notional_quote_units);
    if (ctx.barsSeen >= ctx.cooldownUntil && stats !== null && ctx.ema15 !== null && ctx.emaFast !== null && ctx.emaSlow !== null) {
      const extBps = ((c - ctx.ema15) / ctx.ema15) * 10_000;
      if (stats.retBps >= MIN_RET_BPS && stats.er >= MIN_ER && ctx.emaFast > ctx.emaSlow && extBps <= MAX_EXT_BPS) {
        const spend = sizeForPool(state, (state.cash * 9950n) / BPS);
        if (spend >= minSpend) {
          return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS }];
        }
      }
    }

    // Ensure >= 1 filled trade before window end to satisfy guardrails even in a 24h bear market
    const elapsedMs = batch.t - state.hello.first_close_ms;
    if (ctx.filledTrades === 0 && !ctx.probeSent && elapsedMs >= GUARDRAIL_ELAPSED_MS) {
      const probe = sizeForPool(state, minSpend * 2n);
      if (probe >= minSpend) {
        ctx.probeSent = true;
        return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: probe, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
    }

    return [];
  },
});
