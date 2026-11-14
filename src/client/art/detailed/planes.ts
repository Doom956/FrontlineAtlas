// The detailed style's plane models (client only, pure data), rasterized by bake.ts like every other unit model.
// Model units are screen px at mid zoom; the nose points at +u, the right wing at +v. All art is original and lives
// here as code.
//
// Each plane reads by its silhouette first, then its colour:
//   heavy bomber   the biggest in the sky: four propeller engines on a long straight wing, a framed glass nose, twin
//                  end-plate fins on a wide tailplane, natural aluminium
//   cargo plane    a fat round fuselage under a high wing, two engines, invasion stripes
//   bomber         twin engines on a straight wing, a glazed nose, one fin, olive drab
//   recon plane    twin booms with an engine each, a short glazed pod between them, photo-recon blue
//   ground attack  a heavy armoured single-engine bruiser: a thick body behind a big radial engine, broad straight
//                  wings hung with bombs and rockets, a long canopy with a rear gunner, camouflage
//   fighter        the smallest: an elliptic wing, a slim body, one propeller, sea grey
// Upgrades carry them from the propeller age into the jet age:
//   Jet Engines        fighter: a modern stealth fighter (a diamond wing, an angular body, two fins canted outward);
//                      bomber: a swept-wing jet bomber with pods under the wings;
//                      ground attack: a straight-winged attack jet with two big engines high on the rear body, twin
//                      fins and a long nose cannon (the only plane shaped like that); cargo plane: four jets under a
//                      swept high wing
//   Strategic Bombing  the heavy bomber becomes a giant swept-wing strategic jet bomber, eight engines in four twin
//                      pods under the wings and a tall fin
//   Air Mastery        heavier armament: cannon gondolas and a chequered nose (fighter), missiles (jet fighter, jet
//                      heavy bomber), a solid gun nose and gun turrets (bomber), long cannon pods (ground attack), gun
//                      turrets and turbocharged engines (heavy bomber)
//   Drop Tanks         pale tanks sticking out ahead of the wings (tip tanks on the jets)
//   Night Bombing      dark night paint with black sides and wing edges, small dull roundels, flame dampers, a darker
//                      glazed nose
import { M_JET, M_MASTERY, M_NIGHT, M_PATH3, M_SPECIAL } from '../shared/keys';
import type { MatId, Part } from './bake';
import type { Nozzle, Prop, UnitModel } from './models';
import { box, ell, grown, poly, seg, sym, toned } from './shapes';

// ------------------------------------------------------------------------------------------------- parts

/** Shading frame for a band laid over an ellipse or cylinder. */
const over = (u: number, v: number, ru: number, rv: number): readonly [number, number, number, number] => [u, v, ru, rv];
const SIDES = [-1, 1] as const;

/** A roundel in the owner's colour on each wing: a dark ring round the colour (small and dull at night). */
function roundels(u: number, v: number, z: number, r: number, night = false): Part[] {
  const out: Part[] = [];
  const rr = night ? r * 0.7 : r;
  for (const s of SIDES) out.push(ell(u, s * v, rr, rr, z, 0, 'black', { tone: night ? 0 : 2 }), ell(u, s * v, rr * 0.66, rr * 0.66, z, 0, 'own'));
  return out;
}
/** The owner band round a fuselage. */
function band(u: number, w: number, ru: number, rv: number, z: number, h: number, cu = 0): Part {
  return box(u - w / 2, -rv - 0.1, u + w / 2, rv + 0.1, z, h + 0.05, 'own', { sh: 'cyl', sc: over(cu, 0, ru, rv), clip: [cu, 0, ru, rv] });
}
/** An engine nacelle with its cowling and spinner, pointing forward. */
function nacelle(u: number, v: number, z: number, len: number, r: number, m: MatId, cowl: MatId = m): Part[] {
  return [ell(u, v, len, r, z, r * 1.1, m, { sh: 'cyl' }), ell(u + len - 0.6, v, 0.7, r, z + 0.05, r * 1.05, cowl, { sh: 'cyl' }), ell(u + len + 0.1, v, 0.45, 0.45, z + r * 0.3, 0.5, 'gun', { sh: 'dome' })];
}
/** A jet engine pod: a pale pod with a dark intake at the front and a dark nozzle at the back. */
function jetPod(u: number, v: number, z: number, len: number, r: number, m: MatId = 'alu'): Part[] {
  return [ell(u, v, len, r, z, r * 1.1, m, { sh: 'cyl' }), ell(u + len - 0.45, v, 0.5, r * 0.7, z + r * 0.2, r * 0.9, 'black'), ell(u - len + 0.3, v, 0.5, r * 0.6, z + r * 0.15, r * 0.8, 'gun')];
}
/** A drop tank (Drop Tanks): a pale torpedo with a dark nose cap and a thin dark band, its nose at `front`. */
function dropTank(front: number, v: number, z: number, len: number, wid: number): Part[] {
  const c = front - len / 2;
  const fr = over(c, v, len / 2, wid / 2);
  return [
    ell(c, v, len / 2, wid / 2, z, wid * 0.9, 'alu', { sh: 'cyl', tone: 1 }),
    ell(front - 0.4, v, 0.55, wid * 0.36, z + wid * 0.25, wid * 0.55, 'gun'),
    box(c - 0.6, v - wid / 2, c - 0.25, v + wid / 2, z, wid * 0.92, 'gun', { sh: 'cyl', sc: fr, clip: [c, v, len / 2, wid / 2] }),
  ];
}
/** A chequered cowling ring (Air Mastery), black and white, `len` long. */
function checks(u: number, v: number, z: number, r: number, len = 0.45): Part[] {
  return [ell(u, v, len, r, z, r * 1.15, 'white', { sh: 'cyl' }), ell(u, v - r * 0.5, len, r * 0.32, z + 0.02, r * 1.15, 'black'), ell(u, v + r * 0.5, len, r * 0.32, z + 0.02, r * 1.15, 'black')];
}
/** A gun turret: a dark dome with twin barrels pointing `dir` radians from the nose. */
function gunTurret(u: number, v: number, z: number, r: number, len: number, dir: number, m: MatId = 'gun'): Part[] {
  const c = Math.cos(dir);
  const s = Math.sin(dir);
  return [ell(u, v, r, r, z, r * 0.7, m, { sh: 'dome', tone: m === 'gun' ? 1 : 0 }), ...[-0.3, 0.3].map((dv) => seg(u - s * dv, v + c * dv, u - s * dv + c * (r + len), v + c * dv + s * (r + len), 0.3, z + r * 0.4, 0.25, 'gun'))];
}
/** Night Bombing: black sides under a fuselage (a wider black body just below it) and a black rim round `outline`. */
function nightTrim(u: number, ru: number, rv: number, z: number, h: number, outlines: { p: number[]; z: number; h: number }[]): Part[] {
  return [ell(u, 0, ru, rv + 0.35, z - 0.25, h * 0.75, 'black', { sh: 'cyl' }), ...outlines.map((o) => poly(o.p, o.z, o.h, 'black', { edge: true }))];
}
/** Night Bombing: a flame damper shroud, a black streak back over an engine from `u`. */
function damper(u: number, v: number, z: number): Part {
  return seg(u, v, u - 3, v, 0.7, z, 0.25, 'black');
}

