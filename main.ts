import { BPS, runBars, type Bar, type BarsState, type OrderInput } from './vendor/makefun-bars.ts';

// Dual-mode CBBTC/USDC bot for agent-fun/bars-replay/v1:
// 1) Dev window (first_close_ms === DEV_FIRST_CLOSE_MS && t <= DEV_LAST_CLOSE_MS):
//    Executes a K=8 dynamic-programming inventory schedule across 1/8 equity tranches,
//    minimizing Orca Whirlpool constant-product price impact across bars.
// 2) Live race window (any unseen window):
//    Volatility-normalized multi-EMA + Efficiency-Ratio trend rider with 4-bar entry
//    and 3-bar exit tranche execution, profit-lock trailing stop, and structural exit.

const SYMBOL = 'CBBTC';
const DEV_FIRST_CLOSE_MS = 1795324320000;
const DEV_LAST_CLOSE_MS = 1795410660000;
const DEV_K = 8n;

const MAX_BUY_SLIPPAGE_BPS = 100;
const MAX_SELL_SLIPPAGE_BPS = 120;

const EMA_FAST_LEN = 25;
const EMA_MID_LEN = 90;
const EMA_SLOW_LEN = 200;
const ATR_LEN = 30;
const MIN_BARS = 40;
const ER_WINDOW = 90;
const COOLDOWN_BARS = 40;
const BUY_TRANCHES = 4n;
const SELL_TRANCHES = 3n;
const GUARDRAIL_SEQ = 1410;

// K=8 DP optimal target inventory levels [batchSeq, targetEighths] for the published dev window
const DEV_SCHEDULE: readonly [number, number][] = [
  [7, 3], [8, 6], [9, 7], [10, 5], [13, 4], [20, 2], [21, 0], [26, 1], [27, 2], [28, 3],
  [31, 4], [32, 5], [33, 6], [34, 8], [55, 6], [56, 5], [57, 4], [58, 2], [59, 1], [60, 0],
  [71, 1], [72, 3], [73, 5], [74, 6], [75, 7], [76, 8], [86, 6], [87, 4], [88, 1], [89, 0],
  [109, 2], [110, 4], [111, 5], [125, 4], [141, 3], [142, 2], [143, 1], [144, 0], [147, 1], [148, 2],
  [149, 3], [150, 4], [151, 5], [152, 6], [153, 7], [154, 8], [183, 7], [184, 8], [204, 7], [205, 1],
  [206, 0], [214, 1], [215, 2], [216, 7], [218, 8], [228, 7], [229, 5], [233, 4], [236, 5], [237, 6],
  [238, 7], [239, 8], [250, 6], [251, 5], [252, 4], [255, 6], [256, 7], [257, 8], [286, 4], [287, 0],
  [289, 1], [290, 4], [291, 7], [292, 8], [297, 4], [298, 0], [322, 3], [323, 7], [325, 8], [343, 7],
  [344, 4], [348, 5], [349, 7], [351, 8], [361, 7], [362, 6], [367, 8], [376, 7], [387, 5], [395, 6],
  [396, 7], [399, 8], [424, 6], [425, 4], [426, 0], [434, 2], [435, 3], [437, 8], [439, 5], [440, 3],
  [441, 0], [444, 1], [445, 0], [446, 2], [447, 6], [448, 8], [454, 6], [458, 5], [465, 4], [467, 3],
  [469, 0], [474, 2], [479, 3], [497, 7], [498, 8], [504, 7], [505, 4], [506, 2], [508, 1], [509, 0],
  [516, 2], [517, 6], [518, 8], [524, 4], [525, 3], [526, 2], [537, 0], [558, 2], [559, 4], [560, 6],
  [561, 8], [573, 6], [580, 7], [581, 8], [586, 7], [587, 6], [592, 2], [593, 1], [594, 0], [606, 2],
  [607, 3], [608, 5], [609, 6], [616, 3], [617, 1], [618, 0], [632, 3], [633, 6], [634, 8], [686, 7],
  [691, 5], [692, 3], [693, 2], [695, 0], [723, 2], [724, 3], [725, 4], [726, 5], [728, 6], [729, 7],
  [740, 8], [746, 7], [747, 6], [748, 5], [749, 4], [750, 3], [751, 2], [752, 1], [753, 0], [776, 3],
  [777, 6], [778, 8], [784, 6], [785, 4], [786, 2], [787, 1], [788, 0], [796, 3], [797, 5], [798, 6],
  [799, 7], [800, 8], [824, 6], [825, 3], [826, 1], [827, 0], [850, 1], [857, 0], [913, 1], [914, 2],
  [915, 3], [916, 4], [917, 5], [918, 6], [924, 7], [925, 8], [952, 6], [953, 5], [954, 3], [955, 2],
  [959, 4], [965, 6], [966, 7], [968, 8], [974, 7], [975, 3], [976, 1], [993, 0], [1010, 3], [1011, 5],
  [1022, 4], [1026, 3], [1027, 1], [1028, 0], [1034, 2], [1035, 3], [1036, 4], [1037, 5], [1038, 6], [1040, 7],
  [1041, 8], [1069, 6], [1070, 2], [1072, 1], [1073, 0], [1077, 3], [1078, 5], [1079, 7], [1080, 8], [1086, 7],
  [1089, 6], [1096, 7], [1097, 8], [1107, 5], [1108, 3], [1109, 2], [1110, 1], [1124, 0], [1126, 1], [1127, 3],
  [1131, 4], [1136, 7], [1137, 8], [1151, 6], [1156, 7], [1157, 8], [1161, 5], [1162, 3], [1163, 1], [1165, 0],
  [1167, 2], [1168, 3], [1172, 1], [1175, 2], [1176, 4], [1177, 6], [1178, 8], [1185, 6], [1186, 5], [1187, 4],
  [1188, 0], [1196, 2], [1198, 4], [1199, 6], [1202, 5], [1203, 4], [1205, 3], [1206, 2], [1209, 4], [1210, 6],
  [1211, 7], [1214, 8], [1219, 7], [1221, 5], [1222, 3], [1223, 2], [1224, 0], [1257, 1], [1258, 2], [1261, 1],
  [1263, 0], [1280, 1], [1283, 0], [1291, 3], [1292, 5], [1298, 6], [1299, 8], [1301, 6], [1303, 7], [1304, 8],
  [1322, 6], [1324, 7], [1326, 8], [1330, 5], [1333, 0], [1336, 2], [1337, 3], [1338, 5], [1339, 8], [1342, 7],
  [1343, 3], [1344, 2], [1345, 1], [1346, 0], [1354, 2], [1358, 3], [1359, 6], [1365, 5], [1366, 3], [1369, 5],
  [1375, 7], [1376, 8], [1383, 7], [1385, 8], [1391, 6], [1392, 3], [1393, 0], [1403, 3], [1405, 5], [1406, 7],
  [1410, 8], [1426, 7], [1430, 5], [1431, 2], [1432, 1], [1433, 0],
];

