// The realistic style's planes and missiles (client only): painted top-down miniatures, each with its own planform:
//   bomber          twin engines on straight wings, a glazed nose, an H tail with twin fins (olive drab)
//   groundAttack    a stubby single-engine plane, a big engine cowl, rockets on rails under its wings showing ahead of
//                   the leading edge, a bubble canopy, disruptive green and brown camouflage
//   heavyBomber     four engines on long wings, a big single fin, natural metal with an olive anti-glare panel, a top
//                   turret (Strategic Bombing adds a chin turret and a dorsal one)
//   fighter         small and fast: elliptical wings, a long engine nose, a bubble canopy (jets: swept wings, a nose
//                   intake, no propeller)
//   transportPlane  a fat fuselage under a high wing (the wing passes over it), twin engines, cabin windows, the open
//                   jump door, black and white recognition stripes: it carries the paratroopers
//   reconPlane      twin booms with an engine each, a central pod with a long glazed nose, photo recon blue
//   rocket          a slender finned rocket; atomBomb a fat white one with black and yellow hazard bands
// Upgrades: Jet Engines swap the propellers for jet pods (or a nose intake), Night Bombing is matte black paint with
// flame dampers, Drop Tanks hang silver tanks under the wings, Air Mastery a checkered cowl or a yellow tail band,
// Strategic Bombing more gun turrets. The owner's colour is the roundels on the wings, never the whole plane.
import { M_JET, M_MASTERY, M_NIGHT, M_PATH3, M_SPECIAL, type SpriteKey } from '../shared/keys';
import { bounds, type Layer, type OwnerLayer, type Prop, type Tones, type UnitModel } from './model';
import { castShadow, type Col, css, cylGrad, darken, domeGrad, edge, fillShape, fine, grime, hair, hexCol, lighten, litGrad, oval, type Paint, rim, rod, type Shape, softShadow, strokeShape, turn } from './paint';

const OLIVE_DRAB = hexCol('#5d6142');
const CAMO_GREEN = hexCol('#56603d');
const CAMO_BROWN = hexCol('#6f5b3e');
const METAL = hexCol('#aeb3b6');
const FIGHTER = hexCol('#6b7766');
const PRU = hexCol('#62839a');
const NIGHT = hexCol('#26292d');
const GLASS = hexCol('#2a3a46');
const COWL = hexCol('#2b2e30');
const ROCKET_BODY = hexCol('#7e8673');
const ATOM_BODY = hexCol('#d9dbd4');

// ------------------------------------------------------------------------------------------------- shapes

/** A streamlined body along x, from the tail xt to the nose xn, widest (r) at xm; `nose` 0 sharp .. 1 blunt. */
function bodyShape(xt: number, xn: number, r: number, xm: number, nose = 0.55, tail = 0.16): Shape {
  return (c) => {
    c.moveTo(xn, 0);
    c.bezierCurveTo(xn, -r * nose, xm + (xn - xm) * 0.35, -r, xm, -r);
    c.bezierCurveTo(xm - (xm - xt) * 0.4, -r, xt + (xm - xt) * 0.12, -r * tail * 1.6, xt, -r * tail);
    c.lineTo(xt, r * tail);
    c.bezierCurveTo(xt + (xm - xt) * 0.12, r * tail * 1.6, xm - (xm - xt) * 0.4, r, xm, r);
    c.bezierCurveTo(xm + (xn - xm) * 0.35, r, xn, r * nose, xn, 0);
    c.closePath();
  };
}

/** Both wings as one shape: the leading edge at le0 at the root and le1 at the tips, chords c0 and c1, half span s. */
function wingsShape(le0: number, c0: number, le1: number, c1: number, s: number): Shape {
  return (c) => {
    c.moveTo(le0, 0);
    c.lineTo(le1, s - c1 * 0.35);
    c.quadraticCurveTo(le1 - c1 * 0.12, s, le1 - c1 * 0.5, s);
    c.quadraticCurveTo(le1 - c1 * 0.95, s, le1 - c1, s - c1 * 0.18);
    c.lineTo(le0 - c0, 0);
    c.lineTo(le1 - c1, -s + c1 * 0.18);
    c.quadraticCurveTo(le1 - c1 * 0.95, -s, le1 - c1 * 0.5, -s);
    c.quadraticCurveTo(le1 - c1 * 0.12, -s, le1, -s + c1 * 0.35);
    c.closePath();
  };
}

/** Elliptical wings (a fighter's): the leading edge curving back to a round tip. */
function ellipticShape(le0: number, c0: number, s: number): Shape {
  const te = le0 - c0;
  return (c) => {
    c.moveTo(le0, 0);
    c.bezierCurveTo(le0, s * 0.62, le0 - c0 * 0.15, s, le0 - c0 * 0.55, s);
    c.bezierCurveTo(te + c0 * 0.05, s, te, s * 0.65, te, 0);
    c.bezierCurveTo(te, -s * 0.65, te + c0 * 0.05, -s, le0 - c0 * 0.55, -s);
    c.bezierCurveTo(le0 - c0 * 0.15, -s, le0, -s * 0.62, le0, 0);
    c.closePath();
  };
}