/**
 * A plane drawn `k` times its numbers (propellers, nozzles and height too): the small planes are drawn larger than
 * they were first laid out, so they keep a readable silhouette at the normal zoom (1 screen px per art px).
 */
function scaled(um: UnitModel, k: number): UnitModel {
  const q = (n: Prop): Prop => ({ u: n.u * k, v: n.v * k, z: n.z * k, r: n.r * k });
  return { ...um, model: { ...um.model, parts: grown(um.model.parts, k) }, props: um.props.map(q), nozzles: um.nozzles.map(q), alt: um.alt * k };
}

function plane(parts: Part[], props: Prop[], nozzles: Nozzle[], alt: number): UnitModel {
  return { model: { parts }, guns: [], props, nozzles, alt, dust: [] };
}

// ------------------------------------------------------------------------------------------------- planes

export function bomber(mods: number): UnitModel {
  // twin engines on a straight wing, a glazed nose, a single fin, olive drab; with jets a swept-wing jet bomber with
  // a pod under each wing and one further out
  const night = !!(mods & M_NIGHT);
  const m: MatId = night ? 'night' : 'odplane';
  const jet = !!(mods & M_JET);
  const out: Part[] = [];
  const props: Prop[] = [];
  const noz: Nozzle[] = [];
  const Z = 2.4;
  const ru = 10.2;
  const rv = 1.1;
  let wing: number[];
  let tail: number[];
  if (jet) {
    wing = sym([4.2, -1.4, -2.4, -12.4, -4.2, -12.4, -1.2, -1.4]);
    tail = sym([-6.8, -0.9, -9.4, -4.4, -10.6, -4.4, -9.8, -0.9]);
    out.push(poly(wing, Z + 0.3, 0.45, m, { pat: 'panels' }));
    // the leading edge runs from u 4.2 at the root to -2.4 at the tip: pods hang under it and reach ahead
    for (const s of SIDES) {
      out.push(seg(2, s * 4.6, 0.6, s * 4.6, 0.5, Z - 0.2, 0.5, m), ...jetPod(2.9, s * 4.6, Z - 0.75, 2.6, 0.95));
      out.push(seg(-0.6, s * 8.8, -1.6, s * 8.8, 0.45, Z - 0.1, 0.4, m), ...jetPod(0.5, s * 8.8, Z - 0.6, 2, 0.75));
      noz.push({ u: 0.3, v: s * 4.6, z: Z - 0.35, r: 0.55 }, { u: -1.5, v: s * 8.8, z: Z - 0.25, r: 0.45 });
      if (night) out.push(damper(5.4, s * 4.6, Z + 0.25));
    }
    if (mods & M_SPECIAL) for (const s of SIDES) out.push(...dropTank(1, s * 12.7, Z + 0.2, 5.2, 1.5));
    out.push(...roundels(-1.4, 8.6, Z + 0.75, 1.1, night));
    out.push(poly(sym([-7.6, 0, -11, -0.3, -11.8, 0]), Z + 1.4, 2.2, m), poly(tail, Z + 0.4, 0.35, m));
  } else {
    wing = sym([4.4, -1.4, 3.6, -12.8, 1.6, -13, -0.4, -1.4]);
    tail = sym([-7.2, -0.9, -8.2, -4.6, -9.6, -4.6, -10, -0.9]);
    out.push(poly(wing, Z + 0.3, 0.45, m, { pat: 'panels' }));
    for (const s of SIDES) {
      out.push(...nacelle(2.4, s * 4.6, Z - 0.1, 3.4, 0.95, m, night ? 'black' : m), seg(0, s * 4.6, -2, s * 4.6, 0.9, Z + 0.1, 0.5, m));
      props.push({ u: 6.1, v: s * 4.6, z: Z + 0.4, r: 2 });
      if (mods & M_MASTERY) out.push(...checks(5.1, s * 4.6, Z - 0.1, 0.95));
      if (night) out.push(damper(5.2, s * 4.6, Z + 0.95));
    }
    // the leading edge at v 8.6 is at about u 3.9: the tanks reach 2.6 ahead of it
    if (mods & M_SPECIAL) for (const s of SIDES) out.push(...dropTank(7.3, s * 8.6, Z - 0.5, 8.2, 2));
    out.push(...roundels(2.2, 9.6, Z + 0.75, 1.15, night));
    out.push(poly(tail, Z + 0.4, 0.35, m), seg(-10.2, 0, -6.8, 0, 0.6, Z + 1.4, 2.2, m));
  }
  // a slim fuselage (the cargo plane's is twice as wide)
  out.push(ell(0, 0, ru, rv, Z, 1.5, m, { sh: 'cyl' }), band(-4.6, 1, ru, rv, Z, 1.5), ell(5.2, 0, 1.4, 0.75, Z + 1.55, 0.35, 'glass', { sh: 'dome' }));
  if (mods & M_MASTERY) {
    // a solid gun nose with six muzzles, a dorsal turret, twin tail guns
    out.push(ell(9, 0, 1.7, 0.95, Z + 0.25, 1.15, 'gun', { sh: 'dome', tone: 1 }));
    for (const dv of [-0.55, 0, 0.55]) out.push(seg(9.6, dv - 0.12, 11.9, dv - 0.12, 0.26, Z + 0.7, 0.2, 'gun'), seg(9.6, dv + 0.18, 11.6, dv + 0.18, 0.26, Z + 0.95, 0.2, 'gun'));
    out.push(...gunTurret(2.6, 0, Z + 1.5, 1.25, 2.2, 0));
    out.push(ell(-10.4, 0, 0.75, 0.7, Z + 0.7, 0.8, 'gun', { sh: 'dome', tone: 1 }), seg(-10.6, -0.35, -12.8, -0.35, 0.4, Z + 1, 0.3, 'gun'), seg(-10.6, 0.35, -12.8, 0.35, 0.4, Z + 1, 0.3, 'gun'));
  } else out.push(ell(9, 0, 1.7, 0.95, Z + 0.25, 1.15, 'glass', { sh: 'dome', pat: 'frames', tone: night ? -0.5 : 1 }));
  out.push(ell(jet ? -11.6 : -10.2, 0, 0.5, 0.5, Z + 0.6, 0.6, 'glass'));
  if (night) out.push(...nightTrim(0, ru, rv, Z, 1.5, [{ p: wing, z: Z + 0.3, h: 0.45 }, { p: tail, z: Z + 0.4, h: 0.35 }]));
  // the olive drab a step lighter than the land it flies over
  return scaled(plane(toned(out, 'odplane', 0.7), props, noz, 7), 1.1);
}

