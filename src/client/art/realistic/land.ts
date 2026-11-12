// The realistic style's tanks (client only): painted top-down miniatures, told apart by size and shape:
//   tankDivision  a medium tank in olive drab: a cast round turret with a cupola, a medium gun, engine grilles, a
//                 bedroll on the back deck
//   lightTank     small and quick, in sand: narrow tracks, a little turret, a thin short gun and a whip aerial
//   heavyTank     wide and long, in dark grey green: broad tracks, a big angular turret, a long thick gun with a muzzle
//                 brake
// Upgrades are real details: Armor Mastery hangs armour skirts over the tracks, Amphibious Tanks add a snorkel and
// wading trunks, Deep Raids (light tank) jerrycans and fuel drums, Siege Tanks (heavy tank) a dozer blade.
// The owner's colour is an air recognition panel across the turret roof, so it turns with the turret (turret sway);
// the hull and the tracks keep their own paint.
import { M_MASTERY, M_PATH3, M_SPECIAL, type SpriteKey } from '../shared/keys';
import { bounds, type Layer, type OwnerLayer, type Tones, type UnitModel } from './model';
import { block, box, castShadow, type Col, css, cylGrad, darken, domeGrad, edge, fillShape, fine, grime, hair, hexCol, innerShade, lighten, linesY, litGrad, mirrored, oval, type Paint, polyShape, rim, rod, type Shape, softShadow, strokeShape } from './paint';

const OLIVE = hexCol('#5f6638');
const SAND = hexCol('#a5915f');
const GREY_GREEN = hexCol('#4f5850');
const TRACK = hexCol('#2a2825');
const LINK = 'rgba(120,114,104,0.55)';
const STEEL = hexCol('#6b6d68');
const CANVAS = hexCol('#8d8462');
const BARREL_DARK = 0.12;

interface TankPlan {
  /** hull from x0 (rear) to x1 (front), half width w (tracks included), track width tw */
  x0: number;
  x1: number;
  w: number;
  tw: number;
  col: Col;
  /** turret ring centre (x) and the turret painter (in its own frame, facing +x) */
  tx: number;
  turret: (p: Paint) => void;
  /** the owner panel on the turret roof (turret frame) */
  roof: (p: Paint, t: Tones) => void;
  /** where the gun's muzzle ends (x, turret frame) */
  muzzle: number;
  /** the turret's footprint (turret frame) for its shadow on the hull */
  turretShape: Shape;
  turretH: number;
  hullDetail: (p: Paint, mods: number) => void;
  seed: number;
}

/** A track run: a long rounded band with its links, the sprocket and idler showing at both ends. */
function track(p: Paint, x0: number, x1: number, y: number, tw: number): void {
  const s = box((x0 + x1) / 2, y, (x1 - x0) / 2, tw / 2, tw * 0.45);
  fillShape(p.ctx, s, litGrad(p, TRACK, (x0 + x1) / 2, y, tw, 0.18));
  linesY(p, s, x0 + 0.3, x1 - 0.3, y - tw / 2, y + tw / 2, 0.62, LINK, 0.1);
  if (fine(p, 2)) strokeShape(p.ctx, (c) => {
    c.moveTo(x0 + 0.5, y);
    c.lineTo(x1 - 0.5, y);
  }, 'rgba(150,144,132,0.35)', 0.14);
  edge(p, s, TRACK, 1.2);
}

/** Armour skirts over a track (Armor Mastery): plates with small gaps. */
function skirts(p: Paint, x0: number, x1: number, y: number, tw: number, col: Col): void {
  const n = Math.max(3, Math.round((x1 - x0) / 2.6));
  const L = (x1 - x0) / n;
  for (let i = 0; i < n; i++) {
    const cx = x0 + L * (i + 0.5);
    const s = box(cx, y, L / 2 - 0.12, tw * 0.62, 0.1);
    block(p, s, lighten(col, 0.04), 0.4, cx, y, L / 2);
  }
}