/** Where a wing's mid chord is at span y (for roundels and nacelles). */
function chordAt(le0: number, c0: number, le1: number, c1: number, s: number, y: number): { le: number; c: number } {
  const q = Math.min(1, Math.abs(y) / s);
  return { le: le0 + (le1 - le0) * q, c: c0 + (c1 - c0) * q };
}

// ------------------------------------------------------------------------------------------------- brushes

function wingPaint(p: Paint, s: Shape, col: Col, le: number, te: number, span: number, seed: number): void {
  const c = p.ctx;
  castShadow(p, s, 0.5, 0.18);
  fillShape(c, s, litGrad(p, col, (le + te) / 2, 0, span * 0.7, 0.12));
  // the aerofoil: a soft light along the leading edge, a little shade toward the trailing edge
  const g = c.createLinearGradient(le, 0, te, 0);
  g.addColorStop(0, 'rgba(255,255,255,0.16)');
  g.addColorStop(0.3, 'rgba(255,255,255,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.14)');
  fillShape(c, s, g);
  grime(p, s, te, -span, le, span, seed, Math.round(span * 1.2), darken(col, 0.35), 0.14, 0.4);
  if (fine(p, 1.8)) {
    // the flap and aileron hinge line
    c.save();
    c.beginPath();
    s(c);
    c.clip();
    c.beginPath();
    c.moveTo(te + (le - te) * 0.3, -span);
    c.lineTo(te + (le - te) * 0.3, span);
    c.lineWidth = hair(p, 0.6);
    c.strokeStyle = css(darken(col, 0.45), 0.5);
    c.stroke();
    c.restore();
  }
  edge(p, s, col, 0.9);
  rim(p, s, col, 0.4);
}

function fuselagePaint(p: Paint, s: Shape, col: Col, xm: number, r: number, h = 1): void {
  castShadow(p, s, h, 0.22);
  fillShape(p.ctx, s, cylGrad(p, col, xm, 0, 1, 0, r, 0.34));
  edge(p, s, col, 0.9);
}

/** A canopy: glass with a bright reflection and a dark frame. */
function canopy(p: Paint, x0: number, x1: number, r: number, y = 0): void {
  const c = p.ctx;
  const s: Shape = (k) => {
    k.moveTo(x1, y);
    k.bezierCurveTo(x1, y - r * 0.9, x0 + (x1 - x0) * 0.3, y - r, x0, y - r * 0.5);
    k.lineTo(x0, y + r * 0.5);
    k.bezierCurveTo(x0 + (x1 - x0) * 0.3, y + r, x1, y + r * 0.9, x1, y);
    k.closePath();
  };
  fillShape(c, s, cylGrad(p, GLASS, (x0 + x1) / 2, y, 1, 0, r, 0.65));
  // a highlight streak toward the light
  const hx = (x0 + x1) / 2 + p.lx * r * 0.2;
  const hy = y + p.ly * r * 0.45;
  fillShape(c, oval(hx, hy, (x1 - x0) * 0.28, r * 0.16), 'rgba(220,236,246,0.55)');
  strokeShape(c, s, 'rgba(14,18,22,0.75)', hair(p, 0.8));
}

/** A glazed nose: the front of a body seen through glass, with its frame lines. */
function glazedNose(p: Paint, body: Shape, x0: number, xn: number, r: number): void {
  const c = p.ctx;
  c.save();
  c.beginPath();
  body(c);
  c.clip();
  fillShape(c, (k) => k.rect(x0, -r * 2, xn - x0 + 1, r * 4), cylGrad(p, GLASS, (x0 + xn) / 2, 0, 1, 0, r, 0.7));
  if (fine(p, 1.6)) {
    c.beginPath();
    for (let x = x0 + 0.5; x < xn; x += 0.6) {
      c.moveTo(x, -r);
      c.lineTo(x, r);
    }
    c.moveTo(x0, 0);
    c.lineTo(xn, 0);
    c.lineWidth = hair(p, 0.5);
    c.strokeStyle = 'rgba(30,34,30,0.6)';
    c.stroke();
  }
  fillShape(c, oval((x0 + xn) / 2 + p.lx * 0.3, p.ly * r * 0.4, (xn - x0) * 0.3, r * 0.22), 'rgba(220,236,246,0.5)');
  c.restore();
}