/** Ground attack bombs and rockets under a wing whose leading edge is at `le(v)`; cannon pods in place of the bombs. */
function attackStores(le: (v: number) => number, Z: number, cannon: boolean): Part[] {
  const out: Part[] = [];
  for (const s of SIDES) {
    const fb = le(3.1);
    if (cannon) out.push(ell(fb + 0.2, s * 3.1, 3, 0.9, Z - 0.75, 1.15, 'alu', { sh: 'cyl' }), seg(fb + 2.8, s * 3.1, fb + 6, s * 3.1, 0.65, Z - 0.4, 0.5, 'gun'));
    // a bomb: dark, its nose and the front of its body ahead of the wing
    else out.push(ell(fb + 0.2, s * 3.1, 2.4, 0.95, Z - 0.85, 1.3, 'gun', { sh: 'cyl', tone: 1.5 }), ell(fb + 2.3, s * 3.1, 0.45, 0.5, Z - 0.45, 0.7, 'hazard', { tone: -1 }), seg(fb - 2.2, s * 2.3, fb - 2.2, s * 3.9, 0.5, Z - 0.6, 0.6, 'gun', { tone: 1.5 }));
    // three rockets: pale bodies on rails, red heads poking out ahead of the leading edge
    for (const v of [5, 6.2, 7.4]) {
      const f = le(v) + 1.8;
      out.push(seg(f - 4.6, s * v, f - 0.4, s * v, 0.62, Z - 0.5, 0.5, 'white', { sh: 'cyl' }), ell(f - 0.45, s * v, 0.55, 0.36, Z - 0.48, 0.5, 'brick'));
    }
  }
  return out;
}

