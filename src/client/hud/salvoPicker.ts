// Salvo size picker x1 / x3 / x5 / All for bombing runs, rockets and atom bombs: in the aiming chip at the top while a
// bomb or missile is aimed, and on the strike buttons (right-click cycles). One click then sends that many: bombers
// from every ready airfield in reach (nearest first), missiles from every loaded silo. Bombs and rockets are
// remembered (salvoPrefs.ts); atom bombs start at x1 and a salvo of them asks first (input.ts).
import { nextSalvo, SALVO_SIZES, salvoLabel, saveSalvo, type SalvoKind, type SalvoSize } from '../salvoPrefs';
import { salvoKindOf, salvoOf, strikeOfMode, strikeStatus } from '../strikes';
import type { UiState } from '../uiState';
import type { GameState, Player } from '../../sim/types';
import { el, setClass, setText, setVisible, type HudCtx } from './dom';

const UNIT: Record<SalvoKind, [string, string]> = { bomb: ['bomber', 'bombers'], rocket: ['rocket', 'rockets'], atomBomb: ['atom bomb', 'atom bombs'] };

/** Sets a strike's salvo size (remembered for bombs and rockets). */
export function setSalvo(ui: UiState, kind: SalvoKind, n: SalvoSize): void {
  ui.salvo = { ...ui.salvo, [kind]: n };
  saveSalvo(ui.salvo);
}

/** Right-click on a strike button: the next size. Returns the new size. */
export function cycleSalvo(ui: UiState, kind: SalvoKind): SalvoSize {
  const n = nextSalvo(salvoOf(ui, kind));
  setSalvo(ui, kind, n);
  return n;
}

/** "x3: 3 of 7 bombers ready fly per click". */
export function salvoTip(kind: SalvoKind, n: SalvoSize): string {
  const [one, many] = UNIT[kind];
  if (n === 1) return `x1: one ${one} per click`;
  if (n === 0) return `All: every ready ${one} ${kind === 'bomb' ? 'in reach ' : ''}flies at once`;
  return `x${n}: ${n} ${many} per click (fewer when fewer are ready)`;
}

export class SalvoPicker {
  readonly el: HTMLElement;
  private kind: SalvoKind | null = null;
  private btns: { n: SalvoSize; b: HTMLButtonElement }[];
  private ready: HTMLElement;

  constructor(private ctx: HudCtx) {
    this.el = el('div', 'salvo hidden');
    this.el.dataset.test = 'salvo';
    const box = el('div', 'bm-count salvo-sizes');
    box.setAttribute('role', 'radiogroup');
    box.setAttribute('aria-label', 'Salvo size');
    this.btns = SALVO_SIZES.map((n) => {
      const b = el('button', 'bm-cnt', salvoLabel(n));
      b.type = 'button';
      b.dataset.test = `salvo-${n === 0 ? 'all' : n}`;
      b.setAttribute('role', 'radio');
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        b.blur();
        if (!this.kind) return;
        setSalvo(this.ctx.ui, this.kind, n);
        this.sync();
        this.ctx.refreshSoon();
      });
      box.append(b);
      return { n, b };
    });
    this.ready = el('span', 'salvo-n');
    this.el.append(el('span', 'salvo-l', 'Salvo'), box, this.ready);
  }

  private sync(): void {
    if (!this.kind) return;
    const cur = salvoOf(this.ctx.ui, this.kind);
    for (const { n, b } of this.btns) {
      setClass(b, 'on', cur === n);
      b.setAttribute('aria-checked', String(cur === n));
      b.dataset.tip = salvoTip(this.kind, n);
    }
  }

  /** Every frame (cheap): shows for a bomb / missile aim, with how many are ready. */
  update(s: GameState, me: Player): void {
    const kind = salvoKindOf(strikeOfMode(this.ctx.ui.mode));
    setVisible(this.el, kind !== null);
    if (!kind) {
      this.kind = null;
      return;
    }
    this.kind = kind;
    this.sync();
    const st = strikeStatus(s, me, kind);
    const [one, many] = UNIT[kind];
    setText(this.ready, st.count >= 0 ? `${st.count} ${st.count === 1 ? one : many} ready` : '');
  }
}
