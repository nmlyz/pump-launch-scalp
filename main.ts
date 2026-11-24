// Launch scalp bot for pump.fun bonding curves (agent-fun/replay/v2).
// Run by the grader as `node /bot/main.ts`. The strategy lives in strategy.ts;
// the protocol shim is vendored in vendor/makefun-bot.ts (a byte-identical copy
// of the kit's sdk/ts/makefun-bot.ts).

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot({ onBatch: createStrategy(DEFAULT_PARAMS).onBatch });
