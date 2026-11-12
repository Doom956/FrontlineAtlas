// The 'detailed' art style (client only): detailed pixel art. STUB: until it is written, every category delegates to
// the refined style, so the game and the art lab show the refined art in this column.
//
// TODO(detailed): implement every category of StyleModule (art/types.ts) in this folder:
//   - Look: about twice the pixels per unit of the refined style; muted real military colours (naval greys, olive
//     drab, field grey, natural metal), a thin dark outline or none, subtle shading (one top-left light, more tones,
//     small highlights); the owner colour still only as a band or plate, never a tint of the whole unit.
//   - ships (UnitArt): warship, destroyer, battleship, submarine, carrier, transport, trade ship, each easy to tell
//     apart at mid zoom (hull length and beam, turret count, funnel, flight deck); the upgrade details of
//     art/shared/keys.ts M_* bits; turretPoint for the salvo guns (warship 2, destroyer 1 firing twice, battleship 3).
//   - land (UnitArt): tank division, light tank, heavy tank, plain and upgraded.
//   - air (UnitArt): bomber, ground attack, heavy bomber, fighter, transport plane, recon plane, plain and upgraded,
//     each with its own planform; propellers (spinning with UnitDraw.timeMs), banking with UnitDraw.turnRate, a ground
//     shadow when UnitDraw.shadow.
//   - missiles (UnitArt): rocket and atom bomb with an exhaust flame.
//   - troopIcons (TroopIconArt): infantry, armor, artillery and the unknown mix on an owner plate, size + 2 px square.
//   - wakes and contrails (TrailArt): world-anchored trails (TrailView maps tiles to screen), wake size from speed.
//   - explosions (ExplosionArt): every BlastKind and MapFxKind; craters (CraterArt); cannonFire (CannonArt).
//   - lengthPx must match what drawUnit covers (the renderer sizes hit areas and rings from it).
//   - Motion: read only the MotionParams numbers (art/motion.ts), so subtle, lively and cinematic all work.
// Rules: never import from art/refined or art/realistic (copying a file from refined as a starting point is fine);
// shared helpers are in art/shared (atlas baking, colour maths, noise, pixel discs). Check it in the art lab (an art
// lab build, VITE_ART_LAB=1, opened at #artlab) and in the game (VITE_ART_STYLE=detailed).
import { refined } from '../refined';
import type { StyleModule } from '../types';

export const detailed: StyleModule = { ...refined, id: 'detailed' };