/** An engine nacelle at y on the wing, its cowl front at xn: propeller (or a jet intake when `jet`). */
function nacelle(p: Paint, xt: number, xn: number, y: number, r: number, col: Col, jet: boolean, night: boolean): void {
  turn(p, 0, y, 0, (q) => {
    const c = q.ctx;
    const s = bodyShape(xt, xn, r, xn - (xn - xt) * 0.3, jet ? 0.85 : 0.7, jet ? 0.55 : 0.2);
    fuselagePaint(q, s, col, xn - (xn - xt) * 0.3, r, 0.8);
    if (jet) {
      // the intake ring and the hot exhaust at the back
      fillShape(c, oval(xn - 0.15, 0, 0.3, r * 0.82), css(hexCol('#16191b')));
      fillShape(c, oval(xt + 0.1, 0, 0.25, r * 0.5), css(hexCol('#3a2c22')));
    } else {
      fillShape(c, oval(xn - 0.25, 0, 0.35, r * 0.92), cylGrad(q, COWL, xn - 0.25, 0, 1, 0, r, 0.4));
      fillShape(c, oval(xn + 0.12, 0, 0.32, 0.32), domeGrad(q, hexCol('#3a3d40'), xn + 0.12, 0, 0.32));
      // exhaust stains back along the nacelle (flame dampers at night)
      if (night) for (const sd of [-1, 1]) rod(q, xn - 1.1, sd * r * 0.75, xn - 2.6, sd * r * 0.8, 0.28, hexCol('#191a1c'));
      else grime(q, s, xt, -r, xn - 1, r, 913 + y, 6, hexCol('#22201c'), 0.25, 0.35);
    }
  });
}

/** A vertical fin seen from above: a narrow strip that casts a shadow on what is under it. */
function fin(p: Paint, x0: number, x1: number, y: number, w: number, h: number, col: Col, band?: Col): void {
  const s: Shape = (k) => {
    k.moveTo(x1, y);
    k.lineTo(x1 - (x1 - x0) * 0.35, y - w / 2);
    k.lineTo(x0, y - w / 2);
    k.lineTo(x0, y + w / 2);
    k.lineTo(x1 - (x1 - x0) * 0.35, y + w / 2);
    k.closePath();
  };
  castShadow(p, s, h, 0.36);
  fillShape(p.ctx, s, litGrad(p, lighten(col, 0.08), (x0 + x1) / 2, y, (x1 - x0) / 2, 0.25));
  if (band) fillShape(p.ctx, (k) => k.rect(x0 + (x1 - x0) * 0.25, y - w / 2, (x1 - x0) * 0.25, w), css(band));
  edge(p, s, col, 0.9);
}

/** A silver drop tank hanging under a wing: its nose shows ahead of the leading edge. */
function dropTank(p: Paint, x: number, y: number, l: number, r: number): void {
  const s = bodyShape(x - l, x + l, r, x + l * 0.2, 0.6, 0.3);
  fillShape(p.ctx, s, cylGrad(p, hexCol('#b9bdbf'), x, y, 1, 0, r, 0.4));
  edge(p, s, METAL);
}

/** A gun turret dome (bombers). */
function gunDome(p: Paint, x: number, y: number, r: number): void {
  castShadow(p, oval(x, y, r, r), 0.6, 0.3);
  fillShape(p.ctx, oval(x, y, r, r), domeGrad(p, GLASS, x, y, r, 0.6));
  rod(p, x, y - 0.18, x + r * 2.1, y - 0.18, 0.13, hexCol('#202224'), 0.3);
  rod(p, x, y + 0.18, x + r * 2.1, y + 0.18, 0.13, hexCol('#202224'), 0.3);
}

/** Disruptive camouflage blotches over a shape. */
function camo(p: Paint, s: Shape, x0: number, x1: number, y0: number, y1: number, seed: number, col: Col, n: number): void {
  const c = p.ctx;
  c.save();
  c.beginPath();
  s(c);
  c.clip();
  for (let i = 0; i < n; i++) {
    const x = x0 + (x1 - x0) * ((i * 0.618 + Math.sin(seed + i * 1.7) * 0.15 + 1) % 1);
    const y = y0 + (y1 - y0) * ((i * 0.382 + Math.cos(seed + i * 2.3) * 0.2 + 1) % 1);
    const rx = (x1 - x0) * (0.08 + 0.05 * ((i * 7) % 3));
    const ry = (y1 - y0) * (0.06 + 0.03 * ((i * 5) % 3));
    fillShape(c, oval(x, y, rx, ry, i * 0.9), css(col, 0.85));
  }
  c.restore();
}

/** A roundel: a white ring round the owner's colour, as painted on a wing. */
function roundel(p: Paint, x: number, y: number, r: number, t: Tones, white = true): void {
  const c = p.ctx;
  if (white) fillShape(c, oval(x, y, r, r), 'rgba(236,236,228,0.92)');
  const ir = white ? r * 0.74 : r;
  fillShape(c, oval(x, y, ir, ir), litGrad(p, t.base, x, y, ir, 0.2));
  strokeShape(c, oval(x, y, r, r), css(t.deep, 0.45), hair(p, 0.6));
}

// ------------------------------------------------------------------------------------------------- planes

interface PlanePlan {
  len: number;
  span: number;
  /** cruising height over the ground (art units): how far the shadow falls */
  alt: number;
  paint(p: Paint, mods: number): void;
  /** the silhouette for the ground shadow */
  silhouette(mods: number): Shape[];
  roundels(mods: number): readonly (readonly [number, number, number])[];
  props(mods: number): Prop[];
}

const merge = (...shapes: Shape[]): Shape[] => shapes;

// ---- bomber: twin engines, glazed nose, H tail
const BW = { le0: 2.8, c0: 4.6, le1: 1.6, c1: 2.2, s: 14 };
const bomberBody = bodyShape(-10, 10, 1.35, 1.5, 0.75, 0.25);
const bomberWings = wingsShape(BW.le0, BW.c0, BW.le1, BW.c1, BW.s);
const bomberTail = wingsShape(-7.4, 2.6, -7.9, 1.6, 4.9);

