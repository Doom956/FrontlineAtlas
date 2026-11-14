// The detailed style's tank models (client only, pure data), rasterized by bake.ts like every other unit model. Model
// units are screen px at mid zoom; the nose points at +u, the right side at +v. The turret is its own model round a
// pivot so it can traverse. All art is original and lives here as code.
//
// Each tank reads by its silhouette first, then its colour:
//   tank division  a classic mid-century medium tank in olive drab: a sloped glacis, a rounded cast turret, a medium
//                  gun, five road wheels a side
//   light tank     small, low and quick, in tan: a short wedge-nosed hull, a small turret set forward with a light
//                  gun and a tall whip aerial, an open engine grille, four road wheels
//   heavy tank     big and boxy, in field grey: a wide long hull with spare track sections on its front plate, a big
//                  square turret set aft, a thick long gun with a muzzle brake, eight road wheels
// Upgrades carry each tank forward:
//   Armor Mastery      the modern main battle tank: a low angular turret with dark cheek armour and a bustle rack, a
//                      long gun with a fume extractor, dark steel side skirts hung over the tracks in plates
//   Deep Raids (light) a raider fit: two fuel drums racked across the back, jerrycans on the fenders, a stowage
//                      rack and a smoke grenade bank on the turret, two tall radio whips
//   Siege Tanks (heavy) an assault gun: a big boxy casemate with a huge short howitzer and a double baffle brake, a
//                      thick add-on plate on the nose and the dozer blade
//   Amphibious Tanks   a pale folded flotation screen round the whole hull, a tall snorkel tube, two propeller
//                      shrouds at the stern
import { M_MASTERY, M_PATH3, M_SPECIAL } from '../shared/keys';
import type { MatId, Part } from './bake';
import type { UnitModel } from './models';
import { box, ell, grown, poly, seg, sym, toned } from './shapes';

// ------------------------------------------------------------------------------------------------- parts

/** Tracks: the run of links with the tread pattern, both sides. */
function tracks(u0: number, u1: number, vIn: number, vOut: number, h: number): Part[] {
  return [box(u0, -vOut, u1, -vIn, 0, h, 'track', { pat: 'tread' }), box(u0, vIn, u1, vOut, 0, h, 'track', { pat: 'tread' })];
}

/** Road wheel hubs along the outside of both tracks (close up only): how many a side tells the tanks apart. */
function wheels(u0: number, u1: number, n: number, vOut: number, h: number): Part[] {
  const out: Part[] = [];
  for (let i = 0; i < n; i++) {
    const u = u0 + ((u1 - u0) * (i + 0.5)) / n;
    for (const s of [-1, 1]) out.push(ell(u, s * (vOut + 0.08), Math.min(0.8, ((u1 - u0) / n) * 0.36), 0.28, 0.2, h * 0.7, 'gun', { tone: 1, sh: 'cyl', minRes: 1.5 }));
  }
  return out;
}

/** Armor Mastery: dark steel side skirts hung over both tracks in `n` plates with gaps (the tread no longer shows). */
function skirtPlates(u0: number, u1: number, vOut: number, h: number, n: number): Part[] {
  const out: Part[] = [];
  const gap = 0.3;
  const w = (u1 - u0 - gap * (n - 1)) / n;
  for (let i = 0; i < n; i++) {
    const a = u0 + i * (w + gap);
    for (const s of [-1, 1]) out.push(box(a, s < 0 ? -vOut - 0.75 : vOut - 0.25, a + w, s < 0 ? -vOut + 0.25 : vOut + 0.75, 0.35, h + 0.35, 'gun', { tone: 2, pat: 'rivets' }));
  }
  return out;
}

/**
 * Amphibious Tanks: the folded flotation screen as a pale rim round the hull top (front, back, both sides), a tall
 * snorkel tube with a dark cap at (su, sv), two propeller shrouds behind the stern at `ub`.
 */
function amphibious(uf: number, ub: number, vh: number, z: number, su: number, sv: number): Part[] {
  const w = 0.8;
  const h = 0.9;
  const zz = z - 0.35;
  return [
    box(ub - w, -vh - w, uf + w, -vh, zz, h, 'canvas', { tone: 1 }),
    box(ub - w, vh, uf + w, vh + w, zz, h, 'canvas', { tone: 1 }),
    box(uf, -vh, uf + w, vh, zz, h, 'canvas', { tone: 1 }),
    box(ub - w, -vh, ub, vh, zz, h, 'canvas', { tone: 1 }),
    // the snorkel: a tall pipe standing up from the engine deck, its dark cap
    ell(su, sv, 0.5, 0.5, z, 4.5, 'gun', { sh: 'cyl', tone: 1 }),
    ell(su, sv, 0.8, 0.8, z + 4.5, 0.35, 'black'),
    // the propeller shrouds sticking out behind
    ell(ub - w - 0.5, -vh * 0.5, 0.65, 0.65, 0.4, 1.1, 'gun', { sh: 'cyl' }),
    ell(ub - w - 0.5, vh * 0.5, 0.65, 0.65, 0.4, 1.1, 'gun', { sh: 'cyl' }),
  ];
}