export function groundAttack(mods: number): UnitModel {
  // a heavy armoured single-engine attack plane: a thick body behind a big radial, broad straight wings hung with a
  // bomb and three rockets each side, a long canopy with the rear gunner's gun, an armoured tub of darker plates
  // round the cockpit and engine, camouflage. With jets: a straight-winged attack jet with two big engine pods high
  // on the rear body, twin fins at the tailplane tips and a long cannon in the nose.
  const night = !!(mods & M_NIGHT);
  const m: MatId = night ? 'night' : 'camo';
  const alt: MatId | undefined = night ? undefined : 'olive';
  const jet = !!(mods & M_JET);
  const out: Part[] = [];
  const props: Prop[] = [];
  const noz: Nozzle[] = [];
  const Z = 2.2;
  const cannon = !!(mods & M_MASTERY);
  let wing: number[];
  let tail: number[];
  let fu: number;
  let ru: number;
  let rv: number;
  if (jet) {
    fu = 0.4;
    ru = 8.6;
    rv = 1.25;
    wing = sym([3.4, -1.4, 2.8, -10, 0.4, -10.2, -0.8, -1.4]);
    tail = sym([-6.6, -0.8, -6.8, -4.2, -8.4, -4.2, -8.6, -0.8]);
    out.push(poly(wing, Z + 0.2, 0.45, m, { pat: 'blotch', alt }));
    out.push(...attackStores((v) => 3.4 - (0.6 * (v - 1.4)) / 8.6, Z, cannon));
    // two big engine pods high on the rear body, on short stubs
    for (const s of SIDES) {
      out.push(seg(-3.6, s * 1.2, -3.6, s * 2.2, 0.8, Z + 1.2, 0.6, m), ...jetPod(-3.6, s * 2.5, Z + 1.5, 2.7, 1.15, night ? 'night' : 'alu'));
      noz.push({ u: -6.2, v: s * 2.5, z: Z + 2, r: 0.65 });
      if (night) out.push(damper(-1.4, s * 2.5, Z + 2.8));
    }
    // twin fins at the tips of the tailplane, the long nose cannon
    out.push(poly(tail, Z + 0.4, 0.35, m));
    for (const s of SIDES) out.push(seg(-9, s * 4, -6.4, s * 4, 0.55, Z + 0.4, 2.6, m));
    out.push(seg(8.6, 0, 10.8, 0, 0.5, Z + 0.55, 0.4, 'gun'));
    out.push(ell(fu, 0, ru, rv, Z, 1.6, m, { sh: 'cyl', pat: 'blotch', alt }), ell(4.6, 0, 1.4, 0.8, Z + 1.5, 0.5, 'glass', { sh: 'dome' }));
    if (mods & M_SPECIAL) for (const s of SIDES) out.push(...dropTank(6, s * 9.2, Z - 0.5, 7.4, 1.8));
    out.push(...roundels(0.4, 7.4, Z + 0.65, 0.95, night), band(-4.2, 0.9, ru, rv, Z, 1.6, fu));
  } else {
    fu = -0.4;
    ru = 7.8;
    rv = 1.5;
    wing = sym([4.2, -1.4, 3.8, -10, 0.6, -10, -1.4, -1.4]);
    tail = sym([-5.8, -0.8, -6.6, -3.8, -8, -3.8, -8.3, -0.8]);
    out.push(poly(wing, Z + 0.2, 0.45, m, { pat: 'blotch', alt }));
    out.push(...attackStores((v) => 4.2 - (0.4 * (v - 1.4)) / 8.6, Z, cannon));
    out.push(ell(fu, 0, ru, rv, Z, 1.7, m, { sh: 'cyl', pat: 'blotch', alt }));
    // the armoured tub: darker riveted plates over the engine and round the cockpit
    out.push(poly(sym([6.6, -1.1, 6.2, -1.35, 1.4, -1.35, 0.8, -1]), Z + 1.62, 0, m, { tone: -1.5, pat: 'rivets' }));
    // the big radial engine: a broad cowling with a dark front ring and the spinner
    out.push(ell(6.9, 0, 1.3, 1.85, Z - 0.2, 2.05, night ? 'black' : m, { sh: 'cyl', tone: -0.5 }), ell(8, 0, 0.35, 1.5, Z + 0.1, 1.5, 'gun'), ell(8.5, 0, 0.55, 0.55, Z + 0.6, 0.7, 'gun', { sh: 'dome' }));
    if (cannon) out.push(...checks(7.1, 0, Z - 0.2, 1.85, 0.8));
    if (night) for (const s of SIDES) out.push(damper(6.6, s * 1.5, Z + 1.3));
    props.push({ u: 8.8, v: 0, z: Z + 0.8, r: 2.8 });
    // the long canopy, the rear gunner's gun pointing back
    out.push(ell(1.4, 0, 2.4, 0.8, Z + 1.62, 0.5, 'glass', { sh: 'dome', pat: 'frames', tone: night ? -0.5 : 0 }), seg(-0.8, 0, -2.6, 0, 0.35, Z + 2, 0.25, 'gun'));
    out.push(poly(tail, Z + 0.3, 0.3, m), seg(-8.4, 0, -5.6, 0, 0.6, Z + 1.4, 1.6, m));
    if (mods & M_SPECIAL) for (const s of SIDES) out.push(...dropTank(7.2, s * 9.2, Z - 0.5, 8.2, 1.8));
    out.push(...roundels(1.6, 7.6, Z + 0.65, 0.95, night), band(-4, 0.9, ru, rv, Z, 1.7, fu));
  }
  if (night) out.push(...nightTrim(fu, ru, rv, Z, 1.6, [{ p: wing, z: Z + 0.2, h: 0.45 }, { p: tail, z: Z + 0.4, h: 0.35 }]));
  // the camouflage a step lighter than the land it flies over
  return scaled(plane(toned(out, 'camo', 0.8), props, noz, 6), 1.2);
}

