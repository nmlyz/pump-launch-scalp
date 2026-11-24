// Launch-scalp / dip bot for pump.fun bonding curves (agent-fun/replay/v2).
//
// Idea, from the dev window itself: a coin's first spike is almost never tradable — the price
// jumps on single trades and the slot-end price mean-reverts within two slots, so buying the
// launch loses about 5-13% per trade after fees. What does work, barely, is buying the pullback:
// a coin that already ran (price up to 1.5x its create price), holds at least 3 SOL of real
// reserves (liquid enough that the 1% size cap still lets a 0.01+ SOL round trip through), has
// at least two distinct non-creator buyers, and has pulled back at least 10% from its
// post-creation high. Those dips are bought once, with one fixed stake per coin and no adds.
// A position is sold whole at +20% of cost, cut at -10%, trailed 8% once up 10%, or closed
// after 1800 slots, when the creator sells, or when the coin goes quiet for 1200 slots.
//
// Measured on the kit's full 24h dev window (all three dataset parts, local engine port):
// net -0.265 SOL, 141 round trips over 141 coins (all >= 0.01 SOL, so the 20-coin guardrail
// holds with margin in every 8h slice: 49 / 53 / 35 qualifying coins), max drawdown 3.4%.
// The same window scores the kit's pilots at momentum -9.39, reversion -4.02, sniper -0.49,
// so this bot beats every baseline on net PnL while trading far fewer, more selective coins.
//
// No clock, no randomness, no I/O: a pure function of the batches, so two runs produce
// byte-identical action logs.

import { BPS, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Youngest age (slots since create) at which a coin may be bought. */
  minAge: number;
  /** Oldest age at which a first buy may still be decided. */
  maxAge: number;
  /** SOL to aim for per coin (each buy is still capped at 1% of real SOL). */
  stakeSol: number;
  /** Smallest single buy worth paying the tx fee for (SOL). */
  minBuySol: number;
  /** Real SOL reserve window at decision time. */
  minRealSol: number;
  maxRealSol: number;
  /** Creator's own buys in the create slot: at most this many SOL. */
  maxDevBuySol: number;
  /** Distinct non-creator buyers seen before entry, at least. */
  minBuyers: number;
  /** Price now over the create price, as bps: window. */
  minRunupBps: number;
  maxRunupBps: number;
  /** Recent net flow window (slots) and what it must show (SOL). */
  flowWindow: number;
  minFlowSol: number;
  /** Slippage allowed on buys (bps). */
  buySlippageBps: number;
  /** Exit when the position is worth this much over its cost (bps). */
  tpBps: number;
  /** Exit when it is worth this much under its cost (bps). */
  slBps: number;
  /** Trailing stop: once up at least this much (bps), exit on a fall of this much from the best value. */
  trailArmBps: number;
  trailBps: number;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Exit when no trade has hit the coin for this many slots. */
  staleSlots: number;
  /** Most SOL at cost across all positions at once. */
  maxExposureSol: number;
  /** Buy only after the price pulled back this much (bps) from its post-creation high. 0 = off. */
  dipBps: number;
  /** Extra buys into strength, each on a later batch, up to stakeSol in total. 0 = off. */
  maxAdds: number;
  /** An add needs the price at least this far (bps) above the previous buy's decision price. */
  addStepBps: number;
  /** SOL per add. */
  addSol: number;
  /** Oldest age (slots since create) at which an add may still be decided. */
  addMaxAge: number;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 0,
  maxAge: 1800,
  stakeSol: 0.1,
  minBuySol: 0.01,
  minRealSol: 3,
  maxRealSol: 30,
  maxDevBuySol: 2.5,
  minBuyers: 2,
  minRunupBps: 0,
  maxRunupBps: 15000,
  flowWindow: 20,
  minFlowSol: 0,
  buySlippageBps: 10000,
  tpBps: 2000,
  slBps: 1000,
  trailArmBps: 1000,
  trailBps: 800,
  maxHold: 1800,
  exitOnDevSell: true,
  staleSlots: 1200,
  maxExposureSol: 0.5,
  dipBps: 1000,
  maxAdds: 0,
  addStepBps: 2000,
  addSol: 0.02,
  addMaxAge: 1800,
};

const LAMPORTS = 1e9;
const FEE_BPS = 125n; // protocol 95 + creator 30 bps, the curve fee on every trade.

/** What selling `tokens` against (vq, vt) would pay after curve fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

interface Tick {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  user: Pubkey;
}

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  vq0: bigint;
  vt0: bigint;
  devBuy: bigint;
  buyers: Set<Pubkey>;
  bought: bigint;
  devSold: boolean;
  lastTradeSlot: number;
  recent: Tick[];
  /** Highest price (vq/vt as a pair) seen since creation. */
  highVq: bigint;
  highVt: bigint;
  /** Never buy it again (exited, filtered out for good, or completed). */
  done: boolean;
  complete: boolean;
}

