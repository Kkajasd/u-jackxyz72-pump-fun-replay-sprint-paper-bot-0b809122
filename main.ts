// Pump.fun Replay Sprint — Paper Bot, Real Ranking.
// Entry point: the grader runs `node /bot/main.ts` with this directory mounted
// at /bot. The strategy lives in strategy.ts; the SDK shim is vendored
// byte-for-byte from the kit's sdk/ts/makefun-bot.ts.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
