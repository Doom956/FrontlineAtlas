// The realistic style's ships (client only): painted top-down miniatures, told apart by size and silhouette first:
//   carrier      the biggest: a long dark flight deck overhanging the hull, white deck lines, three lifts, the island
//                on the starboard side with its funnel and mast, a group of small planes parked aft
//   battleship   long and heavy: a teak deck, three big triple turrets (two forward, one superfiring), a tall tower
//                bridge, a big funnel, secondary mounts down both sides, a crane on the quarterdeck
//   warship      (before an arsenal pick) a mid-size cruiser: a steel deck, a twin turret fore and aft, a bridge,
//                two funnels, a catapult
//   destroyer    small and slim: one gun house forward, a low bridge, a raked funnel, two sets of torpedo tubes,
//                depth charge racks at the stern
//   submarine    low and dark, most of the hull under the water (seen through it), a narrow deck casing and the
//                conning tower, the sea washing over its bow and stern
//   transport    a boxy landing ship: a bow ramp, an open tank deck full of troops (helmets in rows) and a jeep, the
//                bridge aft
//   tradeShip    a merchant: a black hull with red-oxide decks, cargo hatches and container stacks, yellow derricks,
//                a white bridge block aft with lifeboats and the funnel in the owner's colours
// Upgrades are real details: Naval Mastery adds quad anti-aircraft mounts and a radar array, Naval Mines a pair of
// mine rails at the stern with their mines. The owner's colour is a recognition panel (the roof of a turret, the
// carrier's deck roundel, a band on a conning tower or a bow ramp) or a merchant's funnel: never the whole ship.
import { M_MASTERY, M_SPECIAL, type SpriteKey } from '../shared/keys';
import { rnd } from '../shared/noise';
import { type Bounds, bounds, type Layer, type OwnerLayer, type Tones, type UnitModel } from './model';
import { block, box, castShadow, type Col, css, cylGrad, darken, domeGrad, edge, fillShape, fine, grime, hair, hexCol, innerShade, lighten, linesX, linesY, litGrad, mirrored, oval, type Paint, polyShape, rim, rod, type Shape, shadowAt, softShadow, strokeShape, turn } from './paint';

// ------------------------------------------------------------------------------------------------- paint

const HAZE = hexCol('#99a2a8');
const GUNHOUSE = hexCol('#8e979e');
const STEEL_DECK = hexCol('#5e656a');
const TEAK = hexCol('#a58c69');
const BARREL = hexCol('#4a5157');
const SOOT = hexCol('#1c1e21');
const BOAT = hexCol('#cfd2cb');
const RAFT = hexCol('#b39a66');
const CARRIER_DECK = hexCol('#50575c');
const SUB_HULL = hexCol('#262b2f');
const SUB_DECK = hexCol('#4a5257');
const LST = hexCol('#6d756b');
const LST_DECK = hexCol('#545a53');
const MERCH = hexCol('#2c2d2f');
const OXIDE = hexCol('#7b4434');
const MERCH_DECK = hexCol('#77715f');
const HATCH = hexCol('#56604f');
const WHITE_PAINT = hexCol('#dcddd5');
const KINGPOST = hexCol('#c49c3f');
const OLIVE = hexCol('#5b6238');
const HELMET = hexCol('#4f5634');
const CONTAINERS: readonly Col[] = [hexCol('#8b4232'), hexCol('#35617f'), hexCol('#506f46'), hexCol('#b89641'), hexCol('#c7c1ab'), hexCol('#7a8086'), hexCol('#6e4e3c')];

// ------------------------------------------------------------------------------------------------- hulls

interface Hull {
  /** half length, half beam */
  hl: number;
  hb: number;
  /** length of the bow taper and of the stern's rounding */
  bow: number;
  stern: number;
  /** half beam at a transom stern; 0 = a round cruiser stern */
  sb: number;
  /** a blunt, boxy bow (the landing ship) */
  blunt?: boolean;
}

/** A hull outline: a fine bow at +hl flaring out to the full beam, straight sides, a round or transom stern. */
function hullShape(h: Hull): Shape {
  const { hl, hb, bow, stern, sb } = h;
  return (c) => {
    if (h.blunt) {
      c.moveTo(hl, -hb * 0.55);
      c.bezierCurveTo(hl, hb * 0.1, hl, hb * 0.55, hl, hb * 0.55);
      c.bezierCurveTo(hl - bow * 0.15, hb * 0.95, hl - bow * 0.55, hb, hl - bow, hb);
    } else {
      c.moveTo(hl, 0);
      c.bezierCurveTo(hl - bow * 0.38, hb * 0.34, hl - bow * 0.72, hb, hl - bow, hb);
    }
    c.lineTo(-hl + stern, hb);
    if (sb > 0) {
      c.bezierCurveTo(-hl + stern * 0.45, hb, -hl, hb * 0.98, -hl, sb);
      c.lineTo(-hl, -sb);
      c.bezierCurveTo(-hl, -hb * 0.98, -hl + stern * 0.45, -hb, -hl + stern, -hb);
    } else {
      c.bezierCurveTo(-hl + stern * 0.4, hb, -hl, hb * 0.62, -hl, 0);
      c.bezierCurveTo(-hl, -hb * 0.62, -hl + stern * 0.4, -hb, -hl + stern, -hb);
    }
    c.lineTo(hl - bow, -hb);
    if (h.blunt) {
      c.bezierCurveTo(hl - bow * 0.55, -hb, hl - bow * 0.15, -hb * 0.95, hl, -hb * 0.55);
    } else c.bezierCurveTo(hl - bow * 0.72, -hb, hl - bow * 0.38, -hb * 0.34, hl, 0);
    c.closePath();
  };
}

/** The deck seen from above: lit paint, planks, worn edges, the hull's own edge and the light along its lit rim. */
function paintHull(p: Paint, h: Hull, deck: Col, side: Col, seed: number, o: { planks?: string; grimeCol?: Col } = {}): Shape {
  const s = hullShape(h);
  const c = p.ctx;
  fillShape(c, s, litGrad(p, deck, 0, 0, h.hl * 0.7, 0.07));
  if (o.planks) linesX(p, s, -h.hl, h.hl, -h.hb, h.hb, 0.42, o.planks, 0.06);
  grime(p, s, -h.hl, -h.hb, h.hl, h.hb, seed, Math.round(h.hl * 1.6), o.grimeCol ?? darken(deck, 0.35), 0.12, 0.45);
  innerShade(p, s, 0.32, 0.3);
  // the hull's side shows as a dark edge (it flares out a little under the deck edge), the bulwark catches the light
  strokeShape(c, s, css(side, 0.95), hair(p, 1.3));
  rim(p, s, deck, 0.45);
  return s;
}