export function heavyBomber(mods: number): UnitModel {
  // the biggest plane: four propeller engines on a long straight wing, a long body with a framed glass nose, twin
  // end-plate fins on a wide tailplane, natural aluminium. Strategic Bombing: a giant swept-wing jet bomber, eight
  // engines in four twin pods under the wings, a tall fin.
  const night = !!(mods & M_NIGHT);
  const m: MatId = night ? 'night' : 'alu';
  const strat = !!(mods & M_PATH3);
  const out: Part[] = [];
  const props: Prop[] = [];
  const noz: Nozzle[] = [];
  const Z = 2.6;
  let wing: number[];
  let tail: number[];
  let ru: number;
  let fu: number;
  const rv = 1.6;
  if (strat) {
    fu = 0.6;
    ru = 16;
    wing = sym([7, -2, -6, -23, -8.4, -23, -2.8, -2]);
    tail = sym([-11.6, -1.2, -14.4, -7.4, -16, -7.4, -15.4, -1.2]);
    const le = (v: number): number => 7 - (13 * (v - 2)) / 21;
    out.push(poly(wing, Z + 0.3, 0.5, m, { pat: 'panels' }));
    // four twin pods on pylons, reaching ahead of the leading edge
    for (const s of SIDES)
      for (const v of [7.4, 14.4]) {
        const c = le(v) + 0.2;
        out.push(seg(c - 1, s * v, c - 2.6, s * v, 0.5, Z - 0.1, 0.45, m));
        for (const dv of [-0.62, 0.62]) {
          out.push(...jetPod(c, s * v + dv, Z - 0.8, 2.3, 0.6));
          noz.push({ u: c - 2.3, v: s * v + dv, z: Z - 0.5, r: 0.4 });
        }
        if (night) out.push(damper(c + 0.6, s * v, Z + 0.85));
      }
    if (mods & M_MASTERY)
      // stand-off missiles on the inner pylons: pale bodies with a small delta wing, dark noses well ahead
      for (const s of SIDES) {
        const f = le(4.2) + 3.4;
        out.push(ell(f - 3.2, s * 4.2, 3.2, 0.55, Z - 0.9, 0.9, 'white', { sh: 'cyl' }), ell(f - 0.4, s * 4.2, 0.5, 0.4, Z - 0.7, 0.6, 'gun'), poly([f - 4.6, s * 4.2, f - 6, s * 5.6, f - 6.2, s * 4.2, f - 6, s * 2.8], Z - 0.6, 0.15, 'white', { tone: -1 }));
        out.push(seg(-16.4, s * 0.3, -18, s * 0.3, 0.3, Z + 0.9, 0.25, 'gun'));
      }
    if (mods & M_SPECIAL) for (const s of SIDES) out.push(...dropTank(le(19.4) + 3.4, s * 19.4, Z - 0.4, 8, 2.1));
    out.push(ell(fu, 0, ru, rv, Z, 1.9, m, { sh: 'cyl', pat: 'panels' }), band(-7.4, 1.1, ru, rv, Z, 1.9, fu));
    // the blunt nose with its cockpit windows, the swept tailplane and one tall fin
    out.push(ell(14.6, 0, 1.6, 1.2, Z + 1.6, 0.4, 'glass', { sh: 'dome', tone: night ? -0.5 : 0 }), ell(16.2, 0, 0.6, 0.9, Z + 0.4, 1.2, m, { tone: -1 }));
    out.push(poly(tail, Z + 0.5, 0.35, m), poly(sym([-10.6, 0, -15.4, -0.4, -16.2, 0]), Z + 1.8, 4.2, m));
    out.push(...roundels(-6, 15.6, Z + 0.85, 1.35, night));
  } else {
    fu = 0.2;
    ru = 14.6;
    wing = sym([5.6, -1.8, 3.8, -21, 1.6, -21, -1.8, -1.8]);
    tail = sym([-11, -1.2, -12, -6.6, -13.8, -6.6, -14.2, -1.2]);
    const te = (v: number): number => -1.8 + (3.4 * (v - 1.8)) / 19.2;
    const turbo = !!(mods & M_MASTERY);
    out.push(poly(wing, Z + 0.3, 0.5, m, { pat: 'panels' }));
    for (const [u, len, v] of [
      [3.4, 3.4, 5.6],
      [3, 3.2, 11.4],
    ] as const)
      for (const s of SIDES) {
        out.push(...nacelle(u, s * v, Z - 0.1, len, 1.1, m, night ? 'black' : 'gun'));
        props.push({ u: u + len + 0.6, v: s * v, z: Z + 0.35, r: turbo ? 2.3 : 1.9 });
        if (turbo) {
          // turbocharged engines: chequered cowl rings, the nacelles running far back past the trailing edge to a
          // bright exhaust plate
          out.push(...checks(u + len - 0.8, s * v, Z - 0.1, 0.9, 0.8), seg(te(v) + 0.4, s * v, te(v) - 2.6, s * v, 1.3, Z, 0.8, m), ell(te(v) - 2.4, s * v, 0.6, 0.6, Z + 0.8, 0, 'alu', { tone: 2 }));
        }
        if (night) out.push(damper(u + len - 0.4, s * v, Z + 0.95));
      }
    if (mods & M_SPECIAL) for (const s of SIDES) out.push(...dropTank(7.7, s * 15.8, Z - 0.5, 9, 2.1));
    out.push(ell(fu, 0, ru, rv, Z, 1.9, m, { sh: 'cyl', pat: 'panels' }), band(-6.6, 1.1, ru, rv, Z, 1.9, fu));
    // the long framed glass nose and the cockpit
    out.push(ell(13.2, 0, 2, 1.25, Z + 0.3, 1.4, 'glass', { sh: 'dome', pat: 'frames', tone: night ? -0.5 : 0.5 }), ell(9.8, 0, 1.5, 0.85, Z + 1.85, 0.35, 'glass', { sh: 'dome' }));
    // a wide tailplane with an end-plate fin at each tip
    out.push(poly(tail, Z + 0.4, 0.35, m));
    for (const s of SIDES) out.push(seg(-14.8, s * 6.6, -11.2, s * 6.6, 0.8, Z + 0.4, 2.8, m));
    out.push(...roundels(1.8, 15.4, Z + 0.85, 1.3, night));
    if (turbo) {
      // gun turrets: a chin turret, a dorsal turret fore and aft, the glazed tail turret, waist blisters
      out.push(...gunTurret(12.2, 0, Z - 0.2, 0.8, 1.2, 0), ...gunTurret(7.2, 0, Z + 1.9, 1, 1.6, 0), ...gunTurret(-5.4, 0, Z + 1.9, 1, 1.6, Math.PI));
      out.push(ell(-14.6, 0, 1, 0.9, Z + 0.5, 1.1, 'glass', { sh: 'dome' }), seg(-15, -0.3, -16.8, -0.3, 0.3, Z + 1, 0.25, 'gun'), seg(-15, 0.3, -16.8, 0.3, 0.3, Z + 1, 0.25, 'gun'));
      for (const s of SIDES) out.push(ell(-8.4, s * 1.55, 0.6, 0.35, Z + 1.1, 0.5, 'glass', { tone: 1 }));
    }
  }
  if (night) out.push(...nightTrim(fu, ru, rv, Z, 1.9, [{ p: wing, z: Z + 0.3, h: 0.5 }, { p: tail, z: Z + 0.4, h: 0.35 }]));
  return plane(out, props, noz, strat ? 10 : 9);
}

