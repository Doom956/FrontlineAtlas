# Frontline Atlas: working rules

Browser strategy game (grand-scale territory control). TypeScript, no framework. Sim in `src/sim`, client in
`src/client`, Node `ws` server in `server/`. Live: frontline-atlas.onrender.com (Render) and
doom956.github.io/FrontlineAtlas (Pages); both deploy from `main`.

## Owner rules (always)
- Commits authored by Doom956 only. Never add a Co-Authored-By line or any "Claude" line to commits, PRs or files.
- Never write the name of the other game the owner compares this one to (the word "open" joined to "front")
  anywhere. Check with `git grep -i "open""front"` (split so this file stays clean).
- No em dashes anywhere (code, docs, UI text, commits).
- No new hotkeys, and no hotkey chips in the visible UI.
- Everything must be obvious to a first-time player without hovering: icon plus a plain word on main controls,
  numbers carry units, disabled things say why, nothing reachable only by hover, hotkey, right-click or long-press.
- The owner console ("|" key) is the owner's. Keep it working. Never write the admin code anywhere.

## Code rules
- `src/sim` is deterministic lockstep code: no `Math.random`, `Date` or DOM, and no non-deterministic Math
  (see CONTRIBUTING.md). New game state goes into `hashState` in `src/sim/hash.ts`, with a test.
- Keep test selectors (data-test, aria-label, role) and labels tests rely on; grep `tests/` and `tests/e2e/` first.

## Branches and checks
- Work on `dev` (or a feature branch off it). Merge `dev` into `main` only after every check below is green.
- Checks: `npx tsc -p .`, `npx tsc -p server`, `npx vitest run --testTimeout 60000`, `npx vite build`, then the
  multiplayer e2e on GitHub: `scripts/remote-e2e.sh <label>` and read the "E2E RESULT" lines of the run.
- Heavy work (balance batches, e2e) runs on GitHub runners (`scripts/remote-batch.sh`, `scripts/remote-e2e.sh`).
  Screenshots (`scripts/ui/shots.mjs`) and vitest run locally, one at a time (shared 4-core machine).
- After shipping to `main`, republish the playable artifact: https://claude.ai/artifact/ED4sTmj3ppaPWa3wU2qNB7

## Docs
- Plans and status: `ROADMAP.md`. Game rules: `docs/DESIGN.md`. Multiplayer: `docs/MULTIPLAYER.md`.
- UI redesign: `docs/UI_REDESIGN_PLAN.md`.