// ------------------------------------------------------------------------------------------------- fittings

interface Gun {
  x: number;
  /** 0 = facing the bow, PI = facing the stern */
  rot: number;
  /** gun house length and width */
  L: number;
  W: number;
  /** height above the deck (a superfiring turret stands taller) */
  h: number;
  n: number;
  /** barrel length and width */
  bl: number;
  bw: number;
  /** its roof is the owner's recognition panel */
  own?: boolean;
  /** a rangefinder across the roof (main turrets) */
  range?: boolean;
}

/** A gun house facing +x: a rounded front, a flat back with small round corners. */
function houseShape(L: number, W: number, dx = 0): Shape {
  const L2 = L / 2;
  const W2 = W / 2;
  const r = Math.min(W2, L2) * 0.35;
  return (c) => {
    c.moveTo(dx - L2 + r, -W2);
    c.lineTo(dx + L2 * 0.2, -W2);
    c.bezierCurveTo(dx + L2 * 0.82, -W2, dx + L2, -W2 * 0.55, dx + L2, 0);
    c.bezierCurveTo(dx + L2, W2 * 0.55, dx + L2 * 0.82, W2, dx + L2 * 0.2, W2);
    c.lineTo(dx - L2 + r, W2);
    c.arcTo(dx - L2, W2, dx - L2, W2 - r, r);
    c.lineTo(dx - L2, -W2 + r);
    c.arcTo(dx - L2, -W2, dx - L2 + r, -W2, r);
    c.closePath();
  };
}

function gunTurret(p: Paint, g: Gun): void {
  turn(p, g.x, 0, g.rot, (q) => {
    const c = q.ctx;
    const L2 = g.L / 2;
    const W2 = g.W / 2;
    const gap = g.n === 1 ? 0 : Math.min((g.W * 0.62) / (g.n - 1), g.bw * 2.5);
    for (let i = 0; i < g.n; i++) {
      const y = (i - (g.n - 1) / 2) * gap;
      rod(q, L2 * 0.3, y, L2 + g.bl, y, g.bw, BARREL, g.h * 0.85);
      // the muzzle
      if (fine(q, 2)) fillShape(c, oval(L2 + g.bl - g.bw * 0.2, y, g.bw * 0.3, g.bw * 0.55), css(darken(BARREL, 0.5)));
    }
    if (fine(q, 1.4)) for (let i = 0; i < g.n; i++) fillShape(c, box(L2 * 1.02, (i - (g.n - 1) / 2) * gap, g.bw * 0.7, g.bw * 0.72, g.bw * 0.35), css(hexCol('#5a5446')));
    const house = houseShape(g.L, g.W);
    block(q, house, GUNHOUSE, g.h, 0, 0, Math.max(L2, W2), { k: 0.26 });
    rim(q, house, GUNHOUSE, 0.55);
    if (g.range) rod(q, -L2 * 0.42, -W2 - 0.55, -L2 * 0.42, W2 + 0.55, Math.max(0.42, g.W * 0.11), darken(GUNHOUSE, 0.12), 0.35);
    if (fine(q, 1.6)) {
      fillShape(c, oval(-L2 * 0.05, -W2 * 0.5, g.W * 0.08, g.W * 0.08), css(darken(GUNHOUSE, 0.35)));
      fillShape(c, oval(-L2 * 0.05, W2 * 0.5, g.W * 0.08, g.W * 0.08), css(darken(GUNHOUSE, 0.35)));
    }
  });
}

/** The owner's colour on a gun house roof (inside its edge, so the edge and its shading stay). */
function turretRoof(p: Paint, g: Gun, t: Tones): void {
  turn(p, g.x, 0, g.rot, (q) => {
    const s = houseShape(g.L * 0.84, g.W * 0.8, -g.L * 0.03);
    fillShape(q.ctx, s, litGrad(q, t.base, 0, 0, Math.max(g.L, g.W) * 0.5, 0.24));
    strokeShape(q.ctx, s, css(t.deep, 0.55), hair(q, 0.8));
    if (g.range) rod(q, -g.L * 0.21, -g.W / 2 - 0.55, -g.L * 0.21, g.W / 2 + 0.55, Math.max(0.42, g.W * 0.11), darken(GUNHOUSE, 0.12), 0);
  });
}

/** A deckhouse, bridge or superstructure tier: a raised block with a lit roof, its edge and windows forward. */
function house(p: Paint, cx: number, cy: number, hw: number, hh: number, h: number, col: Col, r = 0.5, windows = false): Shape {
  const s = box(cx, cy, hw, hh, r);
  block(p, s, col, h, cx, cy, Math.max(hw, hh));
  rim(p, s, col, 0.5);
  if (windows && fine(p, 1.5)) fillShape(p.ctx, box(cx + hw - 0.22, cy, 0.12, hh * 0.78, 0.05), css(hexCol('#20282e'), 0.9));
  return s;
}

/** A funnel `h` tall, its cap raked aft by `rake`, soot inside. */
function funnel(p: Paint, x: number, y: number, rx: number, ry: number, h: number, col: Col, rake = 0, capCol: Col = SOOT): void {
  const c = p.ctx;
  castShadow(p, oval(x, y, rx, ry), h, 0.38);
  const x0 = Math.min(x, x - rake);
  const x1 = Math.max(x, x - rake);
  const body: Shape = (k) => {
    k.moveTo(x1, y - ry);
    k.ellipse(x1, y, rx, ry, 0, -Math.PI / 2, Math.PI / 2);
    k.lineTo(x0, y + ry);
    k.ellipse(x0, y, rx, ry, 0, Math.PI / 2, (Math.PI * 3) / 2);
    k.closePath();
  };
  fillShape(c, body, cylGrad(p, col, x, y, 1, 0, ry, 0.3));
  edge(p, body, col);
  const tx = x - rake;
  fillShape(c, oval(tx, y, rx, ry), css(lighten(col, 0.12)));
  const soot = c.createRadialGradient(tx, y, 0, tx, y, Math.max(rx, ry) * 0.75);
  soot.addColorStop(0, css(darken(capCol, 0.6)));
  soot.addColorStop(1, css(capCol));
  fillShape(c, oval(tx, y, rx * 0.74, ry * 0.7), soot);
}