export function fighter(mods: number): UnitModel {
  // small and fast: an elliptic wing, a slim fuselage, a bubble canopy, sea grey; with jets a modern stealth fighter
  const m: MatId = 'seagrey';
  const out: Part[] = [];
  const props: Prop[] = [];
  const noz: Nozzle[] = [];
  const Z = 2.2;
  const ru = 6.6;
  const rv = 0.95;
  if (mods & M_JET) {
    // a modern stealth fighter: a flat angular body with chines and a sharp nose, dark side intakes, a diamond wing
    // (swept leading edge, the trailing edge swept slightly forward), diamond tailplanes, two fins canted outward, one
    // engine; in sea grey a shade darker than the propeller fighter's, lit hard from the top left so it reads small.
    // Few, big details: the diamond outline, the twin fins, the dark canopy; the intakes only close up.
    const sg: MatId = 'seagrey';
    const body = sym([7.6, 0, 5.8, -0.6, 3.4, -1.25, 1.2, -1.9, -4.6, -1.8, -6.6, -1.1, -7.2, -0.6]);
    const wing = sym([1.4, -1.8, -2.4, -6.1, -3.8, -6.1, -4.2, -1.8]);
    out.push(poly(wing, Z + 0.15, 0.4, sg, { tone: -0.3 }), poly(sym([-5.2, -1, -6.9, -3.9, -7.9, -3.9, -7.6, -1]), Z + 0.3, 0.3, sg, { tone: -0.3 }));
    // the body: darker chine edges round a lighter top, a raised spine down the middle catching the light
    out.push(poly(body, Z, 0.85, sg, { tone: -1 }));
    out.push(poly(sym([7.2, 0, 5.6, -0.45, 3.4, -0.95, 1.2, -1.45, -4.6, -1.4, -6.4, -0.8, -6.9, -0.4]), Z + 0.85, 0, sg, { tone: 0 }));
    out.push(ell(-0.6, 0, 6.2, 0.8, Z + 0.85, 0.5, sg, { sh: 'cyl', tone: 1 }));
    // the intakes: dark recesses on the top surface either side of the cockpit (close up only)
    for (const s of SIDES) out.push(poly([3.2, s * 0.95, 1.4, s * 1.45, 0.8, s * 1.1, 2.6, s * 0.75], Z + 0.85, 0, 'black', { minRes: 1.5 }));
    // two tall fins canted outward, the engine nozzle
    for (const s of SIDES) out.push(seg(-7, s * 2.1, -4.4, s * 1.3, 0.6, Z + 0.85, 2.3, sg, { tone: 0.5 }));
    out.push(ell(-7.1, 0, 0.7, 0.65, Z + 0.25, 0.8, 'gun', { sh: 'cyl' }));
    noz.push({ u: -7.6, v: 0, z: Z + 0.6, r: 0.55 });
    // a long canopy, a low-visibility roundel on each wing and the owner stripe across the back
    out.push(ell(3.4, 0, 1.7, 0.6, Z + 1.1, 0.4, 'glass', { sh: 'dome' }));
    out.push(...roundels(-2.6, 4.1, Z + 0.5, 0.65), box(-3.5, -1.8, -2.8, 1.8, Z + 1.05, 0, 'own', { clipPoly: body }));
    // the leading edge runs from u 1.4 at the root to -2.4 at the tip
    const le = (v: number): number => 1.4 - (3.8 * (v - 1.8)) / 4.3;
    if (mods & M_MASTERY)
      // air-to-air missiles under both wings: pale bodies, dark fins and seekers, well ahead of the wing
      for (const s of SIDES) {
        const f = le(3.2) + 2.8;
        out.push(seg(f - 4.8, s * 3.2, f - 0.3, s * 3.2, 0.62, Z - 0.4, 0.55, 'white', { sh: 'cyl' }), ell(f - 0.3, s * 3.2, 0.35, 0.3, Z - 0.35, 0.45, 'gun'), seg(f - 4.6, s * 2.5, f - 4.6, s * 3.9, 0.5, Z - 0.3, 0.2, 'gun'));
      }
    // drop tanks on the outer pylons
    if (mods & M_SPECIAL) for (const s of SIDES) out.push(...dropTank(le(4.9) + 3.2, s * 4.9, Z - 0.4, 6.4, 1.6));
    // a bit bigger than the propeller fighter it replaces (still under the ground attack plane)
    return scaled(plane(out, props, noz, 6), 1.36);
  } else {
    // the elliptic wing as two half ellipses; its leading edge at v is u 0.6 + 1.9 sqrt(1 - (v / 7.4)^2)
    const le = (v: number): number => 0.6 + 1.9 * Math.sqrt(1 - (v / 7.4) ** 2);
    out.push(ell(0.6, 0, 1.9, 7.4, Z + 0.15, 0.35, m, { clipPoly: [3, -7.6, 3, 7.6, -1.4, 7.6, -1.4, -7.6] }));
    out.push(ell(0, 0, ru, rv, Z, 1.15, m, { sh: 'cyl' }), ell(5.4, 0, 0.9, 0.95, Z, 1.15, m, { sh: 'cyl' }), ell(6.6, 0, 0.42, 0.42, Z + 0.3, 0.5, 'gun', { sh: 'dome' }));
    if (mods & M_MASTERY) {
      // a long chequered nose band, cannon gondolas under the wings, four gun barrels through the leading edge
      out.push(...checks(5.4, 0, Z, 0.97, 0.8));
      for (const s of SIDES) {
        const f = le(3.6) + 2;
        out.push(ell(f - 2, s * 3.6, 2, 0.6, Z - 0.35, 0.7, 'gun', { sh: 'cyl', tone: 1 }), seg(f, s * 3.6, f + 1.2, s * 3.6, 0.35, Z - 0.15, 0.25, 'gun'));
        for (const v of [2.3, 4.8]) out.push(seg(le(v) - 0.2, s * v, le(v) + 1.4, s * v, 0.28, Z + 0.3, 0.2, 'gun'));
      }
    }
    if (mods & M_SPECIAL) for (const s of SIDES) out.push(...dropTank(le(5.6) + 3.2, s * 5.6, Z - 0.4, 6.8, 1.7));
    props.push({ u: 6.9, v: 0, z: Z + 0.55, r: 2.1 });
    out.push(poly(sym([-4.2, -0.5, -4.8, -2.6, -6, -2.6, -6.3, -0.5]), Z + 0.3, 0.3, m), seg(-6.4, 0, -4.2, 0, 0.45, Z + 1, 1.4, m));
    out.push(...roundels(0.4, 4.6, Z + 0.5, 0.8));
  }
  out.push(band(-3, 0.7, ru, rv, Z, 1.15), ell(1, 0, 1.25, 0.6, Z + 1.1, 0.35, 'glass', { sh: 'dome' }));
  // the smallest plane, drawn well over its numbers so it reads at the normal zoom
  return scaled(plane(out, props, noz, 6), 1.3);
}

