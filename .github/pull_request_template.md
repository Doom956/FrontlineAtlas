## What changes for the player

<!-- One or two sentences. Link the issue if there is one: Fixes #123 -->

## How I checked it

- [ ] `npx tsc -p .` and `npx tsc -p server`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] Played it in the browser
- [ ] Online e2e test (`node tests/e2e/mp.e2e.mjs`), if this touches actions, `src/net/` or `server/`

## Checklist

- [ ] `src/sim/` stays deterministic (no `Math.random`, `Date` or engine-dependent math; see [CONTRIBUTING.md](../blob/main/CONTRIBUTING.md))
- [ ] Balance numbers are in `src/sim/config.ts`
- [ ] In-game help (`src/client/howto.ts`) and docs updated if a rule changed
- [ ] Screenshots attached for UI changes