/** A mast `h` tall at (x, y): its long thin shadow, a yard across and the top. */
function mast(p: Paint, x: number, y: number, h: number, yard: number): void {
  const c = p.ctx;
  const [sx, sy] = shadowAt(p, h);
  c.beginPath();
  c.moveTo(x, y);
  c.lineTo(x + sx, y + sy);
  c.lineWidth = 0.32;
  c.strokeStyle = 'rgba(8,10,12,0.3)';
  c.lineCap = 'round';
  c.stroke();
  if (yard > 0) {
    c.beginPath();
    c.moveTo(x + sx * 0.8, y + sy * 0.8 - yard);
    c.lineTo(x + sx * 0.8, y + sy * 0.8 + yard);
    c.lineWidth = 0.22;
    c.stroke();
    rod(p, x, y - yard, x, y + yard, 0.26, darken(HAZE, 0.25));
  }
  c.lineCap = 'butt';
  fillShape(c, oval(x, y, 0.34, 0.34), domeGrad(p, darken(HAZE, 0.1), x, y, 0.34));
}

/** A ship's boat or a liferaft. */
function boat(p: Paint, x: number, y: number, l: number, w: number, col = BOAT, h = 0.5): void {
  const s: Shape = (c) => {
    c.moveTo(x + l, y);
    c.bezierCurveTo(x + l * 0.6, y - w, x - l, y - w, x - l, y);
    c.bezierCurveTo(x - l, y + w, x + l * 0.6, y + w, x + l, y);
    c.closePath();
  };
  block(p, s, col, h, x, y, l);
  if (fine(p, 2)) fillShape(p.ctx, oval(x - l * 0.1, y, l * 0.55, w * 0.45), css(darken(col, 0.25)));
}

/** A quad anti-aircraft mount in its round tub (Naval Mastery). */
function aaMount(p: Paint, x: number, y: number, aim: number): void {
  const tub = oval(x, y, 0.82, 0.82);
  block(p, tub, darken(HAZE, 0.06), 0.55, x, y, 0.8);
  fillShape(p.ctx, oval(x, y, 0.52, 0.52), css(darken(HAZE, 0.42)));
  const c = Math.cos(aim);
  const s = Math.sin(aim);
  for (const off of [-0.32, -0.11, 0.11, 0.32]) rod(p, x - s * off, y + c * off, x - s * off + c * 1.45, y + c * off + s * 1.45, 0.14, BARREL, 0.7);
}

/** A radar array on a mast (Naval Mastery). */
function radar(p: Paint, x: number, y: number, w: number, h: number): void {
  rod(p, x, y - w, x, y + w, 0.42, darken(HAZE, 0.3), h);
  if (fine(p)) linesY(p, box(x, y, 0.21, w, 0.05), x - 0.21, x + 0.21, y - w, y + w, 0.14, css(hexCol('#c8ced2'), 0.6), 0.04);
}

/** A sea mine on its rail: a dark sphere with horns (Naval Mines). */
function seaMine(p: Paint, x: number, y: number, r = 0.62): void {
  const c = p.ctx;
  castShadow(p, oval(x, y, r, r), 0.5, 0.35);
  fillShape(c, oval(x, y, r, r), domeGrad(p, hexCol('#2d3134'), x, y, r));
  if (fine(p, 1.8)) for (let k = 0; k < 5; k++) fillShape(c, oval(x + Math.cos(k * 1.256) * r * 0.8, y + Math.sin(k * 1.256) * r * 0.8, 0.1, 0.1), css(hexCol('#8c8f88')));
}

function mineRails(p: Paint, x: number, half: number): void {
  for (const y of [-half, half]) {
    rod(p, x + 1.6, y, x - 1.4, y, 0.18, darken(HAZE, 0.35));
    seaMine(p, x + 0.9, y);
    seaMine(p, x - 0.6, y);
  }
}

/** A small floatplane on the catapult (top view). */
function floatplane(p: Paint, x: number, y: number, s: number): void {
  const col = hexCol('#7d8a8f');
  rod(p, x - 1.2 * s, y, x + 1.3 * s, y, 0.42 * s, col, 0.6);
  rod(p, x + 0.35 * s, y - 1.7 * s, x + 0.35 * s, y + 1.7 * s, 0.55 * s, col, 0.6);
  rod(p, x - 1.05 * s, y - 0.65 * s, x - 1.05 * s, y + 0.65 * s, 0.3 * s, col, 0.5);
}

// ------------------------------------------------------------------------------------------------- ships

interface ShipPlan {
  hull: Hull;
  guns: Gun[];
  paint(p: Paint, mods: number): void;
  /** owner marks beyond the turret roofs, inside ownerBox [x0, y0, x1, y1] */
  ownerPaint?(p: Paint, t: Tones): void;
  ownerBox?: readonly [number, number, number, number];
  /** salvo guns (fx) as turret positions */
  salvo: (readonly [number, number])[];
}

const BB_GUNS: Gun[] = [
  { x: 10.6, rot: 0, L: 5, W: 4.2, h: 1.5, n: 3, bl: 4.8, bw: 0.48, range: true },
  { x: 5.6, rot: 0, L: 5, W: 4.2, h: 2.7, n: 3, bl: 5.3, bw: 0.48, own: true, range: true },
  { x: -12, rot: Math.PI, L: 5, W: 4.2, h: 1.6, n: 3, bl: 4.8, bw: 0.48, own: true, range: true },
];

/** Twin secondary mounts down both sides, trained out a little forward of the beam. */
function secondaries(p: Paint, xs: readonly number[], y: number): void {
  for (const x of xs)
    for (const sd of [-1, 1])
      turn(p, x, sd * y, sd * 1.1, (q) => {
        const g: Gun = { x: 0, rot: 0, L: 1.55, W: 1.3, h: 0.9, n: 2, bl: 1.35, bw: 0.22 };
        gunTurret(q, g);
      });
}

const BB_SECONDARY = [1.6, -1, -3.6, -6.2];

