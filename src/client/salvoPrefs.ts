// Salvo sizes for bombers, rockets and atom bombs (x1 / x3 / x5 / All), remembered per browser (client only).

export type SalvoKind = 'bomb' | 'rocket' | 'atomBomb';
/** x1 / x3 / x5 / All (0) */
export type SalvoSize = 1 | 3 | 5 | 0;
export const SALVO_SIZES: readonly SalvoSize[] = [1, 3, 5, 0];
export type SalvoPrefs = Record<SalvoKind, SalvoSize>;

const STORE_KEY = 'frontline.salvo.v1';

export function salvoLabel(n: SalvoSize): string {
  return n === 0 ? 'All' : `x${n}`;
}

function validSize(v: unknown): v is SalvoSize {
  return v === 1 || v === 3 || v === 5 || v === 0;
}

/** Remembered salvo sizes (bombs and rockets; atom bombs always start at x1). */
export function loadSalvo(): SalvoPrefs {
  const out: SalvoPrefs = { bomb: 1, rocket: 1, atomBomb: 1 };
  try {
    const raw = globalThis.localStorage?.getItem(STORE_KEY);
    if (!raw) return out;
    const v = JSON.parse(raw) as Partial<Record<SalvoKind, unknown>>;
    if (validSize(v.bomb)) out.bomb = v.bomb;
    if (validSize(v.rocket)) out.rocket = v.rocket;
  } catch {
    /* private mode / blocked storage: defaults */
  }
  return out;
}

export function saveSalvo(p: SalvoPrefs): void {
  try {
    globalThis.localStorage?.setItem(STORE_KEY, JSON.stringify({ bomb: p.bomb, rocket: p.rocket }));
  } catch {
    /* not remembered: fine */
  }
}

/** The next size (a right-click on a strike button cycles x1 -> x3 -> x5 -> All). */
export function nextSalvo(n: SalvoSize): SalvoSize {
  const i = SALVO_SIZES.indexOf(n);
  return SALVO_SIZES[(i + 1) % SALVO_SIZES.length];
}

