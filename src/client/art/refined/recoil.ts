// The hull rocking back when a ship fires (client only, refined style). The interface gives a ship's drawUnit no word
// of its guns firing, and the muzzle flashes are drawn after the units, so the cannon art (cannon.ts) notes each flash
// it draws here, stamped with the unit clock of that frame, and the ship art (sprites.ts) looks for a flash on its own
// hull in the next frame: the hull is then pushed back away from the shot by MotionParams.recoil art px, easing back
// as the flash fades. A frame late and keyed by screen position, but small, bounded (a fixed ring of notes) and only
// ever a visual offset.

const CAP = 48;
const nx = new Float32Array(CAP);
const ny = new Float32Array(CAP);
const naim = new Float32Array(CAP);
const nt = new Float32Array(CAP);
const nstamp = new Float64Array(CAP).fill(-1e12);
let head = 0;
/** the newest unit clock seen (ms): the stamp of the notes taken this frame */
let clock = 0;

/** The unit art calls this with every unit it draws (u.timeMs). */
export function seeClock(ms: number): void {
  if (ms > clock || ms < clock - 5000) clock = ms;
}

/** A muzzle flash at (x, y) aimed at `aim`, `t` 0..1 through the flash. */
export function noteMuzzle(x: number, y: number, aim: number, t: number): void {
  nx[head] = x;
  ny[head] = y;
  naim[head] = aim;
  nt[head] = t;
  nstamp[head] = clock;
  head = (head + 1) % CAP;
}

/**
 * How far a ship at (x, y), `reach` px long from its centre, is pushed back by its own guns right now (screen px along
 * x and y, before rounding): `px` is MotionParams.recoil times the map's px per art pixel.
 */
export function recoilAt(x: number, y: number, reach: number, now: number, px: number): [number, number] {
  if (px <= 0) return [0, 0];
  let dx = 0;
  let dy = 0;
  const r2 = reach * reach;
  for (let i = 0; i < CAP; i++) {
    const age = now - nstamp[i];
    if (age < 0 || age > 140) continue;
    const ex = nx[i] - x;
    const ey = ny[i] - y;
    if (ex * ex + ey * ey > r2) continue;
    // a hard kick, then easing back as the flash fades
    const e = (1 - nt[i]) * (1 - nt[i]);
    if (e * px > Math.hypot(dx, dy)) {
      dx = -Math.cos(naim[i]) * e * px;
      dy = -Math.sin(naim[i]) * e * px;
    }
  }
  return [dx, dy];
}