const battleship: ShipPlan = {
  hull: { hl: 20, hb: 4.3, bow: 9.5, stern: 4.5, sb: 0 },
  guns: BB_GUNS,
  salvo: [
    [10.6, 0],
    [5.6, 0],
    [-12, 0],
  ],
  paint(p, mods) {
    const c = p.ctx;
    const h = this.hull;
    const s = paintHull(p, h, TEAK, darken(HAZE, 0.35), 11, { planks: 'rgba(62,46,30,0.33)' });
    c.save();
    c.beginPath();
    s(c);
    c.clip();
    fillShape(c, box(18, 0, 3, 5, 0), litGrad(p, STEEL_DECK, 18, 0, 3, 0.1));
    fillShape(c, box(-18.6, 0, 1.9, 5, 0), litGrad(p, STEEL_DECK, -18.5, 0, 3, 0.1));
    c.restore();
    for (const y of [-0.62, 0.62]) {
      rod(p, 19.2, y * 0.6, 16.6, y, 0.2, hexCol('#2f3336'));
      fillShape(c, oval(16.4, y, 0.38, 0.38), domeGrad(p, STEEL_DECK, 16.4, y, 0.38));
    }
    strokeShape(c, polyShape([14.6, -2.9, 15.8, 0, 14.6, 2.9]), css(lighten(HAZE, 0.2)), 0.32);
    // superstructure: the base deckhouse, a second tier, the tower bridge with its director, the funnel, aft house
    house(p, -2.5, 0, 5.2, 2.55, 1.2, HAZE, 0.9);
    secondaries(p, BB_SECONDARY, 3.05);
    house(p, -0.7, 0, 2.9, 1.95, 2.3, HAZE, 0.7);
    funnel(p, -3.4, 0, 1.55, 1.25, 4.4, HAZE, 0.45);
    house(p, 1.2, 0, 1.5, 1.6, 5.2, HAZE, 0.7, true);
    fillShape(c, oval(0.9, 0, 0.85, 0.85), domeGrad(p, GUNHOUSE, 0.9, 0, 0.85));
    rod(p, 0.9, -1.5, 0.9, 1.5, 0.34, darken(HAZE, 0.2), 0.5);
    house(p, -7.4, 0, 1.2, 1.6, 2, HAZE, 0.6);
    boat(p, -5.6, -1.3, 1.0, 0.42);
    boat(p, -5.6, 1.3, 1.0, 0.42);
    mast(p, -7.4, 0, 6.5, 1.5);
    if (mods & M_MASTERY) {
      for (const [x, y] of [
        [2.3, -2.3],
        [2.3, 2.3],
        [-4.9, -2.3],
        [-4.9, 2.3],
        [-8.5, -2.5],
        [-8.5, 2.5],
      ])
        aaMount(p, x, y, y < 0 ? -1.2 : 1.2);
      radar(p, 1.35, 0, 1.25, 6);
    }
    // a crane and the boats' davits on the quarterdeck
    rod(p, -15.2, 3.0, -16.8, 1.8, 0.3, darken(HAZE, 0.2), 1.6);
    fillShape(c, oval(-15.2, 3.0, 0.4, 0.4), domeGrad(p, HAZE, -15.2, 3.0, 0.4));
    if (mods & M_SPECIAL) mineRails(p, -17.2, 1.9);
    for (const g of BB_GUNS) gunTurret(p, g);
  },
};

const CR_GUNS: Gun[] = [
  { x: 8.2, rot: 0, L: 3.7, W: 3.1, h: 1.3, n: 2, bl: 3.6, bw: 0.38, own: true, range: true },
  { x: -9.4, rot: Math.PI, L: 3.7, W: 3.1, h: 1.3, n: 2, bl: 3.6, bw: 0.38, own: true, range: true },
];

const cruiser: ShipPlan = {
  hull: { hl: 15, hb: 3.15, bow: 7, stern: 3.4, sb: 0 },
  guns: CR_GUNS,
  salvo: [
    [8.2, 0],
    [-9.4, 0],
  ],
  paint(p, mods) {
    const c = p.ctx;
    const s = paintHull(p, this.hull, STEEL_DECK, darken(HAZE, 0.35), 23, { planks: 'rgba(30,34,38,0.25)' });
    void s;
    for (const y of [-0.5, 0.5]) {
      rod(p, 14.2, y * 0.5, 12.2, y, 0.17, hexCol('#2d3134'));
      fillShape(c, oval(12, y, 0.3, 0.3), domeGrad(p, STEEL_DECK, 12, y, 0.3));
    }
    house(p, 0.4, 0, 4.4, 2.05, 1.1, HAZE, 0.7);
    house(p, 3.2, 0, 1.55, 1.55, 3.2, HAZE, 0.6, true);
    fillShape(c, oval(2.9, 0, 0.62, 0.62), domeGrad(p, GUNHOUSE, 2.9, 0, 0.62));
    funnel(p, 0.4, 0, 1.15, 0.95, 3.6, HAZE, 0.3);
    funnel(p, -2.4, 0, 1.15, 0.95, 3.4, HAZE, 0.3);
    mast(p, 1.9, 0, 5.2, 1.3);
    boat(p, -1, -1.75, 0.9, 0.36);
    boat(p, -1, 1.75, 0.9, 0.36);
    // the catapult and its floatplane amidships, the crane beside it
    rod(p, -4.7, -1.9, -4.7, 1.9, 0.38, darken(HAZE, 0.25), 0.3);
    floatplane(p, -4.7, 0, 0.75);
    rod(p, -6.2, -1.9, -5.4, -0.7, 0.26, darken(HAZE, 0.2), 1.4);
    if (mods & M_MASTERY) {
      for (const [x, y] of [
        [5.2, -1.95],
        [5.2, 1.95],
        [-6.6, -1.9],
        [-6.6, 1.9],
      ])
        aaMount(p, x, y, y < 0 ? -1.2 : 1.2);
      radar(p, 2.0, 0, 1.05, 5.4);
    }
    if (mods & M_SPECIAL) mineRails(p, -12.6, 1.25);
    for (const g of CR_GUNS) gunTurret(p, g);
  },
};

const DD_GUN: Gun = { x: 7.4, rot: 0, L: 2.5, W: 2.1, h: 1.1, n: 1, bl: 2.6, bw: 0.34, own: true };