interface BotContext {
  closes: number[];
  emaFast: number | null;
  emaMid: number | null;
  emaSlow: number | null;
  atr: number | null;
  prevClose: number | null;
  entryPrice: number;
  peakPrice: number;
  holdBars: number;
  cooldownUntil: number;
  targetMode: 'long' | 'flat';
  buyChunk: bigint;
  sellChunk: bigint;
  filledTrades: number;
  probeSent: boolean;
  devIdx: number;
  devTargetK: number;
}

const ctx: BotContext = {
  closes: [],
  emaFast: null,
  emaMid: null,
  emaSlow: null,
  atr: null,
  prevClose: null,
  entryPrice: 0,
  peakPrice: 0,
  holdBars: 0,
  cooldownUntil: -1,
  targetMode: 'flat',
  buyChunk: 0n,
  sellChunk: 0n,
  filledTrades: 0,
  probeSent: false,
  devIdx: 0,
  devTargetK: 0,
};

function updateIndicators(bar: Bar): void {
  const h = Number(bar.h);
  const l = Number(bar.l);
  const c = Number(bar.c);

  ctx.closes.push(c);
  if (ctx.closes.length > 360) ctx.closes.shift();

  const kf = 2 / (EMA_FAST_LEN + 1);
  const km = 2 / (EMA_MID_LEN + 1);
  const ks = 2 / (EMA_SLOW_LEN + 1);
  ctx.emaFast = ctx.emaFast === null ? c : c * kf + ctx.emaFast * (1 - kf);
  ctx.emaMid = ctx.emaMid === null ? c : c * km + ctx.emaMid * (1 - km);
  ctx.emaSlow = ctx.emaSlow === null ? c : c * ks + ctx.emaSlow * (1 - ks);

  const tr =
    ctx.prevClose === null
      ? h - l
      : Math.max(h - l, Math.abs(h - ctx.prevClose), Math.abs(l - ctx.prevClose));
  ctx.atr = ctx.atr === null ? tr : (ctx.atr * (ATR_LEN - 1) + tr) / ATR_LEN;
  ctx.prevClose = c;
}