/**
 * Armor Mastery's turret: the modern main battle tank's low angular turret (`k` its size), dark cheek armour on the
 * pointed front, a bustle rack, a long gun with a fume extractor (a lighter bulge half way along), sights on the roof.
 */
function modernTurret(z: number, m: MatId, k: number, gun: number, bw: number): Part[] {
  const h = 1.5 * k;
  const g0 = 4.6 * k;
  return [
    poly(sym([5.2 * k, -1.1 * k, 3.4 * k, -3.4 * k, -3.4 * k, -3.6 * k, -4.3 * k, -3 * k]), z, h, m),
    // the cheek armour: dark angled plates either side of the gun
    poly(sym([5.2 * k, -1.1 * k, 3.4 * k, -3.4 * k, 2.1 * k, -3.4 * k, 3.8 * k, -1.1 * k]), z + h, 0, m, { tone: -1.5 }),
    // the bustle rack across the back
    box(-5.7 * k, -3 * k, -4.1 * k, 3 * k, z + 0.2 * k, h * 0.85, 'gun', { tone: 1, pat: 'grille' }),
    // the mantlet, the barrel, the fume extractor, the muzzle
    box(4 * k, -0.95 * k, 5.6 * k, 0.95 * k, z + 0.25 * k, h * 0.8, m, { tone: -1 }),
    seg(g0, 0, g0 + gun, 0, bw, z + 0.55 * k, bw * 0.85, 'gun', { sh: 'cyl' }),
    ell(g0 + gun * 0.45, 0, 1 * k, bw * 0.95, z + 0.5 * k, bw * 1.05, 'gun', { sh: 'cyl', tone: 1.5 }),
    ell(g0 + gun - 0.2, 0, 0.35, bw * 0.6, z + 0.55 * k, bw * 0.85, 'gun', { tone: 1 }),
    // the commander's sight box and the gunner's sight, a roof machine gun
    box(-1.6 * k, -2.5 * k, -0.2 * k, -1.2 * k, z + h, 0.8 * k, m, { tone: 1 }),
    box(1.6 * k, 1.1 * k, 2.6 * k, 2 * k, z + h, 0.5 * k, 'glass'),
    seg(-1.4 * k, 1.8 * k, 1 * k, 1.8 * k, 0.35, z + h + 0.3, 0.3, 'gun'),
  ];
}

/**
 * A tank: the hull baked with a soft ground shadow, the turret on its own round its pivot (pu, pv), all drawn `k`
 * times its numbers (the smaller tanks are drawn larger than first laid out so they read at the normal zoom).
 */
function armor(hull: Part[], tur: Part[], pu: number, dust: readonly (readonly [number, number])[], k = 1): UnitModel {
  return {
    model: { parts: grown(hull, k), ground: 0.26 },
    turret: { model: { parts: grown(tur, k), ground: 0.2 }, u: pu * k, v: 0 },
    guns: [],
    props: [],
    nozzles: [],
    alt: 0,
    dust: dust.map(([u, v]) => [u * k, v * k] as const),
  };
}

// ------------------------------------------------------------------------------------------------- tanks

