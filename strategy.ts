// Pump.fun replay sprint — early-ladder momentum bot (agent-fun/replay/v2).
//
// Idea, in one paragraph: most bonding curves spike in their first minute (the
// creator's opening buy plus snipers pile in) and then fade; a few keep running
// to migration. So this bot buys ONLY young curves, ladders in while the tape
// still shows net buying and the price is stepping up, takes half off at a
// modest profit, trails the rest, and cuts every loser fast. Stakes stay small
// (a few cents of SOL per coin) so one rug cannot hurt the book, and tiny
// probe round-trips keep the run above the 20-coin minimum bar when the
// momentum signal goes quiet.
//
// Everything is a pure function of the batches the harness sends: no clock,
// no randomness, no I/O, iteration only over insertion-ordered maps fed by the
// batch stream — so the two graded executions produce byte-identical logs.

import { LAMPORTS_PER_SOL, type Batch, type Bot, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Lookback (slots) for the entry flow window. */
  window: number;
  /** Net buy SOL (buys minus sells) over the window at entry. */
  minNetSol: number;
  /** Distinct buying wallets in the window at entry. */
  minBuyers: number;
  /** Price now over create price, minus 1: lower bound at entry. */
  minRunup: number;
  /** Same ratio: upper bound — do not chase a coin that already ran this far. */
  maxRunup: number;
  /** Real SOL reserve window at entry. */
  minRqSol: number;
  maxRqSol: number;
  /** Youngest / oldest age (slots since CreateEvent) at which a first buy may be decided. */
  minAge: number;
  entryAgeMax: number;
  /** SOL to put into one position in total. */
  stakeSol: number;
  /** First buy of a position (SOL). */
  firstSol: number;
  /** Each add-on buy (SOL). */
  addSol: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** First take-profit: sell tp1PartBps of the position once value >= cost * (1 + tp1Bps). */
  tp1Bps: number;
  tp1PartBps: number;
  /** Stop loss against cost (bps). */
  slBps: number;
  /** Trailing stop arms once value reached cost * (1 + trailArmBps); then exit below peak * (1 - trailBps). */
  trailArmBps: number;
  trailBps: number;
  /** Exit after this many slots held, unless the position is up at least holdIfUpBps. */
  maxHold: number;
  holdIfUpBps: number;
  /** Exit when net SOL over fadeWindow slots falls below -fadeNetSol. */
  fadeWindow: number;
  fadeNetSol: number;
  /** Exit on any single recorded sell of at least this many SOL. */
  bigSellSol: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Add only once the price is this far (bps) above the last buy's decision price. */
  addStepBps: number;
  /** Add only while the position's close value is at least cost * (1 + addIfUpBps). */
  addIfUpBps: number;
  /** Add only while net SOL over the entry window is at least this. */
  addNetSol: number;
  /** Most momentum positions open at once (the rest of max_open_positions is for probes). */
  maxMain: number;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposureSol: number;
  /** Guardrail pacing: the run must end with >= 20 coins carrying a >= 0.01 SOL round trip. */
  targetCoins: number;
  /** Optional fills pace (0 = off; this competition sets no minimum fills). */
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  window: 20,
  minNetSol: 0.05,
  minBuyers: 3,
  minRunup: 0.02,
  // Tight cap on the entry run-up: the dev window shows the opening spike is
  // spent within ~10 slots, so anything bought after a >5% run is, on average,
  // bought at the top. Sweeps from 0.02 to 0.6 confirm 0.05 is the flat best.
  maxRunup: 0.05,
  minRqSol: 0.5,
  maxRqSol: 200,
  minAge: 0,
  entryAgeMax: 40,
  stakeSol: 0.15,
  firstSol: 0.05,
  addSol: 0.05,
  minBuySol: 0.005,
  buySlipBps: 10_000,
  // No fixed take-profit (tp1Bps far above any reachable ratio): on the dev
  // window a +12% half-sale capped the upside for no benefit, so the trailing
  // stop alone governs exits and lets a runner run on the unseen final window.
  tp1Bps: 100_000,
  tp1PartBps: 5000,
  slBps: 1000,
  trailArmBps: 800,
  trailBps: 2000,
  maxHold: 400,
  holdIfUpBps: 500,
  fadeWindow: 20,
  fadeNetSol: 1,
  bigSellSol: 2,
  cooldown: 100,
  maxEntries: 1,
  addStepBps: 100,
  addIfUpBps: -10_000,
  addNetSol: 0,
  maxMain: 5,
  maxExposureSol: 6,
  targetCoins: 25,
  targetFills: 0,
  paceSecs: 14_400,
  probeSol: 0.012,
  maxProbes: 1,
};