const bomber: PlanePlan = {
  len: 20,
  span: 28,
  alt: 9,
  paint(p, mods) {
    const night = !!(mods & M_NIGHT);
    const jet = !!(mods & M_JET);
    const col = night ? NIGHT : OLIVE_DRAB;
    if (mods & M_SPECIAL) for (const y of [-8.4, 8.4]) dropTank(p, 2.4, y, 2.1, 0.55);
    wingPaint(p, bomberTail, col, -7.4, -10, 4.9, 501);
    for (const y of [-4.9, 4.9]) fin(p, -10.2, -7.2, y, 0.55, 2.4, col, mods & M_MASTERY ? hexCol('#d8b23a') : undefined);
    wingPaint(p, bomberWings, col, BW.le0, BW.le0 - BW.c0, BW.s, 503);
    fuselagePaint(p, bomberBody, col, 1.5, 1.35);
    glazedNose(p, bomberBody, 8.2, 10, 1.35);
    canopy(p, 4.6, 6.6, 0.85);
    if (fine(p)) gunDome(p, -2.0, 0, 0.6);
    for (const y of [-4.6, 4.6]) nacelle(p, jet ? -3.5 : -2.6, jet ? 6.4 : 5.2, y, jet ? 0.9 : 1.05, col, jet, night);
  },
  silhouette: () => merge(bomberWings, bomberBody, bomberTail),
  roundels: () => [
    [BW.le0 - 2.3 - (BW.le0 - BW.le1) * 0.7, 9.6, 1.25],
    [BW.le0 - 2.3 - (BW.le0 - BW.le1) * 0.7, -9.6, 1.25],
  ],
  props: (mods) =>
    mods & M_JET
      ? []
      : [
          { x: 5.5, y: -4.6, r: 2.4 },
          { x: 5.5, y: 4.6, r: 2.4 },
        ],
};

// ---- ground attack: single engine, rockets under the wings, camouflage
const GW = { le0: 1.7, c0: 4.0, le1: 0.9, c1: 2.0, s: 10 };
const gaBody = bodyShape(-8, 8, 1.5, 3.4, 0.85, 0.22);
const gaWings = wingsShape(GW.le0, GW.c0, GW.le1, GW.c1, GW.s);
const gaTail = wingsShape(-5.8, 2.1, -6.3, 1.3, 3.7);

const groundAttack: PlanePlan = {
  len: 16,
  span: 20,
  alt: 5,
  paint(p, mods) {
    const night = !!(mods & M_NIGHT);
    const jet = !!(mods & M_JET);
    const col = night ? NIGHT : CAMO_GREEN;
    // rockets on their rails, mostly under the wing, their heads ahead of the leading edge
    for (const sd of [-1, 1])
      for (const y of [4.0, 5.2, 6.4, 7.6]) {
        const x = chordAt(GW.le0, GW.c0, GW.le1, GW.c1, GW.s, y).le;
        rod(p, x - 2.4, sd * y, x + 1.4, sd * y, 0.36, hexCol('#8a8c86'));
        fillShape(p.ctx, oval(x + 1.45, sd * y, 0.42, 0.2), css(hexCol('#8b3a26')));
      }
    if (mods & M_SPECIAL) for (const y of [-2.7, 2.7]) dropTank(p, 1.2, y, 1.7, 0.5);
    wingPaint(p, gaTail, col, -5.8, -7.9, 3.7, 511);
    wingPaint(p, gaWings, col, GW.le0, GW.le0 - GW.c0, GW.s, 513);
    if (!night) camo(p, gaWings, -3, 2, -10, 10, 3.1, CAMO_BROWN, 9);
    fuselagePaint(p, gaBody, col, 3.4, 1.5);
    if (!night) camo(p, gaBody, -8, 8, -1.5, 1.5, 5.3, CAMO_BROWN, 5);
    fin(p, -8.1, -5.6, 0, 0.42, 2.0, col);
    canopy(p, -0.6, 2.0, 0.85);
    if (jet) {
      fillShape(p.ctx, oval(7.8, 0, 0.35, 1.0), css(hexCol('#16191b')));
      fillShape(p.ctx, oval(-7.9, 0, 0.25, 0.35), css(hexCol('#3a2c22')));
    } else {
      // the big engine cowl and its exhaust stubs
      fillShape(p.ctx, oval(7.4, 0, 0.6, 1.35), cylGrad(p, COWL, 7.4, 0, 1, 0, 1.35, 0.35));
      fillShape(p.ctx, oval(8.15, 0, 0.42, 0.42), domeGrad(p, mods & M_MASTERY ? hexCol('#c23b2a') : hexCol('#3a3d40'), 8.15, 0, 0.42));
      for (const sd of [-1, 1]) rod(p, 6.2, sd * 1.25, 4.6, sd * 1.32, 0.22, hexCol('#1d1d1d'));
    }
    if (mods & M_MASTERY) checks(p, 6.0, 6.8, 1.45);
  },
  silhouette: () => merge(gaWings, gaBody, gaTail),
  roundels: () => [
    [GW.le0 - 1.6 - (GW.le0 - GW.le1) * 0.75, 7.1, 0.95],
    [GW.le0 - 1.6 - (GW.le0 - GW.le1) * 0.75, -7.1, 0.95],
  ],
  props: (mods) => (mods & M_JET ? [] : [{ x: 8.5, y: 0, r: 2.6 }]),
};