export function mediumTank(mods: number): UnitModel {
  // a classic medium tank in olive drab: tracks, a sloped glacis, the engine deck with grilles and the owner's
  // recognition panel, a rounded cast turret with a medium gun and a commander's cupola
  const m: MatId = 'olive';
  const T = 2.6;
  const hull: Part[] = [
    ...tracks(-8, 8, 3.1, 4.6, 1.9),
    ...wheels(-7.4, 7.4, 5, 4.6, 1.9),
    poly(sym([8.6, -2.4, 7.4, -3.4, -8, -3.4, -8.4, -2.9]), 0.5, 2.1, m),
    // fenders
    box(-8.2, -4.7, 8.2, -3.3, 1.9, 0.25, m, { tone: -1 }),
    box(-8.2, 3.3, 8.2, 4.7, 1.9, 0.25, m, { tone: -1 }),
    // the glacis: a lower, darker sloped plate at the front
    poly(sym([8.6, -2.4, 7.4, -3.4, 5.6, -3.4, 5.6, 0]), T, 0, m, { tone: -1 }),
    box(-7.8, -2.6, -3.6, 2.6, T, 0, m, { pat: 'grille', tone: -1 }),
    box(-5.6, -2.5, -4.2, 2.5, T, 0.12, 'own'),
    // hatches for the driver and the bow gunner, headlights, tools
    ell(6, -1.4, 0.65, 0.6, T, 0.2, m, { tone: 1 }),
    ell(6, 1.4, 0.65, 0.6, T, 0.2, m, { tone: 1 }),
    ell(8.4, -2.9, 0.35, 0.35, 2, 0.4, 'sup'),
    ell(8.4, 2.9, 0.35, 0.35, 2, 0.4, 'sup'),
    seg(-2.8, 2.9, 3.4, 2.9, 0.4, T, 0.2, 'canvas'),
  ];
  if (mods & M_MASTERY) hull.push(...skirtPlates(-7.8, 7.6, 4.6, 1.9, 4));
  if (mods & M_SPECIAL) hull.push(...amphibious(8.4, -8.2, 3.4, T, -6.6, -2.4));
  const tur: Part[] =
    mods & M_MASTERY
      ? modernTurret(T, m, 1, 10.4, 1)
      : [
          ell(0, 0, 4.1, 3.3, T, 2, m, { sh: 'dome' }),
          box(3, -1.5, 4.6, 1.5, 3, 1.4, m, { tone: -1 }),
          seg(4.2, 0, 11.8, 0, 0.95, 3.5, 0.75, 'gun', { sh: 'cyl' }),
          ell(-1.4, -1.3, 1, 1, 4.6, 0.55, m, { sh: 'dome' }),
          ell(-1.4, -1.3, 0.55, 0.55, 5.15, 0, m, { tone: -1 }),
          ell(-1.2, 1.5, 0.6, 0.6, 4.6, 0.12, m, { tone: 1 }),
          seg(-3.1, 1.8, -3.1, 1.8, 0.3, 4.4, 3.6, 'gun'),
        ];
  return armor(hull, tur, 0.6, [
    [-8.2, -3.9],
    [-8.2, 3.9],
  ], 1.1);
}