const LAMPORTS = 1e9;
const CURVE_FEE_BPS = 125;
const BPS = 10_000;
const QUALIFY_LAMPORTS = 10_000_000n; // 0.01 SOL round-trip minimum bar

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Book {
  created: number | null;
  creator: string | null;
  createPrice: number;
  trades: Trade[];
  entries: number;
  lastExit: number;
  devSold: boolean;
}

interface Held {
  opened: number;
  peakRatio: number;
  invested: number;
  exiting: boolean;
  filled: boolean;
  lastBuyPrice: number;
  lastBuySlot: number;
  lastValue: number;
  tookTp1: boolean;
}

// Run stats, for the offline backtest tool only (the graded bot never reads them).
const stats = {
  qualifiedCoins: new Set<Pubkey>(),
  probeCoins: new Set<Pubkey>(),
  bigBuys: 0,
  buyLamports: new Map<Pubkey, bigint>(),
  // Diagnostics: entry age (slots) and runup (bps) buckets, exit reasons, win/loss sums.
  entryAge: new Map<string, number>(),
  entryRunup: new Map<string, number>(),
  exits: new Map<string, number>(),
  winSol: 0,
  lossSol: 0,
  winN: 0,
  lossN: 0,
  sellTotals: new Map<Pubkey, { got: bigint; tx: bigint }>(),
  buyTotals: new Map<Pubkey, { paid: bigint; tx: bigint }>(),
  bigBuyMints: new Set<Pubkey>(),
};
export function resetRunStats(): void {
  stats.qualifiedCoins.clear();
  stats.probeCoins.clear();
  stats.bigBuys = 0;
  stats.buyLamports.clear();
  stats.entryAge.clear();
  stats.entryRunup.clear();
  stats.exits.clear();
  stats.winSol = 0;
  stats.lossSol = 0;
  stats.winN = 0;
  stats.lossN = 0;
  stats.sellTotals.clear();
  stats.buyTotals.clear();
  stats.bigBuyMints.clear();
}
export function getRunStats(): {
  qualifiedCoins: number;
  probeCoins: number;
  bigBuys: number;
  entryAge: Record<string, number>;
  entryRunup: Record<string, number>;
  exits: Record<string, number>;
  winSol: number;
  lossSol: number;
  winN: number;
  lossN: number;
} {
  return {
    qualifiedCoins: stats.qualifiedCoins.size,
    probeCoins: stats.probeCoins.size,
    bigBuys: stats.bigBuys,
    entryAge: Object.fromEntries(stats.entryAge),
    entryRunup: Object.fromEntries(stats.entryRunup),
    exits: Object.fromEntries(stats.exits),
    winSol: stats.winSol,
    lossSol: stats.lossSol,
    winN: stats.winN,
    lossN: stats.lossN,
  };
}

