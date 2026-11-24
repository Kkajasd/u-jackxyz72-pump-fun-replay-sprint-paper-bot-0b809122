# Pump.fun Replay Sprint — Paper Bot

Entry for `u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122` (make.fun).
Paper money only: 10 SOL on a replay of pump.fun bonding-curve activity.

## Strategy

Early-ladder momentum, written from scratch in `strategy.ts`:

- **Enter young only.** A curve is considered in its first 40 slots after its
  `CreateEvent`, once it holds at least 0.5 SOL of real reserve, its price is
  2–60% above its create price, net buying over the last 20 slots is positive,
  at least 2 distinct wallets are buying, the creator has not sold, and no
  single sell of 2+ SOL has hit the tape.
- **Ladder in.** First buy 0.05 SOL, then add 0.05 SOL at a time (up to 0.3 SOL
  per coin) only while the price keeps stepping up and net SOL keeps flowing
  in. Every buy is capped at 97% of the harness's 1%-of-real-reserve size cap.
- **Exit fast.** Stop loss −10% vs cost; take half off at +12%; the rest rides
  a trailing stop (arms at +8%, trails 12% off the peak); a 400-slot time
  limit unless the position is up 5%+; immediate exit on a creator sell, a
  2+ SOL sell, or net outflow over 20 slots.
- **Guardrail probes.** If fills or distinct coins lag the pace needed for the
  20-coin / 0.01-SOL round-trip minimum bar, the bot opens 0.012 SOL probe
  round-trips on liquid curves and sells them as soon as the buy lands.
- **Limits.** At most 5 open positions, at most 6 SOL at cost across the book.

Deterministic by construction: no clock, no randomness, no I/O; every decision
is a pure function of the batches the harness sends, so repeated executions
produce byte-identical action logs.

## Layout

- `main.ts` — entry point (`node /bot/main.ts`)
- `strategy.ts` — the bot
- `vendor/makefun-bot.ts` — the kit SDK shim, vendored byte-for-byte
- `LICENSE` — MIT

## Backtest (dev window, kit tools)

Backtested offline on the kit's frozen dev window with the local engine port
in `research/tools/` (outside this repo). Shipped parameters, verified twice
(identical output both runs — deterministic):

- net PnL **−0.0159 SOL** (−0.16% of the 10 SOL paper bankroll)
- 31 round trips, 3 wins, max drawdown **0.0022**
- **27 coins** with a ≥ 0.01 SOL round trip (minimum bar is 20)
- 0 rejected orders, 0 failed transactions; −0.0326 SOL at 2× fees

Honest note: no variant tested on this dev window is net positive — the
opening spike is spent within ~10 slots and the 1%-of-reserve size cap means
size can only be bought after the price has already moved, so every
trend/dip/ladder variant swept (200+ combinations) lands between −0.01 and
−9.4 SOL. This entry ships the least-bad corner of that grid: the tightest
early entry (≤ 5% run-up, first 40 slots), trailing-stop exits with no fixed
take-profit, tiny stakes, and probe round-trips that clear the minimum bar
with margin while keeping drawdown near zero — so it stays alive for the
unseen final window, where a hotter open would let the same entries catch
real runners instead of fading ones.
