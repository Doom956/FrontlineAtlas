// Defense Mastery on the map (client only, read-only: sim/counter.ts makes the effects):
//   counterPush  the Counteroffensive: a wide brass arrow sweeps out from the Fort toward the attacker over
//                SWEEP_MS, its head leading, with dust clouds kicked up along its edges; then it fades over FADE_MS.
//   shelter      Hardened shelters took an atom blast: a pale blue dome ring flashes over the blast for DOME_MS.
// Seen by everyone whose view holds the start or the tip (fog of war); nothing when effects are off (Settings).
// Reduced motion: the arrow appears whole (no sweep) and no dust drifts. Client randomness only (dust jitter).
import { TICKS_PER_SECOND } from '../../sim/config';
import type { Effect, GameState } from '../../sim/types';
import type { Camera } from '../camera';
import type { FogView } from '../fog/fogView';
import { fxEnabled, prefersReducedMotion } from './settings';

export const SWEEP_MS = 1600;
export const FADE_MS = 2600;
const DOME_MS = 1400;
const CAP = 4;

interface Push {
  live: boolean;
  x: number;
  y: number;
  x2: number;
  y2: number;
  w: number;
  t0: number;
  seed: number;
}
interface Dome {
  live: boolean;
  x: number;
  y: number;
  r: number;
  t0: number;
}

export class CounterFx {
  fog: FogView | null = null;
  private pushes: Push[] = [];
  private domes: Dome[] = [];
  private seen = new WeakSet<Effect>();
  /** arrows drawn last frame (tests, stats) */
  drawn = 0;

  constructor(private rand: () => number = Math.random) {
    for (let i = 0; i < CAP; i++) {
      this.pushes.push({ live: false, x: 0, y: 0, x2: 0, y2: 0, w: 0, t0: 0, seed: 0 });
      this.domes.push({ live: false, x: 0, y: 0, r: 0, t0: 0 });
    }
  }

  /** Picks up new 'counterPush' and 'shelter' effects. Once per frame. */
  update(state: GameState, nowMs: number): void {
    if (!fxEnabled()) return;
    const w = state.map.width;
    const f = this.fog?.active ? this.fog : null;
    for (const e of state.effects) {
      if ((e.kind !== 'counterPush' && e.kind !== 'shelter') || this.seen.has(e)) continue;
      this.seen.add(e);
      if ((state.tick - e.tick) / TICKS_PER_SECOND > 1.5) continue;
      const x2 = e.x2 ?? e.x;
      const y2 = e.y2 ?? e.y;
      if (f && !f.visible(Math.floor(e.y) * w + Math.floor(e.x)) && !f.visible(Math.floor(y2) * w + Math.floor(x2))) continue;
      if (e.kind === 'shelter') {
        const d = this.domes.find((q) => !q.live) ?? this.domes.reduce((a, b) => (a.t0 < b.t0 ? a : b));
        Object.assign(d, { live: true, x: e.x, y: e.y, r: e.radius, t0: nowMs });
        continue;
      }
      const p = this.pushes.find((q) => !q.live) ?? this.pushes.reduce((a, b) => (a.t0 < b.t0 ? a : b));
      Object.assign(p, { live: true, x: e.x, y: e.y, x2, y2, w: e.radius, t0: nowMs, seed: Math.floor(this.rand() * 1e6) });
    }
  }

  /** The arrows (under the units) and the shelter domes. */
  draw(ctx: CanvasRenderingContext2D, cam: Camera, nowMs: number): void {
    this.drawn = 0;
    if (!fxEnabled()) return;
    const reduced = prefersReducedMotion();
    for (const p of this.pushes) {
      if (!p.live) continue;
      const age = nowMs - p.t0;
      if (age > SWEEP_MS + FADE_MS) {
        p.live = false;
        continue;
      }
      this.drawn++;
      const grow = reduced ? 1 : Math.min(1, age / SWEEP_MS);
      const ease = 1 - (1 - grow) * (1 - grow);
      const alpha = age < SWEEP_MS ? 1 : Math.max(0, 1 - (age - SWEEP_MS) / FADE_MS);
      drawArrow(ctx, cam, p, ease, alpha, reduced ? 0 : age, nowMs);
    }
    for (const d of this.domes) {
      if (!d.live) continue;
      const age = nowMs - d.t0;
      if (age > DOME_MS) {
        d.live = false;
        continue;
      }
      const t = age / DOME_MS;
      const c = cam.tileToScreen(d.x, d.y);
      const r = d.r * cam.zoom * (0.85 + 0.15 * t);
      ctx.save();
      ctx.globalAlpha = (1 - t) * 0.9;
      ctx.strokeStyle = '#9fd4ff';
      ctx.lineWidth = Math.max(2, cam.zoom * 0.5);
      ctx.setLineDash([8, 6]);
      ctx.beginPath();
      ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }
}

/** One wide arrow from (x, y) toward (x2, y2), drawn to `ease` of its length, with dust along its edges. */
function drawArrow(ctx: CanvasRenderingContext2D, cam: Camera, p: Push, ease: number, alpha: number, age: number, nowMs: number): void {
  const a = cam.tileToScreen(p.x, p.y);
  const b = cam.tileToScreen(p.x2, p.y2);
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 4) return;
  dx /= len;
  dy /= len;
  const nx = -dy;
  const ny = dx;
  const L = len * ease;
  const half = Math.max(14, p.w * cam.zoom * 0.5);
  const head = Math.min(L * 0.45, half * 2.2);
  const tipX = a.x + dx * L;
  const tipY = a.y + dy * L;
  const neckX = tipX - dx * head;
  const neckY = tipY - dy * head;
  ctx.save();
  ctx.globalAlpha = alpha;
  // body: a tapering band from the Fort, then the head
  const g = ctx.createLinearGradient(a.x, a.y, tipX, tipY);
  g.addColorStop(0, 'rgba(214,170,84,0.10)');
  g.addColorStop(0.6, 'rgba(226,184,96,0.55)');
  g.addColorStop(1, 'rgba(246,206,120,0.85)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(a.x + nx * half * 0.45, a.y + ny * half * 0.45);
  ctx.lineTo(neckX + nx * half, neckY + ny * half);
  ctx.lineTo(neckX + nx * half * 1.7, neckY + ny * half * 1.7);
  ctx.lineTo(tipX, tipY);
  ctx.lineTo(neckX - nx * half * 1.7, neckY - ny * half * 1.7);
  ctx.lineTo(neckX - nx * half, neckY - ny * half);
  ctx.lineTo(a.x - nx * half * 0.45, a.y - ny * half * 0.45);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(70,46,14,0.8)';
  ctx.lineWidth = 2;
  ctx.stroke();
  // dust: soft brown clouds along both edges, thicker near the head, drifting outward
  let s = p.seed;
  const rnd = (): number => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const n = 18;
  for (let k = 0; k < n; k++) {
    const t = rnd();
    if (t > ease) continue;
    const side = rnd() < 0.5 ? -1 : 1;
    const along = L * t;
    const drift = (age / 1000) * (6 + rnd() * 10);
    const off = half * (0.8 + 0.9 * t) + drift + rnd() * 6;
    const x = a.x + dx * along + nx * side * off;
    const y = a.y + dy * along + ny * side * off;
    const r = (4 + rnd() * 7) * (0.6 + t);
    const flick = 0.75 + 0.25 * Math.sin(nowMs / 180 + k);
    ctx.globalAlpha = alpha * 0.45 * flick;
    ctx.fillStyle = k % 3 === 0 ? 'rgb(150,120,82)' : 'rgb(124,98,66)';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}
