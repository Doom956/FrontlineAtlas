// The art lab (art lab builds only, VITE_ART_LAB=1, opened at #artlab): the owner compares the three art styles live
// and picks one style and one motion preset per category for the game. Three columns (refined pixel, detailed pixel,
// realistic), one row per category, every cell a live scene drawn by the real style module (artlab/scenes.ts).
//
// Controls: per category, the style and the motion the GAME should use (mix and match; remembered in this browser);
// a "Pick" button under every cell; one motion switch for every cell at once and a motion switch per row (to compare
// how each style moves); near and mid zoom; pause; "Copy my picks" (a line the game build reads back with
// VITE_ART_STYLE) and "Try my picks in the game" (this build only: the game starts with the picks).
//
// No module-level side effects: a normal build drops this file (artlab/gate.ts only calls it when __ART_LAB__).
import { loadFonts } from '../fonts';
import { applyPicks, ART_CATEGORIES, OWNER_PICKS, ART_STYLES, CATEGORY_LABEL, currentMotionPicks, currentStylePicks, MOTION_LABEL, MOTION_PRESETS, motionCategoryOf, parseMotionPicks, parseStylePicks, picksLine, setArtStyle, artStyleOf, STYLE_LABEL, type ArtCategory, type ArtStyle, type MotionCategory, type MotionPicks, type MotionPreset, type StylePicks } from '../art/artStyle';
import { motionOf, styleModule } from '../art/registry';
import { refined } from '../art/refined';
import type { TrailLayer } from '../art/types';
import { spriteScale } from '../render/units';
import { LAB_CSS } from './labCss';
import { CLOSE_ZOOM, MID_ZOOM, NEAR_ZOOM, rowSpecs, type RowId, type RowSpec, type SceneEnv } from './scenes';

const PICKS_KEY = 'frontline.artLab.picks.v1';
const PLAY_KEY = 'frontline.artLab.play.v1';

interface Cell {
  row: RowSpec;
  style: ArtStyle;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D | null;
  trails: Map<string, TrailLayer>;
  visible: boolean;
  w: number;
  h: number;
  pickBtn: HTMLButtonElement;
  fig: HTMLElement;
}

type Zoom = 'close' | 'near' | 'mid';
const ZOOMS: Record<Zoom, number> = { close: CLOSE_ZOOM, near: NEAR_ZOOM, mid: MID_ZOOM };
/** The picks panel, read row by row in two columns: units on the left, effects on the right. */
const PICK_ORDER: ArtCategory[] = ['ships', 'missiles', 'wakes', 'troopIcons', 'land', 'explosions', 'air', 'craters', 'contrails', 'cannonFire', 'paradrop'];

interface LabState {
  styles: StylePicks;
  motions: MotionPicks;
  rowMotion: Record<RowId, MotionPreset>;
  allMotion: MotionPreset;
  zoom: Zoom;
  paused: boolean;
  clock: number;
  last: number;
}

function readJson<T>(key: string): T | null {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
}
function writeJson(key: string, v: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* storage blocked: the picks still work on this page */
  }
}

/**
 * In an art lab build, outside the lab: when the owner pressed "Try my picks in the game", the game starts with those
 * picks (remembered in this browser until the lab is opened again).
 */
