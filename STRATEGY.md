# Strategy

## What the data says

Measured on the kit's dev window (24h of pump.fun chain data, 1222 coins in the
universe, all three dataset parts):

- A coin's first spike is not tradable. The median coin's highest price within
  1800 slots of creation is +25% over its early price, but the spike lives for a
  single trade: the slot-end price mean-reverts within two slots, which is the
  replay's latency. Buying the launch and selling at a take-profit loses 5–13%
  per trade after fees in a latency-faithful replay.
- Buying the pullback is the only shape that comes close to breakeven. A coin
  that ran up, then dipped at least 10% from its post-creation high, and still
  holds real liquidity, recovers often enough to nearly cover the ~2.9% round-trip
  cost (1.25% curve fees each way plus transaction fees).
- Liquidity filters matter: requiring at least 3 SOL of real reserves at entry
  keeps the 1% size cap from shrinking buys below the 0.01 SOL round-trip bar
  and keeps the trade count high enough for the 20-coin guardrail in a 6h window.

## Parameters (strategy.ts, DEFAULT_PARAMS)

| Parameter | Value | Meaning |
|---|---|---|
| maxAge | 1800 slots | oldest a coin may be at entry |
| stakeSol | 0.1 | SOL per coin, one buy, no adds |
| minRealSol / maxRealSol | 3 / 30 | real SOL reserve band at entry |
| maxDevBuySol | 2.5 | creator's own launch buy, at most |
| minBuyers | 2 | distinct non-creator buyers before entry |
| maxRunupBps | 15000 | price at most 1.5x its create price |
| dipBps | 1000 | pulled back at least 10% from post-creation high |
| tpBps / slBps | 2000 / 1000 | sell at +20% of cost, cut at −10% |
| trailArmBps / trailBps | 1000 / 800 | trail 8% once up 10% |
| maxHold | 1800 slots | time exit |
| exitOnDevSell | true | leave when the creator sells |
| staleSlots | 1200 | leave when the coin goes quiet |

## Measured results (local engine port, full 24h dev window)

| Config | Net PnL | Coins | Trips | Max DD |
|---|---|---|---|---|
| This bot | −0.265 SOL | 141 | 141 | 3.4% |
| Kit pilot: sniper | −0.489 SOL | 354 | 354 | 5.3% |
| Kit pilot: reversion | −4.016 SOL | 198 | 424 | 48.9% |
| Kit pilot: momentum | −9.387 SOL | 48 | 80 | 95.0% |
| Hold cash | 0 SOL | 0 | 0 | 0% |

Per 8h slice of the dev window this bot scores −0.139 / −0.091 / +0.006 SOL with
49 / 53 / 35 guardrail-qualifying coins (round trips of at least 0.01 SOL), so the
20-coin bar holds with margin even in the slowest slice. Max drawdown stays far
under the 50% guardrail. Two runs of the same replay are byte-identical by
construction (no clock, no randomness, insertion-ordered iteration only).

## What was tried and dropped

- Buying launches within 3–120 slots of creation (sniper-style): −1.1 to −1.8 SOL.
  The entry price is already past the spike by the time the fill lands.
- Momentum entries on mature coins with pyramiding: −9.4 SOL (the kit pilot).
- Scaling into strength with adds on rising coins: −1.6 SOL; adds chase the top.
- No stop loss / very wide take-profit (100–200%): losers bleed longer than the
  rare runners pay.
- Requiring 5+ SOL of real reserves: better net (−0.165 SOL) but only 74 coins in
  24h, which would fall under the 20-coin bar in a slow 6h window — rejected for
  guardrail safety.