export function lightTank(mods: number): UnitModel {
  // small, low and quick, in tan: narrow tracks, a short hull with a wedge nose (4 wide at the front), an open
  // engine grille at the back, a small turret set forward with a light gun and a tall whip aerial
  const m: MatId = 'tan';
  const T = 2.1;
  const raid = !!(mods & M_PATH3);
  const hull: Part[] = [
    ...tracks(-6, 6, 2.4, 3.5, 1.5),
    ...wheels(-5.4, 5.4, 4, 3.5, 1.5),
    poly(sym([7, -2, 5, -2.6, -6, -2.6, -6.4, -2]), 0.4, 1.7, m),
    // the wedge nose: a darker pointed glacis plate
    poly(sym([7, -2, 5, -2.6, 3.4, -2.6, 3.4, 0]), T, 0, m, { tone: -1 }),
    box(-6.2, -3.6, 6.2, -2.5, 1.5, 0.22, m, { tone: -1 }),
    box(-6.2, 2.5, 6.2, 3.6, 1.5, 0.22, m, { tone: -1 }),
    // the open engine grille, dark slats, the owner panel ahead of it
    box(-6, -2, -3.4, 2, T, 0, 'gun', { pat: 'grille', tone: 1 }),
    box(-3.2, -1.9, -2.2, 1.9, T, 0.12, 'own'),
    ell(4.6, -1, 0.55, 0.5, T, 0.18, m, { tone: 1 }),
    ell(6.6, -1.9, 0.3, 0.3, 1.6, 0.35, 'sup'),
    ell(6.6, 1.9, 0.3, 0.3, 1.6, 0.35, 'sup'),
  ];
  if (mods & M_MASTERY) hull.push(...skirtPlates(-5.8, 5.8, 3.5, 1.5, 3));
  if (raid) {
    // Deep Raids: two fuel drums racked across the back, sticking out behind, on a dark frame; jerrycans along both
    // fenders; a second radio whip on the hull
    hull.push(box(-8.6, -2.9, -6.2, 2.9, 0.9, 0.3, 'gun'));
    hull.push(seg(-7.4, -2.7, -7.4, -0.15, 2.2, 1.2, 1.9, 'rust', { sh: 'cyl' }), seg(-7.4, 0.15, -7.4, 2.7, 2.2, 1.2, 1.9, 'ochre', { sh: 'cyl' }));
    hull.push(ell(-7.4, -1.4, 0.35, 0.35, 3.1, 0, 'gun'), ell(-7.4, 1.4, 0.35, 0.35, 3.1, 0, 'gun'));
    for (const s of [-1, 1]) for (let i = 0; i < 3; i++) hull.push(box(-2.6 + i * 1.6, s < 0 ? -4.4 : 3.5, -1.6 + i * 1.6, s < 0 ? -3.5 : 4.4, 1.7, 0.9, 'olive', { tone: 1 }));
    hull.push(seg(5.2, 2.2, 5.2, 2.2, 0.25, T, 5.4, 'gun'));
  }
  if (mods & M_SPECIAL) hull.push(...amphibious(7, -6.4, 2.6, T, raid ? -4.6 : -5.4, raid ? -1.6 : 1.6));
  let tur: Part[];
  if (mods & M_MASTERY) tur = modernTurret(T, m, 0.72, 7.6, 0.7);
  else
    tur = [
      poly(sym([2.6, -1.2, 1.8, -2, -2, -2, -2.6, -1.4]), T, 1.4, m),
      box(2.2, -0.8, 3.2, 0.8, 2.4, 1, m, { tone: -1 }),
      seg(2.8, 0, 7.6, 0, 0.55, 2.9, 0.5, 'gun', { sh: 'cyl' }),
      ell(-0.8, 0.9, 0.7, 0.7, 3.5, 0.15, m, { tone: 1 }),
    ];
  // the tall whip aerial at the back of the turret
  tur.push(seg(-2, -1.4, -2, -1.4, 0.25, 3.5, raid ? 6.4 : 4.8, 'gun'));
  if (raid) {
    // a stowage rack of bedrolls and kit on the turret back, a smoke grenade bank on each cheek
    tur.push(box(-3.8, -1.9, -2.3, 1.9, T + 0.3, 1.1, 'canvas', { pat: 'ribs' }));
    for (const s of [-1, 1]) tur.push(box(1.2, s < 0 ? -2.6 : 1.8, 2.2, s < 0 ? -1.8 : 2.6, T + 0.6, 0.7, 'gun', { tone: 1 }), ell(2.3, s * 2.2, 0.3, 0.3, T + 0.9, 0.4, 'black'));
  }
  return armor(hull, tur, 1.4, [
    [-6.2, -3],
    [-6.2, 3],
  ], 1.15);
}

