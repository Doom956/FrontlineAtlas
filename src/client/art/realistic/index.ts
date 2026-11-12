// The 'realistic' art style (client only): realistic painted top-down art, like model miniatures seen from above.
// STUB: until it is written, every category delegates to the refined style, so the game and the art lab show the
// refined art in this column.
//
// TODO(realistic): implement every category of StyleModule (art/types.ts) in this folder:
//   - Look: no pixel look; smooth shading (gradients, soft highlights, ambient occlusion), true proportions, painted
//     detail (deck planking, panel lines, weathering), real military colours; smooth rotation at any heading (bake a
//     fine set of headings into a SpriteAtlas with getPainted, or draw with paths); the owner colour as a band, flag
//     or plate, never a tint of the whole unit; draw finer than one CSS px where UnitDraw.dpr allows.
//   - ships (UnitArt): warship, destroyer, battleship, submarine, carrier, transport, trade ship, each easy to tell
//     apart at mid zoom; upgrade details (art/shared/keys.ts M_* bits); turretPoint for the salvo guns.
//   - land (UnitArt): tank division, light tank, heavy tank, plain and upgraded.
//   - air (UnitArt): bomber, ground attack, heavy bomber, fighter, transport plane, recon plane, plain and upgraded;
//     propeller discs (UnitDraw.timeMs), banking (UnitDraw.turnRate), a soft ground shadow (UnitDraw.shadow).
//   - missiles (UnitArt): rocket and atom bomb with an exhaust flame.
//   - troopIcons (TroopIconArt): infantry, armor, artillery and the unknown mix on an owner plate, size + 2 px square.
//   - wakes and contrails (TrailArt): soft foam wakes sized by speed, realistic vapour and smoke trails.
//   - explosions (ExplosionArt): realistic fire and smoke for every BlastKind and MapFxKind; craters (CraterArt):
//     scorched earth that weathers away; cannonFire (CannonArt): muzzle flash, smoke, shell arcs, tracers, torpedoes.
//   - paradrop (ParadropArt): real round canopies with rigging and a hanging soldier in the owner's colour, swaying
//     down onto the drop point, landing and collapsing, at every zoom; the small parachute mark on a cargo plane.
//   - lengthPx must match what drawUnit covers (the renderer sizes hit areas and rings from it).
//   - Motion: read only the MotionParams numbers (art/motion.ts), so subtle, lively and cinematic all work.
//   - Keep it fast: hundreds of units and dozens of blasts per frame; cache painted pictures (art/shared/atlas.ts).
// Rules: never import from art/refined or art/detailed (copying a file as a starting point is fine); shared helpers
// are in art/shared. Check it in the art lab (an art lab build, VITE_ART_LAB=1, opened at #artlab) and in the game
// (VITE_ART_STYLE=realistic).
import { refined } from '../refined';
import type { StyleModule } from '../types';

export const realistic: StyleModule = { ...refined, id: 'realistic' };