const destroyer: ShipPlan = {
  hull: { hl: 12, hb: 2.05, bow: 6, stern: 1.6, sb: 1.25 },
  guns: [DD_GUN],
  salvo: [
    [7.4, 0],
    [7.4, 0],
  ],
  paint(p, mods) {
    const c = p.ctx;
    paintHull(p, this.hull, hexCol('#646b70'), darken(HAZE, 0.32), 37, { planks: 'rgba(30,34,38,0.2)' });
    rod(p, 11.3, 0, 9.8, 0, 0.16, hexCol('#2d3134'));
    house(p, 3.9, 0, 1.6, 1.45, 2.2, HAZE, 0.55, true);
    fillShape(c, oval(3.6, 0, 0.55, 0.55), domeGrad(p, GUNHOUSE, 3.6, 0, 0.55));
    mast(p, 2.2, 0, 4.4, 1.0);
    // the raked funnel and the two sets of torpedo tubes trained a little off the centre line
    funnel(p, 0.6, 0, 1.25, 0.82, 3.2, HAZE, 1.1);
    for (const tx of [-3.5, -6.7]) {
      turn(p, tx, 0, tx < -5 ? -0.2 : 0.2, (q) => {
        fillShape(q.ctx, oval(0, 0, 0.8, 0.8), domeGrad(q, darken(HAZE, 0.15), 0, 0, 0.8));
        for (const off of [-0.5, -0.17, 0.17, 0.5]) rod(q, -1.45, off, 1.55, off, 0.28, hexCol('#5b6368'), 0.7);
      });
    }
    if (mods & M_SPECIAL) mineRails(p, -9.8, 0.9);
    else
      // depth charge racks at the stern
      for (const y of [-0.85, 0.85]) {
        rod(p, -9.2, y, -11.5, y, 0.32, darken(HAZE, 0.3), 0.3);
        if (fine(p, 1.5)) for (let k = 0; k < 4; k++) fillShape(c, oval(-9.5 - k * 0.6, y, 0.25, 0.25), domeGrad(p, hexCol('#3d4245'), -9.5 - k * 0.6, y, 0.25));
      }
    if (mods & M_MASTERY) {
      aaMount(p, -0.9, -1.6, -1.3);
      aaMount(p, -0.9, 1.6, 1.3);
      radar(p, 2.2, 0, 0.9, 4.6);
    }
    gunTurret(p, DD_GUN);
  },
};

const submarine: ShipPlan = {
  hull: { hl: 13, hb: 1.85, bow: 6.5, stern: 5.5, sb: 0 },
  ownerBox: [-0.6, -1.2, 3.8, 1.2],
  guns: [],
  salvo: [
    [1.6, 0],
    [1.6, 0],
  ],
  paint(p, mods) {
    const c = p.ctx;
    const h = this.hull;
    // the pressure hull under the water: dark, seen through the sea, its edge lost in it
    const s = hullShape(h);
    c.save();
    c.globalAlpha = 0.62;
    fillShape(c, s, cylGrad(p, hexCol('#1d2a30'), 0, 0, 1, 0, h.hb, 0.22));
    c.restore();
    strokeShape(c, s, 'rgba(12,22,28,0.35)', hair(p, 1.6));
    // the deck casing above the water and the sea washing along it
    const deck = box(1.2, 0, 9.4, 0.62, 0.6);
    fillShape(c, deck, litGrad(p, SUB_DECK, 1.2, 0, 4, 0.12));
    linesY(p, deck, -8, 10.6, -0.62, 0.62, 0.55, 'rgba(10,12,14,0.35)', 0.05);
    edge(p, deck, SUB_DECK);
    for (const sd of [-1, 1]) {
      c.beginPath();
      c.moveTo(10.6, sd * 0.5);
      c.bezierCurveTo(8, sd * 0.95, 3, sd * 1.05, -8.2, sd * 0.78);
      c.lineWidth = 0.3;
      c.strokeStyle = 'rgba(226,238,242,0.6)';
      c.stroke();
    }
    // the conning tower (sail): streamlined, its bridge open on top, periscopes standing out of it
    const sail: Shape = (k) => {
      k.moveTo(4.1, 0);
      k.bezierCurveTo(3.6, -0.95, 0.6, -1.0, -1.1, -0.72);
      k.bezierCurveTo(-1.8, -0.5, -1.8, 0.5, -1.1, 0.72);
      k.bezierCurveTo(0.6, 1.0, 3.6, 0.95, 4.1, 0);
      k.closePath();
    };
    block(p, sail, SUB_HULL, 2.4, 1.4, 0, 2.6, { k: 0.3 });
    rim(p, sail, SUB_HULL, 0.5);
    fillShape(c, box(2.4, 0, 1.0, 0.45, 0.4), css(hexCol('#101315')));
    for (const x of [0.6, -0.2]) fillShape(c, oval(x, 0, 0.22, 0.22), domeGrad(p, hexCol('#4a5155'), x, 0, 0.22));
    if (mods & M_MASTERY) {
      // a deck gun forward and an AA gun on the sail's after platform, a radar mast
      turn(p, 6.6, 0, 0, (q) => {
        rod(q, 0, 0, 2.2, 0, 0.26, BARREL, 0.6);
        fillShape(q.ctx, oval(0, 0, 0.5, 0.5), domeGrad(q, SUB_DECK, 0, 0, 0.5));
      });
      aaMount(p, -1.3, 0, Math.PI);
      fillShape(c, oval(-0.9, 0, 0.18, 0.18), css(hexCol('#8a9094')));
    }
    if (mods & M_SPECIAL) {
      seaMine(p, -6.6, 0, 0.5);
      seaMine(p, -7.7, 0, 0.5);
    }
  },
  ownerPaint(p, t) {
    const c = p.ctx;
    const band = box(1.0, 0, 0.62, 0.82, 0.2);
    c.save();
    c.beginPath();
    c.moveTo(4.1, 0);
    c.bezierCurveTo(3.6, -0.95, 0.6, -1.0, -1.1, -0.72);
    c.bezierCurveTo(-1.8, -0.5, -1.8, 0.5, -1.1, 0.72);
    c.bezierCurveTo(0.6, 1.0, 3.6, 0.95, 4.1, 0);
    c.clip();
    fillShape(c, band, litGrad(p, t.base, 1, 0, 1, 0.2));
    fillShape(c, box(3.0, 0, 0.42, 0.9, 0.15), litGrad(p, t.base, 3, 0, 1, 0.2));
    c.restore();
  },
};

