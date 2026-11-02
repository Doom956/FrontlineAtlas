# Contributing to Frontline Atlas

Thanks for helping. Bug reports, balance notes and pull requests are all welcome.

## Run it

You need Node.js 22 or newer.

```sh
npm install
npm run dev      # game plus the multiplayer server; open the printed URL
```

## Check your change

Run all four before you open a pull request. They must pass.

```sh
npx tsc -p .         # client and simulation types
npx tsc -p server    # server types
npm test             # unit tests (Vitest)
npm run build        # client and server build
```

Online play has browser end-to-end tests (Playwright). Run them when you touch `src/net/`, `server/` or anything that sends actions:

```sh
npm run build && node tests/e2e/mp.e2e.mjs
```

A few long tests can time out on a busy machine. Run them again on their own before you dig in.

## Keep the simulation deterministic

Online games run in lockstep: every browser computes the same game from the same orders. Code in `src/sim/` must give bit-identical results everywhere.

- No DOM, no `Date`, no `Math.random`. Use `state.rng()`.
- No `Math.sin`, `cos`, `tan`, `exp`, `log`, `pow`, `atan2`, `cbrt` or `hypot`, and no `**` with a non-integer exponent. Use `fmath.ts` (`expDet`, `logDet`, `powDet`, `powInt`). `+ - * /`, `Math.sqrt` and `floor`, `round`, `ceil`, `abs`, `min`, `max` are fine.
- No module-level caches shared between games. Keep derived data in a `WeakMap` keyed by the `GameState`.
- State changes only through `tick(state)` and `applyAction(state, playerId, action)`. The AI uses the same actions as a player.
- New state that affects the game goes into `hashState` (`src/sim/hash.ts`), with a test that two games fed the same actions hash the same.
- Balance numbers live in `src/sim/config.ts`, not in the logic.

The full rules are in [docs/DESIGN.md](docs/DESIGN.md).

## Pull requests

- Keep each pull request to one change. Small ones get reviewed faster.
- Say what changed for the player, and how you checked it.
- For a UI change, add a before and after screenshot.
- For a balance change, add numbers: a batch run (`scripts/batch.ts`) on the same seeds before and after.
- When a rule changes, update the in-game help (`src/client/howto.ts`) and the docs in the same pull request.
- Keep the HUD calm: plain, short words and simple icons.

## Report a bug

Open an issue with the bug form. Say where you played (Play now, Fast page or your own build), the map, and what you did just before it went wrong. A screenshot helps a lot.