/** Fine engine grilles: slats across a deck panel. */
function grille(p: Paint, cx: number, cy: number, hw: number, hh: number, col: Col): void {
  const s = box(cx, cy, hw, hh, 0.15);
  fillShape(p.ctx, s, css(darken(col, 0.28)));
  linesY(p, s, cx - hw, cx + hw, cy - hh, cy + hh, 0.34, css(lighten(col, 0.1), 0.6), 0.08);
  edge(p, s, col, 0.8);
}

/** A hatch: a round lid with a hinge and a light rim. */
function hatch(p: Paint, x: number, y: number, r: number, col: Col): void {
  const s = oval(x, y, r, r);
  fillShape(p.ctx, s, domeGrad(p, col, x, y, r, 0.22));
  edge(p, s, col, 0.8);
  if (fine(p, 2)) fillShape(p.ctx, box(x - r * 0.6, y, r * 0.18, r * 0.5, 0.05), css(darken(col, 0.4)));
}

/** A snorkel and wading trunks (Amphibious Tanks). */
function amphibious(p: Paint, x0: number, w: number, col: Col): void {
  for (const y of [-w * 0.4, w * 0.4]) block(p, box(x0 + 1.0, y, 0.9, w * 0.26, 0.2), lighten(col, 0.03), 1.3, x0 + 1, y, 1);
  const sx = x0 + 2.4;
  const sy = -w * 0.62;
  castShadow(p, oval(sx, sy, 0.45, 0.45), 4.2, 0.4);
  fillShape(p.ctx, oval(sx, sy, 0.5, 0.5), domeGrad(p, darken(col, 0.05), sx, sy, 0.5));
  fillShape(p.ctx, oval(sx, sy, 0.28, 0.28), css(hexCol('#141412')));
}

/** The tank's hull: tracks, the hull deck with its plates and fittings, its soft ground shadow. */
function paintHull(p: Paint, t: TankPlan, mods: number): void {
  const c = p.ctx;
  const { x0, x1, w, tw, col } = t;
  const all = box((x0 + x1) / 2, 0, (x1 - x0) / 2 + 0.2, w, 1);
  softShadow(p, all, -p.lx * 1.4, -p.ly * 1.4, 0.4, 0.9);
  track(p, x0, x1, -w + tw / 2, tw);
  track(p, x0, x1, w - tw / 2, tw);
  if (mods & M_MASTERY) {
    skirts(p, x0 + 0.8, x1 - 0.8, -w + tw / 2, tw, col);
    skirts(p, x0 + 0.8, x1 - 0.8, w - tw / 2, tw, col);
  }
  // the hull deck between the tracks, a sloped glacis plate at the front
  const hw = w - tw + 0.35;
  const deck = polyShape(mirrored([x1, -hw * 0.82, x1 - 1.2, -hw, x0 + 0.5, -hw, x0, -hw * 0.9, x0, 0]));
  block(p, deck, col, 1.1, (x0 + x1) / 2, 0, (x1 - x0) / 2, { k: 0.18 });
  const glacis = polyShape(mirrored([x1, -hw * 0.82, x1 - 1.2, -hw, x1 - 3.2, -hw, x1 - 3.2, 0]));
  fillShape(c, glacis, litGrad(p, lighten(col, 0.07), x1 - 1.6, 0, 2, 0.22));
  strokeShape(c, (k) => {
    k.moveTo(x1 - 3.2, -hw);
    k.lineTo(x1 - 3.2, hw);
  }, css(darken(col, 0.4), 0.6), hair(p, 0.8));
  grime(p, deck, x0, -hw, x1, hw, t.seed, 18, darken(col, 0.4), 0.18, 0.5);
  grime(p, deck, x0, -hw, x1, hw, t.seed + 1, 8, hexCol('#8a7a5a'), 0.16, 0.6);
  rim(p, deck, col, 0.5);
  t.hullDetail(p, mods);
  if (mods & M_SPECIAL) amphibious(p, x0, hw, col);
  innerShade(p, deck, 0.25, 0.18);
}

// ------------------------------------------------------------------------------------------------- medium tank