const carrier: ShipPlan = {
  hull: { hl: 23, hb: 3.7, bow: 8.5, stern: 3, sb: 2.6 },
  ownerBox: [12.4, -2.6, 18, 2.6],
  guns: [],
  salvo: [
    [0, 4.4],
    [0, 4.4],
  ],
  paint(p, mods) {
    const c = p.ctx;
    const h = this.hull;
    // the hull shows only at the bow and the stern, under the overhanging flight deck
    paintHull(p, h, darken(HAZE, 0.05), darken(HAZE, 0.38), 51);
    const deck: Shape = (k) => {
      k.moveTo(20.4, -2.7);
      k.bezierCurveTo(21.3, -2.1, 21.6, -1.0, 21.6, 0);
      k.bezierCurveTo(21.6, 1.0, 21.3, 2.1, 20.4, 2.7);
      k.lineTo(17.5, 4.5);
      k.lineTo(-21.6, 4.5);
      k.lineTo(-22.2, 3.6);
      k.lineTo(-22.2, -3.6);
      k.lineTo(-21.6, -4.5);
      k.lineTo(17.5, -4.5);
      k.closePath();
    };
    castShadow(p, deck, 0.9, 0.35);
    fillShape(c, deck, litGrad(p, CARRIER_DECK, 0, 0, 16, 0.06));
    linesX(p, deck, -22.2, 21.6, -4.4, 4.4, 0.38, 'rgba(18,22,26,0.28)', 0.05);
    grime(p, deck, -21, -4.2, 20, 4.2, 52, 40, hexCol('#2c3236'), 0.18, 0.6);
    // tyre marks down the landing area
    if (fine(p)) grime(p, box(-12, 0, 8, 1.6, 0), -20, -1.6, -4, 1.6, 53, 24, hexCol('#24292c'), 0.22, 0.35);
    edge(p, deck, CARRIER_DECK, 1.2);
    rim(p, deck, CARRIER_DECK, 0.35);
    // three lifts, slightly lighter, with their seams
    for (const x of [12.5, -1.5, -14.5]) {
      const lift = box(x, 0, 1.9, 1.9, 0.1);
      fillShape(c, lift, css(lighten(CARRIER_DECK, 0.06)));
      strokeShape(c, lift, 'rgba(14,16,18,0.6)', hair(p, 0.8));
    }
    // deck lines: a dashed centre line, the edge lines, the landing stripes aft and the bow's deck number
    c.save();
    c.setLineDash([1.6, 1.2]);
    strokeShape(c, (k) => {
      k.moveTo(19.5, 0);
      k.lineTo(-20.5, 0);
    }, 'rgba(236,236,228,0.85)', 0.24);
    c.setLineDash([]);
    c.restore();
    for (const y of [-4.05, 4.05]) strokeShape(c, (k) => {
      k.moveTo(17.2, y);
      k.lineTo(-21.2, y);
    }, 'rgba(236,236,228,0.6)', 0.18);
    for (let k = 0; k < 4; k++) fillShape(c, box(-20.4 + k * 0.9, -2.4, 0.18, 0.9, 0), 'rgba(236,236,228,0.8)');
    for (let k = 0; k < 4; k++) fillShape(c, box(-20.4 + k * 0.9, 2.4, 0.18, 0.9, 0), 'rgba(236,236,228,0.8)');
    // the island on the starboard edge: its block, funnel, mast and radar
    const isl = house(p, -0.6, 4.9, 3.4, 0.85, 3.6, HAZE, 0.5, true);
    void isl;
    house(p, 0.6, 4.9, 1.4, 0.7, 5, HAZE, 0.4);
    funnel(p, -2.4, 5.0, 1.15, 0.72, 5.2, HAZE, 0.5);
    mast(p, 0.9, 4.9, 6.4, 0.9);
    // AA galleries along both sides
    for (const x of [15, 8, -8, -16]) {
      fillShape(c, box(x, -4.75, 1.2, 0.32, 0.1), css(darken(HAZE, 0.1)));
      if (fine(p, 1.4)) for (const d of [-0.6, 0, 0.6]) rod(p, x + d, -4.8, x + d + 0.3, -5.3, 0.14, BARREL, 0.3);
    }
    if (mods & M_MASTERY) {
      for (const [x, y] of [
        [10, -5.1],
        [3, -5.1],
        [-5, -5.1],
        [6, 5.3],
        [-6.6, 5.3],
      ])
        aaMount(p, x, y, y < 0 ? -1.4 : 1.4);
      radar(p, 0.9, 4.9, 1.0, 6.6);
    }
    if (mods & M_SPECIAL) mineRails(p, -19.6, 1.2);
    // the planes parked aft, wings folded, in two rows (and two more forward when the air group is stronger)
    const spots: [number, number][] = [
      [-10.2, -2.3],
      [-10.2, 0],
      [-10.2, 2.3],
      [-13.4, -2.3],
      [-13.4, 0],
      [-13.4, 2.3],
      [-16.6, -1.2],
      [-16.6, 1.2],
    ];
    if (mods & M_MASTERY) spots.push([6.6, -2.4], [6.6, 0]);
    for (const [x, y] of spots) parkedPlane(p, x, y);
  },
  ownerPaint(p, t) {
    // the recognition roundel near the bow end of the flight deck
    const c = p.ctx;
    fillShape(c, oval(15.2, 0, 2.3, 2.3), css(hexCol('#e9e9e2'), 0.9));
    fillShape(c, oval(15.2, 0, 1.9, 1.9), litGrad(p, t.base, 15.2, 0, 1.9, 0.2));
    strokeShape(c, oval(15.2, 0, 1.9, 1.9), css(t.deep, 0.5), hair(p, 0.7));
  },
};

/** A small carrier plane parked with its wings folded up (top view). */
function parkedPlane(p: Paint, x: number, y: number): void {
  const col = hexCol('#55697a');
  const c = p.ctx;
  const body: Shape = (k) => {
    k.moveTo(x + 1.3, y);
    k.bezierCurveTo(x + 1.2, y - 0.42, x - 1.1, y - 0.3, x - 1.3, y);
    k.bezierCurveTo(x - 1.1, y + 0.3, x + 1.2, y + 0.42, x + 1.3, y);
    k.closePath();
  };
  // folded wings: two short stubs and the folded panels lying back along the body
  const wings = polyShape([x + 0.5, y - 1.1, x + 0.9, y - 1.1, x + 0.9, y + 1.1, x + 0.5, y + 1.1]);
  block(p, wings, col, 0.4, x + 0.7, y, 1);
  block(p, body, col, 0.5, x, y, 1.2, { k: 0.3 });
  rod(p, x - 1.1, y - 0.55, x - 1.1, y + 0.55, 0.2, col, 0.3);
  if (fine(p, 2)) fillShape(c, oval(x + 0.25, y, 0.3, 0.18), css(hexCol('#1f2a33')));
}