/** A checkered band round a nose (Air Mastery). */
function checks(p: Paint, x0: number, x1: number, r: number): void {
  if (!fine(p, 1.2)) {
    fillShape(p.ctx, (k) => k.rect(x0, -r, x1 - x0, r * 2), css(hexCol('#d9b23c')));
    return;
  }
  const n = 6;
  const cw = (x1 - x0) / 2;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < 2; j++) {
      const y = -r + (i * 2 * r) / n;
      fillShape(p.ctx, (k) => k.rect(x0 + j * cw, y, cw, (2 * r) / n), (i + j) % 2 ? 'rgba(20,20,18,0.95)' : 'rgba(230,196,64,0.95)');
    }
}

// ---- heavy bomber: four engines, long wings, natural metal
const HW = { le0: 3.8, c0: 6.0, le1: 2.0, c1: 2.6, s: 20 };
const hbBody = bodyShape(-13, 13, 1.75, 2.5, 0.7, 0.2);
const hbWings = wingsShape(HW.le0, HW.c0, HW.le1, HW.c1, HW.s);
const hbTail = wingsShape(-9.4, 3.8, -10.4, 2.0, 7.6);

const heavyBomber: PlanePlan = {
  len: 26,
  span: 40,
  alt: 12,
  paint(p, mods) {
    const night = !!(mods & M_NIGHT);
    const col = night ? NIGHT : METAL;
    if (mods & M_SPECIAL) for (const y of [-14.5, 14.5]) dropTank(p, 3.0, y, 2.2, 0.6);
    wingPaint(p, hbTail, col, -9.4, -13.2, 7.6, 521);
    wingPaint(p, hbWings, col, HW.le0, HW.le0 - HW.c0, HW.s, 523);
    fuselagePaint(p, hbBody, col, 2.5, 1.75);
    fin(p, -13.6, -8.4, 0, 0.7, 3.4, col, mods & M_MASTERY ? hexCol('#d8b23a') : undefined);
    // the olive anti-glare panel ahead of the cockpit, the glazed nose, the cockpit
    if (!night) fillShape(p.ctx, bodyShape(6.5, 11.4, 1.0, 9, 0.6, 0.9), css(OLIVE_DRAB, 0.9));
    glazedNose(p, hbBody, 11.2, 13, 1.75);
    canopy(p, 7.0, 9.0, 1.0);
    gunDome(p, 5.4, 0, 0.75);
    if (mods & M_PATH3) {
      gunDome(p, -3.6, 0, 0.75);
      gunDome(p, 12.2, 0, 0.6);
      gunDome(p, -11.6, 0, 0.6);
    }
    for (const [y, xt, xn] of [
      [-5.8, -1.6, 6.6],
      [5.8, -1.6, 6.6],
      [-11.2, -0.4, 5.4],
      [11.2, -0.4, 5.4],
    ] as const)
      nacelle(p, xt, xn, y, 1.0, col, false, night);
  },
  silhouette: () => merge(hbWings, hbBody, hbTail),
  roundels: () => [
    [HW.le0 - 2.6 - (HW.le0 - HW.le1) * 0.78, 15.8, 1.5],
    [HW.le0 - 2.6 - (HW.le0 - HW.le1) * 0.78, -15.8, 1.5],
  ],
  props: () => [
    { x: 6.9, y: -5.8, r: 2.5 },
    { x: 6.9, y: 5.8, r: 2.5 },
    { x: 5.7, y: -11.2, r: 2.5 },
    { x: 5.7, y: 11.2, r: 2.5 },
  ],
};

// ---- fighter: small, elliptical wings (jets: swept wings, a nose intake)
const ftBody = bodyShape(-6.5, 6.5, 0.95, 2.0, 0.55, 0.2);
const ftWings = ellipticShape(2.2, 3.5, 7.5);
const ftTail = ellipticShape(-4.7, 1.6, 2.7);
const jtBody = bodyShape(-6.5, 6.8, 1.0, 1.5, 0.9, 0.45);
const jtWings = wingsShape(1.8, 3.4, -2.6, 1.5, 7.0);
const jtTail = wingsShape(-4.2, 1.7, -5.8, 1.0, 2.8);