const MED_X0 = -11;
const MED_X1 = 6;
const MED_W = 5.0;
const MED_T = -2.8;
const medTurretShape: Shape = (c) => {
  c.moveTo(3.4, 0);
  c.bezierCurveTo(3.4, -2.5, 1.4, -3.3, -0.6, -3.3);
  c.bezierCurveTo(-2.8, -3.3, -4.1, -2.0, -4.1, 0);
  c.bezierCurveTo(-4.1, 2.0, -2.8, 3.3, -0.6, 3.3);
  c.bezierCurveTo(1.4, 3.3, 3.4, 2.5, 3.4, 0);
  c.closePath();
};

const medium: TankPlan = {
  x0: MED_X0,
  x1: MED_X1,
  w: MED_W,
  tw: 1.55,
  col: OLIVE,
  tx: MED_T,
  turretShape: medTurretShape,
  turretH: 1.6,
  muzzle: 14.3,
  seed: 401,
  turret(p) {
    const c = p.ctx;
    castShadow(p, medTurretShape, 1.6, 0.36);
    rod(p, 2.6, 0, 14.3, 0, 0.62, darken(OLIVE, BARREL_DARK), 1.8);
    if (fine(p, 2)) fillShape(c, oval(14.2, 0, 0.18, 0.34), css(hexCol('#151510')));
    fillShape(c, box(3.2, 0, 0.75, 1.25, 0.4), domeGrad(p, OLIVE, 3.2, 0, 1.25, 0.3));
    fillShape(c, medTurretShape, domeGrad(p, OLIVE, -0.4, 0, 3.6, 0.3));
    edge(p, medTurretShape, OLIVE, 1.1);
    rim(p, medTurretShape, OLIVE, 0.45);
    grime(p, medTurretShape, -4, -3.3, 3.4, 3.3, 405, 10, darken(OLIVE, 0.4), 0.16, 0.45);
  },
  roof(p, t) {
    const c = p.ctx;
    c.save();
    c.beginPath();
    medTurretShape(c);
    c.clip();
    fillShape(c, box(-2.35, 0, 0.95, 3.6, 0), litGrad(p, t.base, -2.3, 0, 2, 0.24));
    c.restore();
    // the cupola with its vision blocks and the loader's hatch sit over the panel
    const cx = -1.5;
    const cy = 1.35;
    fillShape(c, oval(cx, cy, 1.25, 1.25), domeGrad(p, OLIVE, cx, cy, 1.25, 0.3));
    edge(p, oval(cx, cy, 1.25, 1.25), OLIVE);
    hatch(p, cx, cy, 0.8, darken(OLIVE, 0.06));
    hatch(p, -1.0, -1.45, 0.85, darken(OLIVE, 0.04));
    if (fine(p, 1.8)) rod(p, -3.6, -2.0, -6.4, -2.6, 0.12, hexCol('#2a2a26'), 0.4);
  },
  hullDetail(p, mods) {
    const c = p.ctx;
    void mods;
    // driver and bow gunner hatches, headlights, the engine deck grilles, a bedroll and the exhausts
    hatch(p, MED_X1 - 2.0, -1.5, 0.7, darken(OLIVE, 0.05));
    hatch(p, MED_X1 - 2.0, 1.5, 0.7, darken(OLIVE, 0.05));
    for (const y of [-2.7, 2.7]) fillShape(c, oval(MED_X1 - 0.5, y, 0.35, 0.35), domeGrad(p, hexCol('#cfd2c4'), MED_X1 - 0.5, y, 0.35));
    grille(p, MED_X0 + 2.4, -1.4, 1.5, 1.05, OLIVE);
    grille(p, MED_X0 + 2.4, 1.4, 1.5, 1.05, OLIVE);
    const roll = box(MED_X0 + 0.9, 0, 0.55, 3.1, 0.5);
    block(p, roll, CANVAS, 0.7, MED_X0 + 0.9, 0, 3, { k: 0.15 });
    if (fine(p, 1.8)) linesY(p, roll, MED_X0 + 0.4, MED_X0 + 1.4, -3, 3, 1.5, 'rgba(40,36,24,0.5)', 0.1);
    for (const y of [-3.0, 3.0]) fillShape(c, oval(MED_X0 + 0.25, y, 0.32, 0.45), css(hexCol('#262420')));
    if (fine(p, 2)) {
      rod(p, MED_X0 + 5.5, -3.25, MED_X0 + 9.5, -3.25, 0.18, hexCol('#6f5a3a'));
      rod(p, MED_X0 + 5.5, 3.25, MED_X0 + 8.8, 3.25, 0.14, STEEL);
    }
  },
};