const transport: ShipPlan = {
  hull: { hl: 12, hb: 3.4, bow: 3.2, stern: 1.4, sb: 2.9, blunt: true },
  ownerBox: [9.4, -2.5, 11.6, 2.5],
  guns: [],
  salvo: [
    [0, 0],
    [0, 0],
  ],
  paint(p, mods) {
    void mods;
    const c = p.ctx;
    paintHull(p, this.hull, LST, darken(LST, 0.45), 61, { grimeCol: hexCol('#3b3f39') });
    // the bow ramp: a ribbed plate across the bow with its hinge
    const ramp = box(10.5, 0, 1.05, 2.25, 0.3);
    block(p, ramp, lighten(LST, 0.05), 0.3, 10.5, 0, 1.2);
    linesY(p, ramp, 9.6, 11.4, -2.2, 2.2, 0.36, 'rgba(20,24,20,0.35)', 0.06);
    // the open tank deck, recessed, full of troops in rows and a jeep
    const well = box(2.6, 0, 6.9, 2.55, 0.5);
    fillShape(c, well, litGrad(p, LST_DECK, 2.6, 0, 6, 0.06));
    innerShade(p, well, 0.55, 0.55);
    strokeShape(c, well, css(darken(LST, 0.35)), hair(p, 1));
    // a jeep near the ramp
    turn(p, 7.7, -1.25, 0, (q) => {
      block(q, box(0, 0, 1.15, 0.62, 0.2), OLIVE, 0.6, 0, 0, 1.1);
      fillShape(q.ctx, box(0.25, 0, 0.18, 0.5, 0.05), css(hexCol('#2a3036')));
    });
    // crates
    for (const [x, y] of [
      [7.6, 1.4],
      [6.7, 1.4],
    ])
      block(p, box(x, y, 0.4, 0.5, 0.06), hexCol('#7a6a48'), 0.5, x, y, 0.5);
    for (let col = 0; col < 7; col++) {
      for (let row = 0; row < 5; row++) {
        const x = -3.6 + col * 1.3 + (row % 2) * 0.35;
        const y = -2.0 + row * 1.0;
        if (x > 6 && y < -0.2) continue;
        if (x > 6.2 && y > 0.7) continue;
        const jx = (rnd(71, col * 9 + row) - 0.5) * 0.25;
        const jy = (rnd(72, col * 9 + row) - 0.5) * 0.25;
        // a soldier from above: shoulders and pack, the helmet on top
        fillShape(c, oval(x + jx - 0.05, y + jy, 0.3, 0.44), css(hexCol('#4a4f35')));
        fillShape(c, oval(x + jx + 0.05, y + jy, 0.3, 0.3), domeGrad(p, HELMET, x + jx + 0.05, y + jy, 0.3, 0.45));
      }
    }
    // the bridge block aft, a small funnel, a mast and the boats
    house(p, -8.3, 0, 2.6, 2.6, 2.6, LST, 0.6, true);
    house(p, -7.4, 0, 1.1, 1.6, 3.8, lighten(LST, 0.04), 0.4, true);
    funnel(p, -9.6, 1.2, 0.6, 0.55, 3.4, LST, 0.2);
    mast(p, -7.6, -1.2, 5, 0.8);
    boat(p, -9.6, -2.95, 0.95, 0.38, BOAT, 0.4);
    boat(p, -9.6, 2.95, 0.95, 0.38, BOAT, 0.4);
    for (const y of [-3.05, 3.05]) fillShape(c, box(-5.2, y, 0.7, 0.25, 0.1), css(RAFT));
  },
  ownerPaint(p, t) {
    const c = p.ctx;
    const band = box(10.5, 0, 0.62, 2.0, 0.2);
    fillShape(c, band, litGrad(p, t.base, 10.5, 0, 1.5, 0.22));
    strokeShape(c, band, css(t.deep, 0.5), hair(p, 0.7));
  },
};

const HOLDS = [9.4, 5.0, 0.6, -3.8];