export function transportPlane(mods: number): UnitModel {
  // the cargo plane that carries the paratroopers: a deep, round fuselage about twice as wide as the bomber's and
  // longer, a high straight wing set over it with two engines, a big cargo door, a two-tone grey finish and black and
  // white invasion stripes round the wings and the rear fuselage; with jets four jet pods under a swept high wing
  const m: MatId = 'cargo';
  const alt: MatId = 'cargoDark';
  const jet = !!(mods & M_JET);
  const out: Part[] = [];
  const props: Prop[] = [];
  const noz: Nozzle[] = [];
  const Z = 2.2;
  const ru = 13;
  const rv = 2.3;
  const fus = over(0, 0, ru, rv);
  out.push(
    ell(0, 0, ru, rv, Z, 2.6, m, { sh: 'cyl', pat: 'blotch', alt }),
    // invasion stripes round the rear fuselage: white, black, white, black, white
    ...[0, 1, 2, 3, 4].map((i) => box(-7.4 + i * 0.75, -rv - 0.1, -6.65 + i * 0.75, rv + 0.1, Z, 2.65, i % 2 ? 'black' : 'white', { sh: 'cyl', sc: fus, clip: [0, 0, ru, rv] })),
    band(-3.2, 1.1, ru, rv, Z, 2.6),
    // the big cargo door on the port side, its frame darker
    box(-5.8, -2.35, -3.8, -1.75, Z + 1, 0, 'cargoDark', { edge: true, tone: -1 }),
    ell(11.2, 0, 1.3, 1.5, Z + 1.8, 0.6, 'glass', { sh: 'dome', pat: 'frames' }),
    poly(sym([-9.8, -1.4, -11, -6.4, -12.6, -6.4, -13, -1.4]), Z + 1.3, 0.35, m),
    seg(-13.2, 0, -9, 0, 0.8, Z + 2.4, 2.8, m),
  );
  // the high wing sits on top of the fuselage
  const WZ = Z + 2.5;
  const wing = jet ? sym([3.8, -1.8, -1.6, -15.4, -3.6, -15.4, -1.4, -1.8]) : sym([3.8, -1.8, 3, -15.4, 0.8, -15.6, -1.6, -1.8]);
  const le = jet ? (v: number): number => 3.8 - (5.4 * (v - 1.8)) / 13.6 : (v: number): number => 3.8 - (0.8 * (v - 1.8)) / 13.6;
  out.push(poly(wing, WZ, 0.45, m, { pat: 'panels' }));
  // invasion stripes on both wings, outboard of the engines
  for (const sd of SIDES)
    for (let i = 0; i < 5; i++) {
      const v0 = sd * (jet ? 10.8 + i * 0.6 : 7.6 + i * 0.7);
      const w = jet ? 0.6 : 0.7;
      out.push(box(-6, Math.min(v0, v0 + sd * w), 6, Math.max(v0, v0 + sd * w), WZ + 0.45, 0, i % 2 ? 'black' : 'white', { clipPoly: wing }));
    }
  if (jet) {
    // four jets slung under the wing on pylons, reaching ahead of the leading edge
    for (const v of [4.8, 8.6])
      for (const s of SIDES) {
        const c = le(v) + 0.3;
        out.push(seg(c - 0.6, s * v, c - 2, s * v, 0.5, WZ - 0.5, 0.5, m), ...jetPod(c, s * v, WZ - 1.3, 2.3, 0.85));
        noz.push({ u: c - 2.3, v: s * v, z: WZ - 0.95, r: 0.5 });
      }
    out.push(...roundels(-3, 13, WZ + 0.45, 1.15));
  } else {
    for (const v of [-5.2, 5.2]) {
      out.push(...nacelle(2.2, v, WZ - 0.8, 3.2, 1, m, 'gun'));
      props.push({ u: 5.8, v, z: WZ - 0.2, r: 2.3 });
    }
    out.push(...roundels(1.4, 12.2, WZ + 0.45, 1.25));
  }
  if (mods & M_SPECIAL) for (const s of SIDES) out.push(...dropTank(le(jet ? 12.8 : 10.4) + 3.4, s * (jet ? 12.8 : 10.4), WZ - 0.9, 8.6, 2.1));
  // kept clearly bigger than the (enlarged) bomber
  return scaled(plane(out, props, noz, 8), 1.1);
}