// ------------------------------------------------------------------------------------------------- light tank

const LT_X0 = -8.2;
const LT_X1 = 4.0;
const LT_W = 3.75;
const LT_T = -2.0;
const ltTurretShape: Shape = (c) => {
  c.moveTo(2.2, 0);
  c.bezierCurveTo(2.2, -1.7, 1.0, -2.2, -0.4, -2.2);
  c.bezierCurveTo(-1.8, -2.2, -2.7, -1.4, -2.7, 0);
  c.bezierCurveTo(-2.7, 1.4, -1.8, 2.2, -0.4, 2.2);
  c.bezierCurveTo(1.0, 2.2, 2.2, 1.7, 2.2, 0);
  c.closePath();
};

const light: TankPlan = {
  x0: LT_X0,
  x1: LT_X1,
  w: LT_W,
  tw: 1.1,
  col: SAND,
  tx: LT_T,
  turretShape: ltTurretShape,
  turretH: 1.2,
  muzzle: 9.6,
  seed: 431,
  turret(p) {
    const c = p.ctx;
    castShadow(p, ltTurretShape, 1.2, 0.36);
    rod(p, 1.6, 0, 9.6, 0, 0.38, darken(SAND, 0.45), 1.3);
    fillShape(c, box(2.1, 0, 0.5, 0.75, 0.3), domeGrad(p, SAND, 2.1, 0, 0.8, 0.3));
    fillShape(c, ltTurretShape, domeGrad(p, SAND, -0.3, 0, 2.4, 0.3));
    edge(p, ltTurretShape, SAND, 1.1);
    rim(p, ltTurretShape, SAND, 0.45);
    grime(p, ltTurretShape, -2.7, -2.2, 2.2, 2.2, 433, 8, darken(SAND, 0.45), 0.16, 0.35);
  },
  roof(p, t) {
    const c = p.ctx;
    c.save();
    c.beginPath();
    ltTurretShape(c);
    c.clip();
    fillShape(c, box(-1.55, 0, 0.7, 2.5, 0), litGrad(p, t.base, -1.5, 0, 1.5, 0.24));
    c.restore();
    hatch(p, -0.7, 0.75, 0.68, darken(SAND, 0.06));
    // the whip aerial at the turret's back
    fillShape(c, oval(-1.9, -1.2, 0.22, 0.22), css(hexCol('#2d2b26')));
    if (fine(p, 1.4)) rod(p, -1.9, -1.2, -5.0, -1.9, 0.08, hexCol('#3b3a35'), 0.2);
  },
  hullDetail(p, mods) {
    const c = p.ctx;
    hatch(p, LT_X1 - 1.5, -0.9, 0.55, darken(SAND, 0.05));
    grille(p, LT_X0 + 1.9, 0, 1.25, 1.6, SAND);
    for (const y of [-2.0, 2.0]) fillShape(c, oval(LT_X1 - 0.35, y, 0.28, 0.28), domeGrad(p, hexCol('#d8d6c8'), LT_X1 - 0.35, y, 0.28));
    if (mods & M_PATH3) {
      // Deep Raids: jerrycans along the back and fuel drums on the engine deck
      for (const y of [-2.35, -1.15, 1.15, 2.35]) {
        const s = box(LT_X0 + 0.25, y, 0.32, 0.5, 0.08);
        block(p, s, hexCol('#5d6539'), 0.5, LT_X0 + 0.25, y, 0.5);
        if (fine(p, 2)) strokeShape(c, (k) => {
          k.moveTo(LT_X0, y - 0.35);
          k.lineTo(LT_X0 + 0.5, y + 0.35);
        }, 'rgba(20,22,12,0.5)', 0.07);
      }
      for (const y of [-0.85, 0.85]) {
        const s = oval(LT_X0 + 3.6, y, 0.72, 0.72);
        castShadow(p, s, 0.8, 0.34);
        fillShape(c, s, domeGrad(p, hexCol('#4d5a3a'), LT_X0 + 3.6, y, 0.72, 0.3));
        strokeShape(c, oval(LT_X0 + 3.6, y, 0.5, 0.5), 'rgba(20,24,14,0.45)', 0.07);
      }
    }
  },
};