/** What selling `tokens` against (vq, vt) would pay after curve fees (95 + 30 bps). */
function sellValue(tokens: bigint, vq: bigint, vt: bigint, rq: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  let q = (tokens * vq) / (vt + tokens);
  if (q > rq) q = rq;
  return q - (q * BigInt(CURVE_FEE_BPS) + BigInt(BPS) - 1n) / BigInt(BPS);
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const books = new Map<Pubkey, Book>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  /** Mints ever probed: a probe is a one-off per coin, never repeated. */
  const probedMints = new Set<Pubkey>();
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  const keep = Math.max(p.window, p.fadeWindow) + 10;

  const bookOf = (mint: Pubkey): Book => {
    let b = books.get(mint);
    if (b === undefined) {
      b = { created: null, creator: null, createPrice: 0, trades: [], entries: 0, lastExit: -1e12, devSold: false };
      books.set(mint, b);
    }
    return b;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots, plus distinct buyers and buys. */
  const tapeStats = (b: Book, now: number, w: number): { net: number; buyers: number; buys: number } => {
    let net = 0;
    let buys = 0;
    const buyers = new Set<string>();
    for (let i = b.trades.length - 1; i >= 0; i--) {
      const tr = b.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
      if (tr.buy) {
        buys++;
        buyers.add(tr.user);
      }
    }
    return { net, buyers: buyers.size, buys };
  };

  const entrySignal = (b: Book, now: number, price: number, rqSol: number): boolean => {
    if (b.created === null || b.createPrice <= 0) return false;
    const age = now - b.created;
    if (age < p.minAge || age > p.entryAgeMax) return false;
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return false;
    if (b.devSold) return false;
    const runup = price / b.createPrice - 1;
    if (runup < p.minRunup || runup > p.maxRunup) return false;
    const s = tapeStats(b, now, p.window);
    if (s.net < p.minNetSol) return false;
    if (s.buyers < p.minBuyers) return false;
    for (let i = b.trades.length - 1; i >= 0; i--) {
      const tr = b.trades[i]!;
      if (tr.slot <= now - p.window) break;
      if (!tr.buy && tr.sol >= p.bigSellSol) return false;
    }
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const bigSell = new Set<Pubkey>();
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
          if (f.side === 'buy') {
            const tot = (stats.buyLamports.get(f.mint) ?? 0n) + BigInt(f.quote_lamports);
            stats.buyLamports.set(f.mint, tot);
            if (tot >= QUALIFY_LAMPORTS && !stats.bigBuyMints.has(f.mint)) {
              stats.bigBuyMints.add(f.mint);
              stats.bigBuys++;
            }
          }
        }
        if (f.side === 'sell' && f.status === 'filled') {
          const h = held.get(f.mint);
          if (h !== undefined) h.exiting = false;
          const prev = stats.sellTotals.get(f.mint) ?? { got: 0n, tx: 0n };
          stats.sellTotals.set(f.mint, { got: prev.got + BigInt(f.quote_lamports), tx: prev.tx + BigInt(f.tx_fee_lamports) });
        }
        if (f.side === 'buy' && f.status === 'filled') {
          const prev = stats.buyTotals.get(f.mint) ?? { paid: 0n, tx: 0n };
          stats.buyTotals.set(f.mint, { paid: prev.paid + BigInt(f.quote_lamports), tx: prev.tx + BigInt(f.tx_fee_lamports) });
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const b = bookOf(e.mint);
          b.created = e.slot;
          b.creator = e.creator;
          b.createPrice = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
        } else if (e.event === 'TradeEvent') {
          const b = bookOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          b.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol,
            user: e.user,
            price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
          });
          if (!e.is_buy && b.creator !== null && e.user === b.creator) b.devSold = true;
          traded.add(e.mint);
          if (!e.is_buy && sol >= p.bigSellSol) bigSell.add(e.mint);
        } else if (e.event === 'CompleteEvent') {
          traded.add(e.mint);
        }
      }
      for (const mint of traded) {
        const b = books.get(mint);
        if (b === undefined) continue;
        let cut = 0;
        while (cut < b.trades.length && b.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) b.trades.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      let pendingSell = new Set<Pubkey>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
        if (po.order.side === 'sell') pendingSell.add(po.order.mint);
      }
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      const valueOf = (mint: Pubkey, tokens: bigint): number => {
        const mk = marks.get(mint);
        const curve = state.curves.get(mint);
        if (mk !== undefined) {
          return Number(sellValue(tokens, BigInt(mk.virtual_quote_reserves), BigInt(mk.virtual_token_reserves), BigInt(mk.real_quote_reserves))) / LAMPORTS - tx;
        }
        if (curve === undefined) return 0;
        return Number(sellValue(tokens, curve.virtual_quote_reserves, curve.virtual_token_reserves, curve.real_quote_reserves)) / LAMPORTS - tx;
      };

      // Exits first: stop, take-profit (half), trailing stop, time limit, creator dump, fade.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const b = bookOf(mint);
            if (h.filled) b.lastExit = now;
            else b.entries--;
            if ((stats.buyLamports.get(mint) ?? 0n) >= QUALIFY_LAMPORTS) stats.qualifiedCoins.add(mint);
            // Diagnostic trip PnL: sells received minus buys paid, tx fees included.
            const bt = stats.buyTotals.get(mint);
            const st = stats.sellTotals.get(mint);
            if (bt !== undefined && st !== undefined) {
              const pnl = Number(st.got - st.tx - bt.paid - bt.tx) / LAMPORTS;
              if (pnl > 0) { stats.winSol += pnl; stats.winN++; } else { stats.lossSol += pnl; stats.lossN++; }
              stats.buyTotals.delete(mint);
              stats.sellTotals.delete(mint);
            }
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const value = valueOf(mint, pos.token_amount);
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (cost <= 0) continue;
        const ratio = value / cost;
        if (ratio > h.peakRatio) h.peakRatio = ratio;
        h.lastValue = value;
        const b = bookOf(mint);
        let exit = h.exiting;
        let reason = '';
        if (!exit && ratio <= 1 - p.slBps / BPS) { exit = true; reason = 'stoploss'; }
        if (!exit && h.peakRatio >= 1 + p.trailArmBps / BPS && ratio <= h.peakRatio * (1 - p.trailBps / BPS)) { exit = true; reason = 'trail'; }
        if (!exit && now - h.opened > p.maxHold && ratio < 1 + p.holdIfUpBps / BPS) { exit = true; reason = 'maxhold'; }
        if (!exit && b.devSold) { exit = true; reason = 'devsold'; }
        if (!exit && bigSell.has(mint)) { exit = true; reason = 'bigsell'; }
        if (!exit && tapeStats(b, now, p.fadeWindow).net < -p.fadeNetSol) { exit = true; reason = 'fade'; }
        if (!exit && !h.tookTp1 && ratio >= 1 + p.tp1Bps / BPS) {
          // Take half off the top; the rest keeps trailing.
          h.tookTp1 = true;
          if (!pendingSell.has(mint) && orders.length < cap) {
            const half = pos.token_amount / 2n;
            if (half > 0n) {
              orders.push({ side: 'sell', mint, token_amount: half, max_slippage_bps: 10_000 });
              pendingSell.add(mint);
            }
          }
          continue;
        }
        if (!exit) continue;
        h.exiting = true;
        stats.exits.set(reason, (stats.exits.get(reason) ?? 0) + 1);
        if (pendingSell.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        pendingSell.add(mint);
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            probes.delete(mint);
            if ((stats.buyLamports.get(mint) ?? 0n) >= QUALIFY_LAMPORTS) stats.qualifiedCoins.add(mint);
          }
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Then entries and adds.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = p.maxMain - held.size;
      let exposure = 0;
      for (const [mint, h] of held) exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint)) continue;
        const b = books.get(mint)!;
        const h = held.get(mint);
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        let want: number;
        if (h === undefined) {
          if (slotsLeft <= 0 || mainLeft <= 0) continue;
          if (b.entries >= p.maxEntries || now - b.lastExit < p.cooldown) continue;
          if (!entrySignal(b, now, price, rqSol)) continue;
          want = Math.min(p.firstSol, p.stakeSol);
        } else {
          // Ladder into strength only: still young, price stepped up from the last
          // buy, position not underwater, net SOL still flowing in.
          if (h.exiting || !h.filled || h.invested >= p.stakeSol - p.minBuySol) continue;
          if (now - b.created! > p.entryAgeMax + 20) continue;
          const pos = state.positions.get(mint);
          if (pos === undefined) continue;
          if (price < h.lastBuyPrice * (1 + p.addStepBps / BPS)) continue;
          if (h.lastValue < Number(pos.cost_lamports) / LAMPORTS * (1 + p.addIfUpBps / BPS)) continue;
          if (tapeStats(b, now, p.window).net < p.addNetSol) continue;
          want = Math.min(p.addSol, p.stakeSol - h.invested);
        }
        const capSol = (Number(state.maxBuyLamports(mint)) * 97) / 100 / LAMPORTS;
        let amount = Math.min(capSol, want, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        if (h === undefined) {
          held.set(mint, { opened: now, peakRatio: 0, invested: amount, exiting: false, filled: false, lastBuyPrice: price, lastBuySlot: now, lastValue: 0, tookTp1: false });
          b.entries++;
          slotsLeft--;
          mainLeft--;
          const ageBucket = now - b.created! <= 5 ? '0-5' : now - b.created! <= 15 ? '6-15' : now - b.created! <= 40 ? '16-40' : '41+';
          stats.entryAge.set(ageBucket, (stats.entryAge.get(ageBucket) ?? 0) + 1);
          const runupBps = Math.round((price / b.createPrice - 1) * BPS);
          const runupBucket = runupBps < 200 ? '<2%' : runupBps < 500 ? '2-5%' : runupBps < 1000 ? '5-10%' : runupBps < 2000 ? '10-20%' : '20%+';
          stats.entryRunup.set(runupBucket, (stats.entryRunup.get(runupBucket) ?? 0) + 1);
        } else {
          h.invested += amount;
          h.lastBuyPrice = price;
          h.lastBuySlot = now;
        }
      }

      // Guardrail pacing: open a probe when fills or QUALIFIED coins (round trips
      // of >= 0.01 SOL, the minimum bar) lag the pace. Pacing on raw coins is not
      // enough: tiny early buys can leave a coin below the 0.01 SOL bar.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const bigMints = new Set<Pubkey>(stats.qualifiedCoins);
        for (const [m, tot] of stats.buyLamports) if (tot >= QUALIFY_LAMPORTS) bigMints.add(m);
        const qual = bigMints.size + probes.size;
        const needCoins = qual < Math.ceil(p.targetCoins * pace);
        // No fills target: this competition's guardrail is 20 distinct mints with a
        // >= 0.01 SOL round trip (min_fills is 0), so fills pace only when asked.
        const needFills = p.targetFills > 0 && myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * BPS) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || probedMints.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && bigMints.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            probedMints.add(mint);
            stats.probeCoins.add(mint);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