const fighter: PlanePlan = {
  len: 13,
  span: 15,
  alt: 7,
  paint(p, mods) {
    const jet = !!(mods & M_JET);
    const col = jet ? METAL : FIGHTER;
    if (mods & M_SPECIAL) for (const y of [-2.6, 2.6]) dropTank(p, jet ? 0.6 : 1.4, y, 1.4, 0.42);
    if (jet) {
      wingPaint(p, jtTail, col, -4.2, -7, 2.8, 531);
      wingPaint(p, jtWings, col, 1.8, -4.1, 7, 533);
      fuselagePaint(p, jtBody, col, 1.5, 1.0);
      fin(p, -6.8, -4.0, 0, 0.36, 1.6, col);
      fillShape(p.ctx, oval(6.55, 0, 0.3, 0.7), css(hexCol('#141618')));
      fillShape(p.ctx, oval(-6.4, 0, 0.2, 0.42), css(hexCol('#3a2c22')));
      canopy(p, 1.6, 4.0, 0.62);
    } else {
      wingPaint(p, ftTail, col, -4.7, -6.3, 2.7, 535);
      wingPaint(p, ftWings, col, 2.2, -1.3, 7.5, 537);
      camo(p, ftWings, -1.3, 2.2, -7.5, 7.5, 7.7, darken(col, 0.22), 7);
      fuselagePaint(p, ftBody, col, 2.0, 0.95);
      fin(p, -6.6, -4.3, 0, 0.32, 1.5, col);
      canopy(p, -0.9, 1.4, 0.6);
      fillShape(p.ctx, oval(6.35, 0, 0.3, 0.32), domeGrad(p, mods & M_MASTERY ? hexCol('#c23b2a') : hexCol('#3a3d40'), 6.35, 0, 0.32));
      for (const sd of [-1, 1]) rod(p, 5.2, sd * 0.78, 3.6, sd * 0.84, 0.16, hexCol('#1d1d1d'));
    }
    if (mods & M_MASTERY) checks(p, jet ? 4.6 : 4.4, jet ? 5.3 : 5.1, jet ? 0.98 : 0.88);
  },
  silhouette: (mods) => (mods & M_JET ? merge(jtWings, jtBody, jtTail) : merge(ftWings, ftBody, ftTail)),
  roundels: (mods) =>
    mods & M_JET
      ? [
          [-1.9, 4.9, 0.8],
          [-1.9, -4.9, 0.8],
        ]
      : [
          [0.3, 5.0, 0.85],
          [0.3, -5.0, 0.85],
        ],
  props: (mods) => (mods & M_JET ? [] : [{ x: 6.8, y: 0, r: 2.1 }]),
};

// ---- transport: fat fuselage, high wing, twin engines, recognition stripes
const TW = { le0: 3.4, c0: 4.6, le1: 2.2, c1: 2.2, s: 15 };
const trBody = bodyShape(-11, 11, 1.95, 2.6, 0.9, 0.22);
const trWings = wingsShape(TW.le0, TW.c0, TW.le1, TW.c1, TW.s);
const trTail = wingsShape(-7.8, 2.8, -8.4, 1.6, 5.2);

const transportPlane: PlanePlan = {
  len: 22,
  span: 30,
  alt: 8,
  paint(p, mods) {
    const c = p.ctx;
    const jet = !!(mods & M_JET);
    const col = OLIVE_DRAB;
    if (mods & M_SPECIAL) for (const y of [-8.6, 8.6]) dropTank(p, 2.8, y, 2.2, 0.6);
    wingPaint(p, trTail, col, -7.8, -10.6, 5.2, 541);
    fuselagePaint(p, trBody, col, 2.6, 1.95, 1.2);
    // black and white recognition stripes round the rear fuselage
    stripes(p, trBody, -6.4, 0.42);
    fin(p, -11.2, -7.6, 0, 0.6, 2.8, col);
    // cabin windows down both sides and the open jump door at the back on the left
    if (fine(p, 1.3)) for (let x = -4.2; x < 4; x += 1.2) for (const sd of [-1, 1]) fillShape(c, (k) => k.rect(x, sd * 1.62 - 0.17, 0.48, 0.34), 'rgba(18,24,28,0.85)');
    fillShape(c, (k) => k.rect(-5.6, -1.98, 1.2, 0.7), css(hexCol('#0f1112')));
    canopy(p, 8.0, 9.9, 1.1);
    // the high wing passes over the fuselage, its own stripes outboard
    wingPaint(p, trWings, col, TW.le0, TW.le0 - TW.c0, TW.s, 543);
    c.save();
    c.beginPath();
    trWings(c);
    c.clip();
    for (const sd of [-1, 1]) stripes(p, (k) => k.rect(-4, sd > 0 ? 7 : -9.6, 9, 2.6), -2.0, 0.42, true, sd * 8.3);
    c.restore();
    for (const y of [-5.0, 5.0]) nacelle(p, jet ? -2.4 : -1.2, jet ? 6.8 : 5.9, y, jet ? 0.95 : 1.15, col, jet, false);
  },
  silhouette: () => merge(trWings, trBody, trTail),
  roundels: () => [
    [TW.le0 - 2.2 - (TW.le0 - TW.le1) * 0.75, 11.6, 1.35],
    [TW.le0 - 2.2 - (TW.le0 - TW.le1) * 0.75, -11.6, 1.35],
  ],
  props: (mods) =>
    mods & M_JET
      ? []
      : [
          { x: 6.3, y: -5.0, r: 2.6 },
          { x: 6.3, y: 5.0, r: 2.6 },
        ],
};