// ------------------------------------------------------------------------------------------------- heavy tank

const HV_X0 = -15.4;
const HV_X1 = 6.2;
const HV_W = 6.4;
const HV_T = -5.2;
const hvTurret = polyShape([3.4, -2.2, 2.4, -3.8, -4.2, -3.9, -5.4, -2.8, -5.4, 2.8, -4.2, 3.9, 2.4, 3.8, 3.4, 2.2]);

const heavy: TankPlan = {
  x0: HV_X0,
  x1: HV_X1,
  w: HV_W,
  tw: 2.05,
  col: GREY_GREEN,
  tx: HV_T,
  turretShape: hvTurret,
  turretH: 2.1,
  muzzle: 21.1,
  seed: 461,
  turret(p) {
    const c = p.ctx;
    castShadow(p, hvTurret, 2.1, 0.38);
    rod(p, 3.0, 0, 20.0, 0, 0.92, darken(GREY_GREEN, BARREL_DARK), 2.4);
    // the muzzle brake
    const mb = box(20.4, 0, 0.75, 0.8, 0.2);
    fillShape(c, mb, cylGrad(p, darken(GREY_GREEN, 0.18), 20.4, 0, 1, 0, 0.8));
    edge(p, mb, GREY_GREEN);
    // the mantlet, the turret with its sloped faces (the roof lit, the cheeks a touch darker)
    fillShape(c, box(3.6, 0, 0.9, 1.9, 0.5), domeGrad(p, GREY_GREEN, 3.6, 0, 1.9, 0.3));
    fillShape(c, hvTurret, litGrad(p, GREY_GREEN, -1, 0, 4.4, 0.2));
    const roof = polyShape([2.4, -1.8, 1.8, -2.8, -3.8, -2.9, -4.6, -2.2, -4.6, 2.2, -3.8, 2.9, 1.8, 2.8, 2.4, 1.8]);
    fillShape(c, roof, litGrad(p, lighten(GREY_GREEN, 0.06), -1, 0, 4, 0.18));
    edge(p, hvTurret, GREY_GREEN, 1.2);
    rim(p, hvTurret, GREY_GREEN, 0.4);
    grime(p, hvTurret, -5.4, -3.9, 3.4, 3.9, 463, 12, darken(GREY_GREEN, 0.45), 0.16, 0.5);
    // spare track links on the cheeks
    if (fine(p, 1.6)) for (const y of [-3.4, 3.4]) linesY(p, box(-0.6, y, 1.8, 0.35, 0.05), -2.4, 1.2, y - 0.35, y + 0.35, 0.6, 'rgba(30,30,28,0.7)', 0.12);
  },
  roof(p, t) {
    const c = p.ctx;
    c.save();
    c.beginPath();
    hvTurret(c);
    c.clip();
    fillShape(c, box(-3.5, 0, 1.2, 4.2, 0), litGrad(p, t.base, -3.5, 0, 2.5, 0.24));
    c.restore();
    const cx = -2.6;
    const cy = 1.8;
    fillShape(c, oval(cx, cy, 1.35, 1.35), domeGrad(p, GREY_GREEN, cx, cy, 1.35, 0.3));
    edge(p, oval(cx, cy, 1.35, 1.35), GREY_GREEN);
    hatch(p, cx, cy, 0.85, darken(GREY_GREEN, 0.06));
    hatch(p, -1.6, -1.8, 0.95, darken(GREY_GREEN, 0.05));
    fillShape(c, oval(0.8, -1.8, 0.35, 0.35), css(darken(GREY_GREEN, 0.45)));
  },
  hullDetail(p, mods) {
    const c = p.ctx;
    hatch(p, HV_X1 - 2.6, -2.0, 0.85, darken(GREY_GREEN, 0.05));
    hatch(p, HV_X1 - 2.6, 2.0, 0.85, darken(GREY_GREEN, 0.05));
    grille(p, HV_X0 + 3.0, -2.0, 2.0, 1.25, GREY_GREEN);
    grille(p, HV_X0 + 3.0, 2.0, 2.0, 1.25, GREY_GREEN);
    fillShape(c, oval(HV_X0 + 6.2, 0, 0.8, 0.8), domeGrad(p, darken(GREY_GREEN, 0.1), HV_X0 + 6.2, 0, 0.8));
    for (const y of [-3.4, 3.4]) {
      const s = oval(HV_X0 + 0.4, y, 0.42, 0.62);
      fillShape(c, s, css(hexCol('#24231f')));
    }
    if (fine(p, 1.8)) {
      rod(p, HV_X0 + 7, -4.0, HV_X1 - 3, -4.0, 0.2, STEEL);
      rod(p, HV_X0 + 7, 4.0, HV_X1 - 4, 4.0, 0.24, hexCol('#6b573a'));
    }
    if (mods & M_PATH3) {
      // Siege Tanks: a dozer blade on push arms across the front
      for (const y of [-4.2, 4.2]) rod(p, HV_X1 - 1, y, HV_X1 + 1.8, y, 0.55, darken(GREY_GREEN, 0.25), 0.8);
      const blade: Shape = (k) => {
        k.moveTo(HV_X1 + 1.5, -HV_W - 0.6);
        k.quadraticCurveTo(HV_X1 + 3.4, 0, HV_X1 + 1.5, HV_W + 0.6);
        k.lineTo(HV_X1 + 2.4, HV_W + 0.6);
        k.quadraticCurveTo(HV_X1 + 4.2, 0, HV_X1 + 2.4, -HV_W - 0.6);
        k.closePath();
      };
      block(p, blade, hexCol('#5d605b'), 1.5, HV_X1 + 2.6, 0, 2, { k: 0.3 });
      grime(p, blade, HV_X1 + 1.5, -HV_W, HV_X1 + 4.2, HV_W, 467, 10, hexCol('#6e5a3e'), 0.4, 0.5);
    }
  },
};