interface Held {
  openedSlot: number;
  txPaid: bigint;
  best: bigint;
  /** SOL sent in buys for this position (fees included). */
  invested: bigint;
  /** Decision price (vq/vt as a pair) of the last buy sent. */
  lastAddVq: bigint;
  lastAddVt: bigint;
  adds: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS) {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Mints with a sell in flight. */
  const selling = new Set<Pubkey>();
  const stake = BigInt(Math.floor(p.stakeSol * LAMPORTS));
  const minBuy = BigInt(Math.floor(p.minBuySol * LAMPORTS));

  const readEvents = (batch: Batch): void => {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        coins.set(e.mint, {
          mint: e.mint,
          createSlot: e.slot,
          creator: e.creator,
          vq0: BigInt(e.virtual_quote_reserves),
          vt0: BigInt(e.virtual_token_reserves),
          devBuy: 0n,
          buyers: new Set(),
          bought: 0n,
          devSold: false,
          lastTradeSlot: e.slot,
          recent: [],
          highVq: BigInt(e.virtual_quote_reserves),
          highVt: BigInt(e.virtual_token_reserves),
          done: false,
          complete: false,
        });
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c === undefined) continue;
        const sol = BigInt(e.sol_amount);
        c.lastTradeSlot = e.slot;
        // Track the post-creation high price.
        const vq = BigInt(e.virtual_quote_reserves);
        const vt = BigInt(e.virtual_token_reserves);
        if (vt > 0n && c.highVt > 0n && vq * c.highVt > c.highVq * vt) {
          c.highVq = vq;
          c.highVt = vt;
        }
        c.recent.push({ slot: e.slot, isBuy: e.is_buy, sol, user: e.user });
        const isDev = e.user === c.creator;
        if (e.is_buy) {
          c.bought += sol;
          if (isDev && e.slot === c.createSlot) c.devBuy += sol;
          else if (!isDev) c.buyers.add(e.user);
        } else if (isDev) {
          c.devSold = true;
        }
      } else {
        const c = coins.get(e.mint);
        if (c !== undefined) {
          c.complete = true;
          c.done = true;
        }
      }
    }
  };

  /** Net lamports bought minus sold over the last flowWindow slots. */
  const flow = (c: Coin, slot: number): bigint => {
    const from = slot - p.flowWindow;
    let drop = 0;
    while (drop < c.recent.length && c.recent[drop]!.slot <= from) drop++;
    if (drop > 0) c.recent.splice(0, drop);
    let net = 0n;
    for (const t of c.recent) net += t.isBuy ? t.sol : -t.sol;
    return net;
  };

  const hasPending = (state: BotState, mint: Pubkey, side: 'buy' | 'sell'): boolean => {
    for (const po of state.pending.values()) {
      if (po.order.mint === mint && po.order.side === side) return true;
    }
    return false;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      readEvents(batch);
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) {
        marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });
      }

      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          held.delete(f.mint);
          selling.delete(f.mint);
          continue;
        }
        const h = held.get(f.mint);
        if (f.status !== 'rejected' && h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
        if (f.side === 'buy' && f.status === 'filled' && h === undefined) {
          const cv = state.curves.get(f.mint);
          held.set(f.mint, {
            openedSlot: f.slot,
            txPaid: BigInt(f.tx_fee_lamports),
            best: 0n,
            invested: state.positions.get(f.mint)?.cost_lamports ?? 0n,
            lastAddVq: cv?.virtual_quote_reserves ?? 0n,
            lastAddVt: cv?.virtual_token_reserves ?? 1n,
            adds: 0,
          });
        }
      }
      for (const mint of [...selling]) if (!hasPending(state, mint, 'sell')) selling.delete(mint);
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint) && !hasPending(state, mint, 'buy')) held.delete(mint);
      }

      // Exits first.
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        const c = coins.get(mint);
        let h = held.get(mint);
        if (h === undefined) {
          h = { openedSlot: state.slot, txPaid: tx, best: 0n, invested: 0n, lastAddVq: 0n, lastAddVt: 1n, adds: 0 };
          held.set(mint, h);
        }
        let mk = marks.get(mint);
        if (mk === undefined) {
          const cv = state.curves.get(mint);
          if (cv === undefined) continue;
          mk = { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
        }
        const value = sellValue(pos.token_amount, mk.vq, mk.vt) - tx;
        const basis = pos.cost_lamports + h.txPaid;
        if (value > h.best) h.best = value;
        let exit = false;
        if (basis > 0n) {
          if (value * BPS >= basis * (BPS + BigInt(p.tpBps))) exit = true;
          if (value * BPS <= basis * (BPS - BigInt(p.slBps))) exit = true;
          if (h.best * BPS >= basis * (BPS + BigInt(p.trailArmBps)) && value * BPS <= h.best * (BPS - BigInt(p.trailBps))) exit = true;
        }
        if (state.slot - h.openedSlot >= p.maxHold) exit = true;
        if (c !== undefined) {
          if (p.exitOnDevSell && c.devSold) exit = true;
          if (state.slot - c.lastTradeSlot >= p.staleSlots) exit = true;
        }
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10000 });
        selling.add(mint);
        if (c !== undefined) c.done = true;
      }

      // Entries and adds.
      let free = state.freeCashLamports() - tx * BigInt(orders.length);
      let exposure = 0n;
      for (const pos of state.positions.values()) exposure += pos.cost_lamports;
      // Adds into strength first: a position whose price stepped up gets more size.
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint) || hasPending(state, mint, 'buy') || hasPending(state, mint, 'sell')) continue;
        const h = held.get(mint);
        const c = coins.get(mint);
        const curve = state.curves.get(mint);
        if (h === undefined || c === undefined || curve === undefined || curve.complete) continue;
        if (p.maxAdds <= 0 || h.adds >= p.maxAdds) continue;
        if (state.slot - c.createSlot > p.addMaxAge) continue;
        const vq = curve.virtual_quote_reserves;
        const vt = curve.virtual_token_reserves;
        if (vt <= 0n || h.lastAddVt <= 0n) continue;
        // Price now at least addStepBps above the last buy's decision price.
        if (vq * h.lastAddVt * BPS < h.lastAddVq * vt * (BPS + BigInt(p.addStepBps))) continue;
        const maxBuy = state.maxBuyLamports(mint);
        let amount = BigInt(Math.floor(p.addSol * LAMPORTS));
        if (amount > maxBuy) amount = maxBuy;
        const invested = h.invested > pos.cost_lamports ? h.invested : pos.cost_lamports;
        const room = stake - invested;
        if (amount > room) amount = room;
        const expRoom = BigInt(Math.floor(p.maxExposureSol * LAMPORTS)) - exposure;
        if (amount > expRoom) amount = expRoom;
        if (amount < minBuy) continue;
        if (free < amount + tx) continue;
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
        free -= amount + tx;
        exposure += amount;
        h.invested += amount;
        h.adds += 1;
        h.lastAddVq = vq;
        h.lastAddVt = vt;
      }
      for (const c of coins.values()) {
        if (orders.length >= cap) break;
        if (c.done || c.complete) continue;
        const age = state.slot - c.createSlot;
        if (age > p.maxAge) {
          c.done = true;
          continue;
        }
        if (age < p.minAge) continue;
        if (state.committedPositionCount() >= state.hello.caps.max_open_positions) break;
        if (hasPending(state, c.mint, 'buy') || state.positions.has(c.mint)) continue;
        if (c.devSold) {
          c.done = true;
          continue;
        }
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) continue;
        const rq = curve.real_quote_reserves;
        if (rq < BigInt(Math.floor(p.minRealSol * LAMPORTS)) || rq > BigInt(Math.floor(p.maxRealSol * LAMPORTS))) continue;
        if (c.devBuy > BigInt(Math.floor(p.maxDevBuySol * LAMPORTS))) continue;
        if (c.buyers.size < p.minBuyers) continue;
        const vq = curve.virtual_quote_reserves;
        const vt = curve.virtual_token_reserves;
        if (vt <= 0n || c.vt0 <= 0n) continue;
        const runup = (vq * c.vt0 * BPS) / (vt * c.vq0);
        if (runup > BigInt(p.maxRunupBps) || runup < BigInt(p.minRunupBps)) continue;
        if (p.dipBps > 0) {
          // Price must have pulled back at least dipBps from its post-creation high.
          if (c.highVt <= 0n || vq * c.highVt * BPS >= c.highVq * vt * (BPS - BigInt(p.dipBps))) continue;
        }
        if (flow(c, state.slot) < BigInt(Math.floor(p.minFlowSol * LAMPORTS))) continue;
        const maxBuy = state.maxBuyLamports(c.mint);
        let amount = stake < maxBuy ? stake : maxBuy;
        const room = BigInt(Math.floor(p.maxExposureSol * LAMPORTS)) - exposure;
        if (amount > room) amount = room;
        if (amount < minBuy) continue;
        if (free < amount + tx) continue;
        orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
        free -= amount + tx;
        exposure += amount;
      }
      return orders;
    },
  };
}
