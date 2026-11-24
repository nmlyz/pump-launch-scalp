# Pump Launch Scalp

[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/nmlyz/pump-launch-scalp/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/nmlyz/pump-launch-scalp/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A trading bot for pump.fun-style Solana bonding curves. It watches every new
curve on the replay feed and buys the pullback: a coin that already ran up, still
holds real liquidity, and has dipped at least 10% from its post-launch high.

## How it works

- **Entry.** A coin qualifies when it is under 1800 slots old, its price ran up to
  at most 1.5x its create price, it holds 3–30 SOL of real reserves, at least two
  distinct wallets other than the creator have bought it, the creator has not sold,
  and the price has pulled back at least 10% from its high since creation. One
  fixed 0.1 SOL stake per coin, at most 5 open positions.
- **Exit.** The whole position is sold at +20% of cost, cut at −10%, trailed 8%
  once up 10%, or closed after 1800 slots, when the creator sells, or when the
  coin goes quiet for 1200 slots. Positions in curves that complete are closed by
  the replay itself.
- **Determinism.** The bot is a pure function of the batches it is fed: no clock,
  no randomness, no I/O, so two runs produce identical action logs.

## Layout

- `main.ts` — entrypoint, run as `node /bot/main.ts`
- `strategy.ts` — the strategy (parameters at the top in `DEFAULT_PARAMS`)
- `vendor/makefun-bot.ts` — the replay-protocol shim (no dependencies)

## Local backtest

The numbers in `STRATEGY.md` were measured with the kit's local engine port on
the frozen dev window (all three dataset parts, 24h of chain data).

---

<sub>See the bot on [make.fun](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)</sub>