const PLANS: Partial<Record<SpriteKey, TankPlan>> = { tankDivision: medium, lightTank: light, heavyTank: heavy };

/** A tank's model: the hull (with its ground shadow), the turret with the owner panel on its own layer. */
export function tankModel(key: SpriteKey, mods: number): UnitModel {
  const t = PLANS[key] ?? medium;
  const front = Math.max(t.x1 + (key === 'heavyTank' && mods & M_PATH3 ? 4.2 : 0.3), t.tx + t.muzzle);
  const back = t.x0 - 0.4;
  const len = front - back;
  const hb = bounds(t.x0 - 2.5, -t.w - 2.5, t.x1 + 5, t.w + 2.5);
  const body: Layer = { b: hb, paint: (p) => paintHull(p, t, mods) };
  const r = t.muzzle + 1.5;
  const tw = key === 'heavyTank' ? 6 : key === 'lightTank' ? 3.6 : 5;
  const turret: OwnerLayer = {
    b: bounds(-tw - 4.2, -tw - 1.5, r, tw + 2.5),
    paint: (p, tones) => {
      t.turret(p);
      t.roof(p, tones);
    },
  };
  return { len, fit: Math.max(len, t.w * 2), body, alt: 0, turret: { x: t.tx, y: 0, layer: turret }, dust: { x: t.x0, y: t.w - t.tw / 2 } };
}