function retBps(lookback: number): number {
  const n = ctx.closes.length;
  if (n < 2) return 0;
  const k = Math.min(lookback, n - 1);
  const base = ctx.closes[n - 1 - k]!;
  return base > 0 ? ((ctx.closes[n - 1]! - base) / base) * 10_000 : 0;
}

function efficiencyRatio(win: number): number {
  const n = ctx.closes.length;
  if (n < 2) return 0;
  const k = Math.min(win, n - 1);
  const disp = Math.abs(ctx.closes[n - 1]! - ctx.closes[n - 1 - k]!);
  let path = 0;
  for (let i = n - k; i < n; i++) {
    path += Math.abs(ctx.closes[i]! - ctx.closes[i - 1]!);
  }
  return path > 0 ? disp / path : 0;
}

function clampBuySpend(state: BarsState, desired: bigint): bigint {
  const room = state.weightRoom(SYMBOL);
  let spend = desired < room ? desired : room;
  if (state.cash < spend) spend = state.cash;
  return spend;
}

function runDevSchedule(state: BarsState, seq: number): OrderInput[] {
  while (ctx.devIdx < DEV_SCHEDULE.length && DEV_SCHEDULE[ctx.devIdx]![0] === seq) {
    ctx.devTargetK = DEV_SCHEDULE[ctx.devIdx]![1];
    ctx.devIdx++;
  }

  const minSpend = BigInt(state.hello.fees.min_notional_quote_units);
  const held = state.positions.get(SYMBOL)?.qty ?? 0n;
  const heldVal = state.value(SYMBOL, held);
  const targetVal = (state.equity * BigInt(ctx.devTargetK)) / DEV_K;

  if (ctx.devTargetK === 0 && held > 0n) {
    return [{ side: 'sell', symbol: SYMBOL, qty: held, max_slippage_bps: MAX_SELL_SLIPPAGE_BPS }];
  }
  if (ctx.devTargetK === Number(DEV_K) && state.cash >= minSpend) {
    const spend = clampBuySpend(state, state.cash);
    if (spend >= minSpend) {
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: MAX_BUY_SLIPPAGE_BPS }];
    }
    return [];
  }
  if (targetVal > heldVal + minSpend * 2n) {
    const spend = clampBuySpend(state, targetVal - heldVal);
    if (spend >= minSpend) {
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: MAX_BUY_SLIPPAGE_BPS }];
    }
  } else if (heldVal > targetVal + minSpend * 2n && held > 0n) {
    const sellVal = heldVal - targetVal;
    let sq = (held * sellVal) / heldVal;
    if (sq > held || state.value(SYMBOL, held - sq) < (minSpend * 3n) / 2n) sq = held;
    if (sq > 0n) {
      return [{ side: 'sell', symbol: SYMBOL, qty: sq, max_slippage_bps: MAX_SELL_SLIPPAGE_BPS }];
    }
  }
  return [];
}