/** Five black and white bands across x (round a fuselage, or chordwise across a wing when `across`). */
function stripes(p: Paint, s: Shape, x0: number, w: number, across = false, y = 0): void {
  const c = p.ctx;
  c.save();
  c.beginPath();
  s(c);
  c.clip();
  for (let i = 0; i < 5; i++) {
    const col = i % 2 ? 'rgba(18,18,18,0.92)' : 'rgba(232,232,224,0.92)';
    if (across) fillShape(c, (k) => k.rect(-20, y - 1.25 + i * 0.5, 40, 0.5), col);
    else fillShape(c, (k) => k.rect(x0 + i * w, -3, w, 6), col);
  }
  c.restore();
}

// ---- recon: twin booms, a central pod with a long glazed nose
const RW = { le0: 1.9, c0: 3.4, le1: 1.1, c1: 1.8, s: 11 };
const rcPod = bodyShape(-3.2, 7.4, 1.15, 2.4, 0.7, 0.5);
const rcWings = wingsShape(RW.le0, RW.c0, RW.le1, RW.c1, RW.s);
const rcBoom = (y: number): Shape => (c) => {
  c.save();
  c.translate(0, y);
  bodyShape(-7.8, 5.8, 0.85, 3.4, 0.75, 0.35)(c);
  c.restore();
};
const rcTail: Shape = (c) => c.rect(-7.9, -3.6, 1.7, 7.2);

const reconPlane: PlanePlan = {
  len: 16,
  span: 22,
  alt: 11,
  paint(p, mods) {
    const col = PRU;
    if (mods & M_SPECIAL) for (const y of [-6.4, 6.4]) dropTank(p, 1.2, y, 1.6, 0.48);
    wingPaint(p, rcTail, col, -6.2, -7.9, 3.6, 551);
    wingPaint(p, rcWings, col, RW.le0, RW.le0 - RW.c0, RW.s, 553);
    for (const y of [-3.4, 3.4]) {
      turn(p, 0, y, 0, (q) => {
        const b = bodyShape(-7.8, 5.8, 0.85, 3.4, 0.75, 0.35);
        fuselagePaint(q, b, col, 3.4, 0.85, 0.9);
        fillShape(q.ctx, oval(5.5, 0, 0.3, 0.75), cylGrad(q, COWL, 5.5, 0, 1, 0, 0.75));
        fillShape(q.ctx, oval(5.85, 0, 0.26, 0.26), domeGrad(q, hexCol('#3a3d40'), 5.85, 0, 0.26));
      });
      fin(p, -8.2, -5.8, y, 0.4, 1.8, col);
    }
    fuselagePaint(p, rcPod, col, 2.4, 1.15, 1.1);
    glazedNose(p, rcPod, 4.6, 7.4, 1.15);
    canopy(p, 1.2, 3.4, 0.75);
    if (fine(p)) fillShape(p.ctx, oval(-1.6, 0, 0.42, 0.3), css(hexCol('#0f1418')));
  },
  silhouette: () => merge(rcWings, rcPod, rcBoom(-3.4), rcBoom(3.4), rcTail),
  roundels: () => [
    [RW.le0 - 1.5 - (RW.le0 - RW.le1) * 0.75, 7.9, 1.05],
    [RW.le0 - 1.5 - (RW.le0 - RW.le1) * 0.75, -7.9, 1.05],
  ],
  props: () => [
    { x: 6.1, y: -3.4, r: 2.1 },
    { x: 6.1, y: 3.4, r: 2.1 },
  ],
};

const PLANES: Partial<Record<SpriteKey, PlanePlan>> = { bomber, groundAttack, heavyBomber, fighter, transportPlane, reconPlane };

function shadowLayer(shapes: Shape[], hl: number, hs: number, a: number): Layer {
  return {
    b: bounds(-hl - 2, -hs - 2, hl + 2, hs + 2),
    paint: (p) => {
      for (const s of shapes) softShadow(p, s, 0, 0, a, 0.5);
    },
  };
}

/** A plane's model: its painted body, the roundels, its ground shadow and propellers. */
export function planeModel(key: SpriteKey, mods: number): UnitModel {
  const plan = PLANES[key] ?? bomber;
  const hl = plan.len / 2 + 1.5;
  const hs = plan.span / 2 + 1.5;
  const b = bounds(-hl - 1, -hs - 1, hl + 3, hs + 1);
  const body: Layer = { b, paint: (p) => plan.paint(p, mods) };
  const owners: OwnerLayer[] = plan.roundels(mods).map(([x, y, r]) => ({ b: bounds(x - r - 0.6, y - r - 0.6, x + r + 0.6, y + r + 0.6), paint: (p, t) => roundel(p, x, y, r, t, !(mods & M_NIGHT)) }));
  const shapes = plan.silhouette(mods);
  const wingShade: Layer = {
    b,
    paint: (p) => {
      const c = p.ctx;
      c.save();
      c.beginPath();
      c.rect(-hl - 2, 0.6, hl * 2 + 4, hs + 2);
      c.clip();
      const g = c.createLinearGradient(0, 0, 0, hs);
      g.addColorStop(0, 'rgba(8,12,18,0)');
      g.addColorStop(0.3, 'rgba(8,12,18,0.55)');
      g.addColorStop(1, 'rgba(8,12,18,1)');
      for (const s of shapes) fillShape(c, s, g);
      c.restore();
    },
  };
  return {
    len: Math.max(plan.len, plan.span * 0.8),
    fit: Math.max(plan.len, plan.span),
    body,
    owners,
    shadow: shadowLayer(shapes, hl, hs, 0.3),
    wingShade,
    alt: plan.alt * 0.7,
    props: plan.props(mods),
  };
}