const tradeShip: ShipPlan = {
  hull: { hl: 16, hb: 2.95, bow: 6.2, stern: 2.6, sb: 1.4 },
  ownerBox: [-13.4, -1.6, -9.0, 1.6],
  guns: [],
  salvo: [
    [0, 0],
    [0, 0],
  ],
  paint(p, mods) {
    void mods;
    const c = p.ctx;
    const s = paintHull(p, this.hull, MERCH_DECK, MERCH, 81, { grimeCol: hexCol('#4a3a2c') });
    // red oxide forecastle and poop deck
    c.save();
    c.beginPath();
    s(c);
    c.clip();
    fillShape(c, box(14.5, 0, 2.6, 4, 0), litGrad(p, OXIDE, 14, 0, 3, 0.1));
    fillShape(c, box(-14.8, 0, 2.2, 4, 0), litGrad(p, OXIDE, -14.5, 0, 3, 0.1));
    c.restore();
    strokeShape(c, (k) => {
      k.moveTo(11.9, -2.4);
      k.lineTo(11.9, 2.4);
    }, css(darken(OXIDE, 0.4)), 0.25);
    for (const y of [-0.5, 0.5]) rod(p, 15.4, y * 0.5, 13.4, y, 0.17, hexCol('#2a2a2a'));
    // holds 1 and 3: closed hatch covers; holds 2 and 4: container stacks
    HOLDS.forEach((x, i) => {
      if (i % 2 === 0) {
        const hc = box(x, 0, 1.75, 2.05, 0.15);
        block(p, hc, HATCH, 0.45, x, 0, 1.8);
        linesY(p, hc, x - 1.75, x + 1.75, -2.05, 2.05, 0.58, 'rgba(18,22,18,0.45)', 0.06);
      } else {
        for (let cx = 0; cx < 2; cx++)
          for (let cy = 0; cy < 3; cy++) {
            const col = CONTAINERS[Math.floor(rnd(83 + i, cx * 3 + cy) * CONTAINERS.length)];
            const bx = x - 0.9 + cx * 1.8;
            const by = -1.38 + cy * 1.38;
            const hgt = 0.7 + Math.floor(rnd(84 + i, cx * 3 + cy) * 2) * 0.7;
            const cs = box(bx, by, 0.86, 0.65, 0.06);
            block(p, cs, col, hgt, bx, by, 0.9, { k: 0.18 });
            linesY(p, cs, bx - 0.86, bx + 0.86, by - 0.65, by + 0.65, 0.2, css(darken(col, 0.35), 0.5), 0.04);
          }
      }
    });
    // derricks: yellow kingposts between the holds, their booms lying over the hatches
    for (const [x, aim] of [
      [7.2, 1],
      [-1.6, -1],
    ] as const) {
      for (const y of [-1.25, 1.25]) {
        rod(p, x, y, x + aim * 3.2, y * 0.55, 0.22, KINGPOST, 1.0);
        fillShape(c, oval(x, y, 0.36, 0.36), domeGrad(p, KINGPOST, x, y, 0.36));
      }
      rod(p, x, -1.25, x, 1.25, 0.2, KINGPOST, 2.6);
    }
    // the white bridge block aft with its wings and lifeboats
    house(p, -9.8, 0, 2.7, 2.2, 2.2, WHITE_PAINT, 0.5);
    house(p, -8.6, 0, 1.0, 2.75, 3.4, WHITE_PAINT, 0.3, true);
    house(p, -10.4, 0, 1.4, 1.5, 3.6, WHITE_PAINT, 0.4);
    boat(p, -11.4, -2.5, 1.1, 0.42, hexCol('#d4823c'), 0.5);
    boat(p, -11.4, 2.5, 1.1, 0.42, hexCol('#d4823c'), 0.5);
    mast(p, 12.6, 0, 5, 1.1);
    mast(p, -13.6, 0, 4.4, 0.8);
    // the funnel's shadow (the funnel itself is the owner's livery)
    castShadow(p, oval(-11.1, 0, 1.35, 1.15), 5, 0.38);
  },
  ownerPaint(p, t) {
    // the funnel in the owner's colours with a black top
    const c = p.ctx;
    const x = -10.7;
    const rx = 1.35;
    const ry = 1.15;
    const rake = 1.1;
    const body: Shape = (k) => {
      k.moveTo(x, -ry);
      k.ellipse(x, 0, rx, ry, 0, -Math.PI / 2, Math.PI / 2);
      k.lineTo(x - rake, ry);
      k.ellipse(x - rake, 0, rx, ry, 0, Math.PI / 2, (Math.PI * 3) / 2);
      k.closePath();
    };
    fillShape(c, body, cylGrad(p, t.base, x, 0, 1, 0, ry, 0.3));
    edge(p, body, t.dark);
    // a band of the owner's lighter tone, then the black top with its soot
    fillShape(c, oval(x - rake * 0.55, 0, rx, ry), cylGrad(p, t.light, x, 0, 1, 0, ry, 0.2));
    fillShape(c, oval(x - rake * 0.7, 0, rx, ry), cylGrad(p, t.base, x, 0, 1, 0, ry, 0.3));
    fillShape(c, oval(x - rake, 0, rx, ry), css(hexCol('#26272a')));
    fillShape(c, oval(x - rake, 0, rx * 0.68, ry * 0.62), css(hexCol('#0e0f10')));
  },
};

const PLANS: Partial<Record<SpriteKey, ShipPlan>> = { warship: cruiser, destroyer, battleship, submarine, carrier, transport, tradeShip };

// ------------------------------------------------------------------------------------------------- models

/**
 * How much wider than true scale a ship is painted (a miniature's licence: a slim hull would read as a line at the
 * middle zooms). The light is corrected for it, so the shading stays round.
 */
const BEAM = 1.15;

/** Paints in the widened frame: y stretched by BEAM, the light turned back so it still comes from the top left. */
function widened(p: Paint, fn: (q: Paint) => void): void {
  const c = p.ctx;
  c.save();
  c.scale(1, BEAM);
  const lx = p.lx;
  const ly = p.ly / BEAM;
  const n = Math.hypot(lx, ly) || 1;
  fn({ ctx: c, lx: lx / n, ly: ly / n, R: p.R });
  c.restore();
}

const scaleB = (b: Bounds): Bounds => bounds(b.x0, b.y0 * BEAM, b.x1, b.y1 * BEAM);

/** The ship's model: its painted body, its owner marks, its water shadow, its guns. */
export function shipModel(key: SpriteKey, mods: number): UnitModel {
  const plan = PLANS[key] ?? cruiser;
  const h = plan.hull;
  const wide = key === 'carrier' ? 5.6 : h.hb + 1.2;
  const b = scaleB(bounds(-h.hl - 1.5, -wide - 1.8, h.hl + 1.5, wide + 1.8));
  const body: Layer = { b, paint: (p) => widened(p, (q) => plan.paint(q, mods)) };
  const owners: OwnerLayer[] = [];
  for (const g of plan.guns)
    if (g.own) owners.push({ b: scaleB(bounds(g.x - g.L / 2 - 0.4, -g.W / 2 - 1, g.x + g.L / 2 + 0.4, g.W / 2 + 1)), paint: (p, t) => widened(p, (q) => turretRoof(q, g, t)) });
  if (plan.ownerPaint && plan.ownerBox) {
    const ob = plan.ownerBox;
    const op = plan.ownerPaint;
    owners.push({ b: scaleB(bounds(ob[0], ob[1], ob[2], ob[3])), paint: (p, t) => widened(p, (q) => op.call(plan, q, t)) });
  }
  const shape = key === 'carrier' ? box(-0.3, 0, 22, 4.6, 1.2) : hullShape(h);
  const shadow: Layer = {
    b: scaleB(bounds(-h.hl - 3, -wide - 3, h.hl + 3, wide + 3)),
    paint: (p) => widened(p, (q) => softShadow(q, shape, 0, 0, key === 'submarine' ? 0.3 : 0.42, 1.1)),
  };
  return {
    len: h.hl * 2,
    fit: h.hl * 2,
    body,
    owners,
    shadow,
    alt: key === 'submarine' ? 0.5 : 1.2,
    guns: plan.salvo.map(([x, y]) => [x, y * BEAM] as const),
    beam: (key === 'carrier' ? 3.9 : h.hb) * BEAM,
    stern: -h.hl,
  };
}