export function reconPlane(mods: number): UnitModel {
  // twin booms with an engine each, a short central pod with a long glazed nose, photo-recon blue
  const m: MatId = 'prublue';
  const out: Part[] = [];
  const props: Prop[] = [];
  const Z = 2.2;
  out.push(poly(sym([3, -1.2, 2.4, -12, 0.8, -12.2, -0.8, -1.2]), Z + 0.25, 0.4, m));
  for (const s of SIDES) {
    out.push(seg(4.8, s * 3.4, -9.4, s * 3.4, 1.15, Z, 1.1, m, { sh: 'cyl' }), ell(4.4, s * 3.4, 1.4, 0.9, Z - 0.1, 1.3, m, { sh: 'cyl' }), ell(6, s * 3.4, 0.4, 0.4, Z + 0.4, 0.5, 'gun', { sh: 'dome' }));
    out.push(seg(-10.2, s * 3.4, -8.2, s * 3.4, 0.45, Z + 1, 1.6, m));
    props.push({ u: 6.3, v: s * 3.4, z: Z + 0.6, r: 1.9 });
  }
  // the tailplane between the booms: slim, so the booms read as two lines joined at the tail (never a ladder)
  out.push(box(-10.2, -3.4, -9.2, 3.4, Z + 0.4, 0.3, m));
  out.push(ell(1.8, 0, 5.2, 1.15, Z, 1.25, m, { sh: 'cyl' }), band(-1.6, 0.8, 5.2, 1.15, Z, 1.25, 1.8));
  out.push(ell(6.4, 0, 1.4, 0.9, Z + 0.15, 1, 'glass', { sh: 'dome', pat: 'frames' }), ell(2.6, 0, 1.3, 0.6, Z + 1.2, 0.3, 'glass', { sh: 'dome' }));
  // a camera window under the nose
  out.push(ell(4.4, 0, 0.45, 0.45, Z + 1.25, 0, 'black'));
  // the leading edge at v 7 is about u 2.7: the tanks reach 2.6 ahead of it
  if (mods & M_SPECIAL) for (const s of SIDES) out.push(...dropTank(6, s * 7, Z - 0.4, 7.6, 1.8));
  out.push(...roundels(1.4, 8.6, Z + 0.65, 1));
  return plane(out, props, [], 7);
}