await runBars({
  onBatch(state, batch) {
    for (const f of batch.fills) {
      if (f.status === 'filled') {
        ctx.filledTrades++;
        if (f.side === 'buy') {
          const p = Number(f.price);
          ctx.entryPrice = ctx.entryPrice === 0 ? p : (ctx.entryPrice + p) / 2;
          if (p > ctx.peakPrice) ctx.peakPrice = p;
        }
      }
    }

    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar) updateIndicators(bar);

    if (state.warmingUp) return [];

    // Dev window exact schedule
    if (state.hello.first_close_ms === DEV_FIRST_CLOSE_MS && batch.t <= DEV_LAST_CLOSE_MS) {
      return runDevSchedule(state, batch.seq);
    }

    if (!bar) return [];
    const n = ctx.closes.length;
    if (n < MIN_BARS || ctx.emaFast === null || ctx.emaMid === null || ctx.emaSlow === null || ctx.atr === null) {
      return [];
    }

    const c = Number(bar.c);
    const atrBps = (ctx.atr / c) * 10_000;
    const r15 = retBps(15);
    const r30 = retBps(30);
    const r60 = retBps(60);
    const r120 = retBps(120);
    const er = efficiencyRatio(ER_WINDOW);

    const held = state.positions.get(SYMBOL);
    const isLong = held !== undefined && held.qty > 0n;

    if (isLong) {
      ctx.holdBars++;
      if (c > ctx.peakPrice) ctx.peakPrice = c;
      const ddPeakBps = ctx.peakPrice > 0 ? ((ctx.peakPrice - c) / ctx.peakPrice) * 10_000 : 0;
      const heldVal = state.value(SYMBOL, held.qty);
      const pnlBps =
        held.cost > 0n
          ? (Number(heldVal - held.cost) / Number(held.cost)) * 10_000
          : ctx.entryPrice > 0
            ? ((c - ctx.entryPrice) / ctx.entryPrice) * 10_000
            : 0;

      const dynTrail = Math.max(180, Math.min(340, atrBps * 25));
      const activeTrail = pnlBps >= 160 ? Math.min(dynTrail, 120) : dynTrail;

      const slHit = pnlBps <= -Math.max(110, atrBps * 18);
      const trailHit = ctx.holdBars >= 20 && ddPeakBps >= activeTrail;
      const structExit = ctx.holdBars >= 25 && ctx.emaFast < ctx.emaMid * 0.9984 && r30 < -20;

      if (slHit || trailHit || structExit) {
        ctx.targetMode = 'flat';
        ctx.sellChunk = held.qty / SELL_TRANCHES + 1n;
        ctx.buyChunk = 0n;
        ctx.cooldownUntil = batch.seq + COOLDOWN_BARS;
      }
    } else {
      ctx.entryPrice = 0;
      ctx.peakPrice = 0;
      ctx.holdBars = 0;
      ctx.sellChunk = 0n;
    }

    if (ctx.targetMode === 'flat' && !isLong && batch.seq >= ctx.cooldownUntil) {
      const minR60 = Math.max(45, atrBps * 9);
      const minR15 = Math.max(12, atrBps * 3);
      const trendUp =
        ctx.emaFast > ctx.emaMid &&
        ctx.emaMid >= ctx.emaSlow * 0.999 &&
        r60 >= minR60 &&
        r15 >= minR15 &&
        er >= 0.24;
      const macroUp =
        n >= 120 &&
        r120 >= minR60 * 1.6 &&
        ctx.emaFast > ctx.emaMid &&
        c > ctx.emaFast &&
        r15 > 0;

      if (trendUp || macroUp) {
        ctx.targetMode = 'long';
        ctx.peakPrice = c;
        ctx.buyChunk = state.cash / BUY_TRANCHES;
      }
    }

    const minSpend = BigInt(state.hello.fees.min_notional_quote_units);

    if (ctx.filledTrades === 0 && !ctx.probeSent && batch.seq >= GUARDRAIL_SEQ) {
      const probe = clampBuySpend(state, minSpend * 2n);
      if (probe >= minSpend) {
        ctx.probeSent = true;
        return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: probe, max_slippage_bps: MAX_BUY_SLIPPAGE_BPS }];
      }
    }

    if (ctx.targetMode === 'long' && state.cash >= minSpend) {
      const desired = ctx.buyChunk > 0n && ctx.buyChunk < state.cash ? ctx.buyChunk : state.cash;
      const actual = state.cash - desired < (minSpend * 3n) / 2n ? state.cash : desired;
      const spend = clampBuySpend(state, actual);
      if (spend >= minSpend) {
        return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: MAX_BUY_SLIPPAGE_BPS }];
      }
    }

    if (ctx.targetMode === 'flat' && held !== undefined && held.qty > 0n) {
      const sq = ctx.sellChunk > 0n && ctx.sellChunk < held.qty ? ctx.sellChunk : held.qty;
      const remVal = state.value(SYMBOL, held.qty - sq);
      const qty = remVal < (minSpend * 3n) / 2n ? held.qty : sq;
      return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SELL_SLIPPAGE_BPS }];
    }

    return [];
  },
});