export function applyStoredPicks(): void {
  const p = readJson<{ line: string }>(PLAY_KEY);
  if (!p || typeof p.line !== 'string') return;
  applyPicks(parseStylePicks(p.line, currentStylePicks()), parseMotionPicks(p.line, currentMotionPicks()));
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** A row of mutually exclusive buttons (aria-pressed), calling `on` with the chosen value. */
function segmented<T extends string>(label: string, values: readonly T[], names: Record<T, string>, current: T, on: (v: T) => void, small = false): { el: HTMLElement; set: (v: T) => void } {
  const el = h('div', small ? 'al-seg al-seg-sm' : 'al-seg');
  el.setAttribute('role', 'group');
  el.setAttribute('aria-label', label);
  const btns = new Map<T, HTMLButtonElement>();
  const set = (v: T): void => {
    for (const [k, b] of btns) b.setAttribute('aria-pressed', String(k === v));
  };
  for (const v of values) {
    const b = h('button', undefined, names[v]);
    b.type = 'button';
    b.addEventListener('click', () => {
      set(v);
      on(v);
    });
    btns.set(v, b);
    el.append(b);
  }
  set(current);
  return { el, set };
}

/** True while a style module still delegates a category to the refined style (a stub not written yet). */
function delegates(style: ArtStyle, cat: ArtCategory): boolean {
  return style !== 'refined' && styleModule(style)[cat] === refined[cat];
}

export function startArtLab(): void {
  void loadFonts();
  // the lab is open again: the game goes back to the build's own art (until "Try my picks in the game")
  try {
    localStorage.removeItem(PLAY_KEY);
  } catch {
    /* storage blocked */
  }
  document.title = 'Art lab - Frontline Atlas';
  document.documentElement.classList.add('artlab');
  const css = h('style');
  css.textContent = LAB_CSS;
  document.head.append(css);
  const app = document.getElementById('app') ?? document.body;
  app.replaceChildren();

  const rows = rowSpecs();
  const saved = readJson<{ line: string }>(PICKS_KEY);
  const st: LabState = {
    styles: saved ? parseStylePicks(saved.line, currentStylePicks()) : currentStylePicks(),
    motions: saved ? parseMotionPicks(saved.line, currentMotionPicks()) : currentMotionPicks(),
    rowMotion: Object.fromEntries(rows.map((r) => [r.id, 'lively'])) as Record<RowId, MotionPreset>,
    allMotion: 'lively',
    zoom: 'near',
    paused: false,
    clock: 0,
    last: performance.now(),
  };

  const root = h('main', 'al');
  // ---------------------------------------------------------------------------------------------- header
  const head = h('header', 'al-head');
  const top = h('div', 'al-top');
  const titleBox = h('div', 'al-title');
  titleBox.append(h('h1', undefined, 'Art lab'), h('p', undefined, 'Three art styles side by side, drawn live by the real style code. Pick a style and a motion for each part of the game, then copy your picks.'));
  top.append(titleBox);

  // view controls
  const view = h('div', 'al-view');
  const motionAll = segmented('Motion of every cell', MOTION_PRESETS, MOTION_LABEL, st.allMotion, (v) => {
    st.allMotion = v;
    for (const r of rows) {
      st.rowMotion[r.id] = v;
      rowMotionSet.get(r.id)?.(v);
    }
  });
  const zoomSeg = segmented('Zoom', ['close', 'near', 'mid'] as const, { close: 'Close', near: 'Near', mid: 'Mid' }, st.zoom, (v) => {
    st.zoom = v;
    layout();
  });
  const pause = h('button', 'al-btn', 'Pause');
  pause.type = 'button';
  pause.setAttribute('aria-pressed', 'false');
  pause.addEventListener('click', () => {
    st.paused = !st.paused;
    pause.textContent = st.paused ? 'Play' : 'Pause';
    pause.setAttribute('aria-pressed', String(st.paused));
  });
  const back = h('button', 'al-btn al-quiet', 'Back to the game');
  back.type = 'button';
  back.addEventListener('click', () => {
    location.hash = '';
    location.reload();
  });
  view.append(field('Motion in every cell', motionAll.el), field('Zoom', zoomSeg.el), field('Animation', pause), back);
  top.append(view);
  head.append(top);

  // the picks for the game
  const picks = h('section', 'al-picks');
  picks.setAttribute('aria-label', 'Your picks for the game');
  picks.append(h('h2', undefined, 'Your picks for the game'));
  const grid = h('div', 'al-pick-grid');
  const styleSet = new Map<ArtCategory, (v: ArtStyle) => void>();
  const motionSet = new Map<MotionCategory, (v: MotionPreset) => void>();
  for (const cat of PICK_ORDER) {
    const name = h('div', 'al-pick-name', CATEGORY_LABEL[cat]);
    const s = segmented(`${CATEGORY_LABEL[cat]} style`, ART_STYLES, { refined: 'Refined', detailed: 'Detailed', realistic: 'Realistic' }, st.styles[cat], (v) => setPick(cat, v), true);
    styleSet.set(cat, s.set);
    const mc = motionCategoryOf(cat);
    let mEl: HTMLElement;
    if (mc && mc === cat) {
      const m = segmented(`${CATEGORY_LABEL[cat]} motion`, MOTION_PRESETS, MOTION_LABEL, st.motions[mc], (v) => {
        st.motions[mc] = v;
        changed();
      }, true);
      motionSet.set(mc, m.set);
      mEl = m.el;
    } else mEl = h('div', 'al-pick-note', mc ? `Moves with the ${mc === 'ships' ? 'ships' : 'planes'}` : 'Does not move');
    grid.append(name, s.el, mEl);
  }
  picks.append(grid);
  const out = h('div', 'al-out');
  const line = h('textarea', 'al-line');
  line.readOnly = true;
  line.rows = 2;
  line.setAttribute('aria-label', 'Your picks as one line');
  const copy = h('button', 'al-btn al-primary', 'Copy my picks');
  copy.type = 'button';
  const status = h('span', 'al-status');
  status.setAttribute('role', 'status');
  copy.addEventListener('click', () => {
    const text = line.value;
    const fallback = (): void => {
      line.focus();
      line.select();
      status.textContent = 'Copying is blocked here: the line is selected, press copy on your keyboard or menu.';
    };
    try {
      if (!navigator.clipboard?.writeText) throw new Error('no clipboard');
      navigator.clipboard.writeText(text).then(
        () => (status.textContent = 'Copied. Paste the line in your message.'),
        fallback,
      );
    } catch {
      fallback();
    }
  });
  const play = h('button', 'al-btn', 'Try my picks in the game');
  play.type = 'button';
  play.addEventListener('click', () => {
    writeJson(PLAY_KEY, { line: line.value });
    location.hash = '';
    location.reload();
  });
  const reset = h('button', 'al-btn al-quiet', 'Back to the game picks');
  reset.type = 'button';
  reset.addEventListener('click', () => {
    for (const c of ART_CATEGORIES) st.styles[c] = OWNER_PICKS[c];
    for (const c of Object.keys(st.motions) as MotionCategory[]) st.motions[c] = 'lively';
    for (const [c, f] of styleSet) f(st.styles[c]);
    for (const [c, f] of motionSet) f(st.motions[c]);
    changed();
  });
  const actions = h('div', 'al-actions');
  actions.append(copy, play, reset, status);
  out.append(line, actions);
  picks.append(out);
  head.append(picks);
  root.append(head);

  // ---------------------------------------------------------------------------------------------- columns
  const colHead = h('div', 'al-cols');
  colHead.append(h('div', 'al-col-gap'));
  for (const s of ART_STYLES) {
    const c = h('div', 'al-col');
    c.append(h('strong', undefined, STYLE_LABEL[s]));
    c.append(h('span', undefined, s === 'refined' ? 'The current pixel art, to be improved' : s === 'detailed' ? 'Finer pixel art, muted military colours' : 'Painted top-down, like models seen from above'));
    colHead.append(c);
  }
  root.append(colHead);

  const cells: Cell[] = [];
  const rowMotionSet = new Map<RowId, (v: MotionPreset) => void>();
  for (const row of rows) {
    const sec = h('section', 'al-row');
    sec.setAttribute('aria-labelledby', `al-row-${row.id}`);
    const rh = h('div', 'al-row-head');
    const t = h('h2', undefined, row.title);
    t.id = `al-row-${row.id}`;
    rh.append(t, h('p', undefined, row.note));
    if (row.motion) {
      const m = segmented(`${row.title} motion`, MOTION_PRESETS, MOTION_LABEL, st.rowMotion[row.id], (v) => (st.rowMotion[row.id] = v), true);
      rowMotionSet.set(row.id, m.set);
      rh.append(field('Motion', m.el, true));
    } else rh.append(h('p', 'al-pick-note', 'Troop icons do not move.'));
    sec.append(rh);
    for (const style of ART_STYLES) {
      const fig = h('figure', 'al-cell');
      const canvas = h('canvas');
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', `${row.title}, ${STYLE_LABEL[style]}`);
      const cap = h('figcaption');
      const name = h('span', 'al-cap-name', STYLE_LABEL[style]);
      cap.append(name);
      const stub = [row.pick, ...row.also].some((c) => delegates(style, c));
      if (stub) cap.append(h('span', 'al-stub', 'Not drawn yet: shows the refined art'));
      const pickBtn = h('button', 'al-btn al-pick', 'Pick');
      pickBtn.type = 'button';
      pickBtn.addEventListener('click', () => setPick(row.pick, style));
      cap.append(pickBtn);
      fig.append(canvas, cap);
      sec.append(fig);
      let ctx: CanvasRenderingContext2D | null = null;
      try {
        ctx = canvas.getContext('2d');
      } catch {
        ctx = null;
      }
      cells.push({ row, style, canvas, ctx, trails: new Map(), visible: true, w: 0, h: 0, pickBtn, fig });
    }
    root.append(sec);
  }
  app.append(root);

  function field(text: string, control: HTMLElement, small = false): HTMLElement {
    const f = h('div', small ? 'al-field al-field-sm' : 'al-field');
    f.append(h('span', 'al-field-label', text), control);
    return f;
  }

  function setPick(cat: ArtCategory, s: ArtStyle): void {
    st.styles[cat] = s;
    styleSet.get(cat)?.(s);
    changed();
  }

  function changed(): void {
    line.value = picksLine(st.styles, st.motions);
    writeJson(PICKS_KEY, { line: line.value });
    for (const c of cells) {
      const on = st.styles[c.row.pick] === c.style;
      c.fig.classList.toggle('al-picked', on);
      c.pickBtn.textContent = on ? 'Picked' : `Pick for ${CATEGORY_LABEL[c.row.pick].toLowerCase()}`;
      c.pickBtn.setAttribute('aria-pressed', String(on));
    }
    status.textContent = '';
  }
  changed();

  // ---------------------------------------------------------------------------------------------- drawing
  const zoomNow = (): number => ZOOMS[st.zoom];
  function layout(): void {
    const dpr = Math.min(3, Math.max(1, Math.round(window.devicePixelRatio || 1)));
    for (const c of cells) {
      const w = Math.max(120, Math.floor(c.fig.clientWidth));
      const hh = c.row.height(zoomNow());
      c.w = w;
      c.h = hh;
      c.canvas.width = w * dpr;
      c.canvas.height = hh * dpr;
      c.canvas.style.width = `${w}px`;
      c.canvas.style.height = `${hh}px`;
      for (const l of c.trails.values()) l.clear();
    }
  }
  layout();
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(layout, 120);
  });
  if (typeof IntersectionObserver === 'function') {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const c = cells.find((k) => k.canvas === e.target);
        if (c) c.visible = e.isIntersecting;
      }
    });
    for (const c of cells) io.observe(c.canvas);
  }

  function frame(now: number): void {
    const dt = Math.min(100, Math.max(0, now - st.last));
    st.last = now;
    if (!st.paused) st.clock += dt;
    const dpr = Math.min(3, Math.max(1, Math.round(window.devicePixelRatio || 1)));
    const zoom = zoomNow();
    for (const c of cells) {
      if (!c.visible || !c.ctx) continue;
      const ctx = c.ctx;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalAlpha = 1;
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, c.w, c.h);
      const env: SceneEnv = {
        ctx,
        w: c.w,
        h: c.h,
        style: styleModule(c.style),
        styleId: c.style,
        motion: motionOf(st.rowMotion[c.row.id]),
        time: st.clock,
        zoom,
        scale: spriteScale(zoom),
        dpr,
        trails: c.trails,
        pill: (draw) => {
          // the pills are shared and draw with the troop icon style of the game: this cell's style for a moment
          const prev = artStyleOf('troopIcons');
          setArtStyle('troopIcons', c.style);
          try {
            draw();
          } finally {
            setArtStyle('troopIcons', prev);
          }
        },
      };
      try {
        c.row.draw(env);
      } catch (err) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = '#f2543d';
        ctx.font = '600 12px "DM Sans", system-ui, sans-serif';
        ctx.fillText(`This scene failed: ${String((err as Error)?.message ?? err).slice(0, 80)}`, 10, 20);
      }
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // test hooks for screenshots (lab builds only)
  (window as unknown as { __artLab?: unknown }).__artLab = {
    setClock: (ms: number) => {
      st.clock = ms;
    },
    pause: (on: boolean) => {
      st.paused = on;
      pause.textContent = on ? 'Play' : 'Pause';
    },
    picksLine: () => line.value,
  };
}
