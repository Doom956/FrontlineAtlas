// The art lab's styles (art lab builds only), as a string the lab puts in the page when it opens, so a normal build
// carries none of it. The game's cool steel tokens and DM Sans; quiet panels so the art is the star.
export const LAB_CSS = `
html.artlab, html.artlab body { height: auto; min-height: 100%; overflow: auto; background: #0a0e14; }
html.artlab #app { display: block; }
.al { --metal: #121821; --metal-2: #1c2531; --metal-3: #27313f; --metal-4: #313d4c; --rule: rgba(255,255,255,0.09);
  --text: #edeff3; --dim: #a0a8b5; --faint: #8f98a7; --accent: #f5b13d; --accent-ink: #1a1304; --sel-bg: #e6e9ef; --sel-ink: #15171c;
  font: 13px/1.45 'DM Sans', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; color: var(--text);
  max-width: 1480px; margin: 0 auto; padding: 24px 24px 64px; box-sizing: border-box; }
.al *, .al *::before, .al *::after { box-sizing: border-box; }
.al h1 { font-size: 22px; font-weight: 700; margin: 0 0 4px; }
.al h2 { font-size: 15px; font-weight: 600; margin: 0; }
.al p { margin: 0; color: var(--dim); }
.al-head { display: flex; flex-direction: column; gap: 16px; margin-bottom: 20px; }
.al-top { display: flex; flex-wrap: wrap; gap: 16px 32px; align-items: flex-end; justify-content: space-between; }
.al-title { display: flex; flex-direction: column; gap: 4px; max-width: 560px; }
.al-view { display: flex; flex-wrap: wrap; gap: 12px 20px; align-items: flex-end; }
.al-picks { background: var(--metal); border-radius: 12px; padding: 14px 16px 16px;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.05), 0 10px 30px rgba(0,0,0,0.38); }
.al-picks h2 { margin-bottom: 10px; }
.al-pick-grid > * { justify-self: start; }
.al-pick-grid { display: grid; grid-template-columns: max-content max-content minmax(0, 1fr) max-content max-content minmax(0, 1fr); gap: 6px 12px; align-items: center; }
.al-pick-name { color: var(--text); font-weight: 500; }
.al-pick-note { color: var(--faint); font-size: 12px; }
.al-field { display: flex; flex-direction: column; gap: 4px; }
.al-field-sm { flex-direction: row; align-items: center; gap: 8px; }
.al-field-label { color: var(--dim); font-size: 12px; }
.al-seg { display: inline-flex; background: var(--metal-2); border-radius: 8px; padding: 2px; gap: 2px; }
.al-seg button { font: inherit; font-weight: 500; color: var(--dim); background: transparent; border: 0; border-radius: 6px; padding: 5px 10px; cursor: pointer; }
.al-seg-sm button { font-size: 12px; padding: 3px 8px; }
.al-seg button:hover { background: var(--metal-3); color: var(--text); }
.al-seg button[aria-pressed='true'] { background: var(--sel-bg); color: var(--sel-ink); }
.al-btn { font: inherit; font-weight: 600; color: var(--text); background: var(--metal-2); border: 0; border-radius: 8px; padding: 7px 12px; cursor: pointer; }
.al-btn:hover { background: var(--metal-3); }
.al-btn:active { transform: scale(0.96); }
.al-btn[aria-pressed='true'] { background: var(--sel-bg); color: var(--sel-ink); }
.al-primary { background: var(--accent); color: var(--accent-ink); }
.al-primary:hover { background: #ffc658; }
.al-quiet { background: transparent; color: var(--dim); padding-left: 0; }
.al-quiet:hover { background: transparent; color: var(--text); text-decoration: underline; }
.al-seg button:focus-visible, .al-btn:focus-visible, .al-line:focus-visible { outline: 2px solid #93aef8; outline-offset: 2px; }
.al-out { margin-top: 12px; display: flex; flex-direction: column; gap: 8px; }
.al-line { width: 100%; resize: vertical; font: 12px/1.45 'DM Sans', system-ui, sans-serif; color: var(--text); background: var(--metal-2);
  border: 1px solid var(--rule); border-radius: 8px; padding: 8px 10px; }
.al-actions { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; }
.al-status { color: var(--dim); font-size: 12px; }
.al-cols { position: sticky; top: 0; z-index: 2; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px;
  background: rgba(10,14,20,0.92); backdrop-filter: blur(14px); padding: 10px 0; border-bottom: 1px solid var(--rule); }
.al-col-gap { display: none; }
.al-col { display: flex; flex-direction: column; }
.al-col strong { font-size: 15px; font-weight: 700; }
.al-col span { color: var(--faint); font-size: 12px; }
.al-row { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px 12px; padding: 18px 0 6px; border-bottom: 1px solid var(--rule); }
.al-row-head { grid-column: 1 / -1; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 16px; }
.al-row-head p { flex: 1 1 320px; }
.al-cell { margin: 0; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.al-cell canvas { display: block; width: 100%; border-radius: 8px; background: #172634; outline: 2px solid transparent; outline-offset: 2px; }
.al-cell.al-picked canvas { outline-color: var(--accent); }
.al-cell figcaption { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; }
.al-cap-name { font-weight: 600; }
.al-stub { color: var(--faint); font-size: 12px; }
.al-pick { margin-left: auto; padding: 4px 10px; font-size: 12px; }
.al-pick[aria-pressed='true'] { background: var(--accent); color: var(--accent-ink); }
@media (max-width: 1240px) {
  .al-pick-grid { grid-template-columns: max-content max-content minmax(0, 1fr); }
}
@media (max-width: 900px) {
  .al { padding: 16px 16px 48px; }
  .al-cols { display: none; }
  .al-row { grid-template-columns: minmax(0, 1fr); }
  .al-pick-grid { grid-template-columns: max-content minmax(0, 1fr); }
  .al-pick-grid > .al-seg:nth-child(3n), .al-pick-grid > .al-pick-note { grid-column: 2; }
}
@media (prefers-reduced-motion: reduce) { .al-btn:active { transform: none; } }
`;