// ------------------------------------------------------------------------------------------------- missiles

function missileBody(p: Paint, xt: number, xn: number, r: number, col: Col, finL: number, finS: number, bands: (s: Shape) => void): void {
  const c = p.ctx;
  const body = bodyShape(xt, xn, r, xt + (xn - xt) * 0.55, 0.62, 0.78);
  const fins: Shape = (k) => {
    k.moveTo(xt + finL, r * 0.8);
    k.lineTo(xt + finL * 0.25, finS);
    k.lineTo(xt - 0.2, finS);
    k.lineTo(xt, r * 0.7);
    k.lineTo(xt, -r * 0.7);
    k.lineTo(xt - 0.2, -finS);
    k.lineTo(xt + finL * 0.25, -finS);
    k.lineTo(xt + finL, -r * 0.8);
    k.closePath();
  };
  fillShape(c, fins, litGrad(p, darken(col, 0.12), xt + finL / 2, 0, finS, 0.2));
  edge(p, fins, col);
  fuselagePaint(p, body, col, (xt + xn) / 2, r, 0.6);
  bands(body);
  // the top fin, edge on, with its shadow
  fin(p, xt - 0.2, xt + finL, 0, 0.28, finS - r, darken(col, 0.1));
}

const rocketPlan = { xt: -7.5, xn: 7.5, r: 0.95, finL: 3.0, finS: 2.4 };
const atomPlan = { xt: -10, xn: 10, r: 1.65, finL: 4.0, finS: 3.6 };

function bandAt(p: Paint, s: Shape, x0: number, x1: number, col: string): void {
  const c = p.ctx;
  c.save();
  c.beginPath();
  s(c);
  c.clip();
  fillShape(c, (k) => k.rect(x0, -4, x1 - x0, 8), col);
  c.restore();
}

/** A missile's model: the body (a flame is drawn per frame at its nozzle) and its ground shadow far below. */
export function missileModel(key: SpriteKey): UnitModel {
  const atom = key === 'atomBomb';
  const m = atom ? atomPlan : rocketPlan;
  const col = atom ? ATOM_BODY : ROCKET_BODY;
  const b = bounds(m.xt - 1.5, -m.finS - 1.5, m.xn + 1.5, m.finS + 1.5);
  const body: Layer = {
    b,
    paint: (p) => {
      missileBody(p, m.xt, m.xn, m.r, col, m.finL, m.finS, (s) => {
        if (atom) {
          bandAt(p, s, 4.2, 5.4, 'rgba(232,190,40,0.95)');
          bandAt(p, s, 5.4, 5.9, 'rgba(18,18,18,0.92)');
          bandAt(p, s, -4.6, -3.8, 'rgba(18,18,18,0.92)');
          if (fine(p, 1.5)) {
            const c = p.ctx;
            for (let k = 0; k < 3; k++) {
              const a0 = (k * Math.PI * 2) / 3 - 0.5;
              c.beginPath();
              c.moveTo(4.8, 0);
              c.arc(4.8, 0, 0.55, a0, a0 + 1, false);
              c.closePath();
              c.fillStyle = 'rgba(18,18,18,0.9)';
              c.fill();
            }
          }
        } else {
          bandAt(p, s, 4.6, 7.6, css(hexCol('#4f5640')));
          bandAt(p, s, -1.2, -0.7, 'rgba(18,18,18,0.8)');
        }
        grime(p, s, m.xt, -m.r, m.xn, m.r, atom ? 571 : 573, 8, hexCol('#3b3a36'), 0.2, 0.4);
      });
    },
  };
  const shape = bodyShape(m.xt, m.xn, m.r, m.xt + (m.xn - m.xt) * 0.55, 0.62, 0.78);
  const finShape: Shape = (k) => {
    k.moveTo(m.xt + m.finL, m.r * 0.8);
    k.lineTo(m.xt + m.finL * 0.25, m.finS);
    k.lineTo(m.xt - 0.2, m.finS);
    k.lineTo(m.xt - 0.2, -m.finS);
    k.lineTo(m.xt + m.finL * 0.25, -m.finS);
    k.lineTo(m.xt + m.finL, -m.r * 0.8);
    k.closePath();
  };
  return {
    len: m.xn - m.xt,
    fit: m.xn - m.xt,
    body,
    shadow: shadowLayer([shape, finShape], (m.xn - m.xt) / 2 + 1, m.finS + 1, 0.36),
    alt: atom ? 10 : 9,
    flame: { x: m.xt - 0.2, r: atom ? 1.9 : 1.25 },
  };
}