export function heavyTank(mods: number): UnitModel {
  // big and boxy, in field grey: broad tracks on eight road wheels, a wide long flat hull with spare track sections
  // hung on its front plate, a big square turret set aft, a thick long gun with a muzzle brake reaching far past the
  // nose
  const m: MatId = 'fieldgrey';
  const T = 3.2;
  const siege = !!(mods & M_PATH3);
  const hull: Part[] = [
    ...tracks(-10.5, 10.5, 4, 5.9, 2.4),
    ...wheels(-9.8, 9.8, 8, 5.9, 2.4),
    poly(sym([10.8, -3.4, 9.6, -4.3, -10.5, -4.3, -10.8, -3.8]), 0.6, 2.6, m),
    box(-10.6, -6.1, 10.7, -4.1, 2.4, 0.3, m, { tone: -1 }),
    box(-10.6, 4.1, 10.7, 6.1, 2.4, 0.3, m, { tone: -1 }),
    poly(sym([10.8, -3.4, 9.6, -4.3, 7, -4.3, 7, 0]), T, 0, m, { tone: -1 }),
    box(-10.2, -3.3, -5, 3.3, T, 0, m, { pat: 'grille', tone: -1 }),
    box(-7.4, -3.1, -5.8, 3.1, T, 0.12, 'own'),
    ell(7.6, 0, 0.75, 0.7, T, 0.2, m, { tone: 1 }),
    seg(-4.2, 3.7, 3.8, 3.7, 0.5, T, 0.25, 'gun'),
  ];
  // spare track sections hung on the front plate either side of the driver
  if (!siege) for (const s of [-1, 1]) hull.push(box(8.2, s < 0 ? -3.9 : 1.1, 9.6, s < 0 ? -1.1 : 3.9, T - 0.1, 0.35, 'track', { pat: 'tread' }));
  if (mods & M_MASTERY) hull.push(...skirtPlates(-10.2, 10, 5.9, 2.4, 4));
  if (siege) {
    // Siege Tanks: a thick sloped add-on plate across the whole nose, the dozer blade on its arms ahead of the tracks
    hull.push(poly(sym([11.6, -3.2, 10.6, -4.6, 8.2, -4.6, 8.2, 0]), 0.8, T - 0.5, m, { tone: -1, pat: 'rivets' }));
    for (const s of [-1, 1]) hull.push(seg(4.6, s * 6.25, 11.4, s * 6.25, 0.7, 0.7, 0.7, 'gun', { sh: 'cyl' }), ell(4.6, s * 6.25, 0.5, 0.5, 0.6, 1, 'gun'));
    hull.push(box(11.2, -6.9, 12.5, 6.9, 0.1, 1.5, 'gun', { tone: 1 }), box(11.6, -6.9, 13.3, 6.9, 1.6, 1.3, 'fieldgrey', { tone: -1 }), box(12.5, -6.9, 13.3, 6.9, 2.9, 0, 'alu', { tone: -1 }));
  }
  if (mods & M_SPECIAL) hull.push(...amphibious(10.8, -10.8, 4.3, T, -8.6, 3));
  let tur: Part[];
  let pivot = -0.8;
  if (siege) {
    // the assault gun: a big boxy casemate, its thick front face darker, a huge short howitzer in a heavy mantlet
    // with a double baffle brake, a cupola, (Armor Mastery) smoke grenade banks and a remote machine gun
    pivot = -0.2;
    tur = [
      poly(sym([6.4, -3.2, 5.6, -4.8, -6.8, -4.8, -7.4, -4]), T, 3.4, m, { pat: 'rivets' }),
      poly(sym([6.4, -3.2, 5.6, -4.8, 4.2, -4.8, 4.8, -3.2]), T + 3.4, 0, m, { tone: -1 }),
      box(5.6, -2.1, 8, 2.1, T + 0.6, 2.4, m, { tone: -1, sh: 'dome' }),
      seg(7.6, 0, 13.8, 0, 2.3, T + 1.4, 1.8, 'gun', { sh: 'cyl' }),
      box(12.6, -1.5, 14, 1.5, T + 1.2, 2.1, 'gun', { tone: 1 }),
      box(14.6, -1.5, 16, 1.5, T + 1.2, 2.1, 'gun', { tone: 1 }),
      seg(13.8, 0, 16, 0, 1.4, T + 1.6, 1.4, 'gun'),
      ell(-3.4, -2, 1.3, 1.3, T + 3.4, 0.7, m, { sh: 'dome' }),
      ell(-3.4, -2, 0.7, 0.7, T + 4.1, 0, m, { tone: -1 }),
      ell(-2.6, 2.4, 0.8, 0.8, T + 3.4, 0.12, m, { tone: 1 }),
    ];
    if (mods & M_MASTERY) {
      for (const s of [-1, 1]) tur.push(box(3.4, s < 0 ? -5.4 : 4.6, 5, s < 0 ? -4.6 : 5.4, T + 2, 0.9, 'gun', { tone: 1 }));
      tur.push(box(-1, 1, 1.4, 3, T + 3.4, 0.8, 'gun', { tone: 1.5 }), seg(0.4, 2, 3.4, 2, 0.4, T + 3.9, 0.3, 'gun'));
    }
  } else if (mods & M_MASTERY) tur = modernTurret(T, m, 1.3, 17.2, 1.35);
  else
    tur = [
      // the big square turret: flat sides, a thick front, spare links on its flanks
      poly(sym([5.2, -3.4, 4.6, -4, -5.8, -4, -6.2, -3.6]), T, 2.8, m),
      box(4.6, -1.8, 6.4, 1.8, T + 0.5, 1.9, m, { tone: -1 }),
      seg(5.8, 0, 20.4, 0, 1.3, T + 1.4, 1, 'gun', { sh: 'cyl' }),
      box(20.4, -1, 22.4, 1, T + 1.3, 1.2, 'gun'),
      ell(-2.6, -1.8, 1.15, 1.15, T + 2.8, 0.6, m, { sh: 'dome' }),
      ell(-2.6, -1.8, 0.6, 0.6, T + 3.4, 0, m, { tone: -1 }),
      ell(-1.4, 2, 0.75, 0.7, T + 2.8, 0.12, m, { tone: 1 }),
      box(-3.8, -4.3, 1.6, -4, T + 0.4, 1.6, 'track', { pat: 'tread' }),
      box(-3.8, 4, 1.6, 4.3, T + 0.4, 1.6, 'track', { pat: 'tread' }),
    ];
  // the field grey a step lighter, so the big dark tank stands off the ground
  return armor(toned(hull, m, 0.8), toned(tur, m, 0.8), pivot, [
    [-10.6, -5],
    [-10.6, 5],
  ]);
}
