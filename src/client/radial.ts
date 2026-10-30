// Radial (pie) menu for right click / long press on the map: the centre button is the most likely action for that
// tile, the other actions sit on a ring around it. Big round buttons (touch friendly), always fully on screen
// (the ring moves inwards near the screen edges, a dot marks the clicked point), submenus replace the ring.
import { el } from './menu';
import { hasLineIcon, lineIcon, worldGlyph, type WorldGlyphId } from './hud/glyph';

export type RadialIconName = string;

export interface RadialItem {
  /** short label under the button */
  label: string;
  /** line icon name (hud/glyph.ts) or a short text glyph */
  icon: string;
  /** a filled pictogram instead (buildings, abilities) */
  glyph?: WorldGlyphId;
  /** extra info for the caption: cost, troops sent */
  hint?: string;
  /** reason when the action is not possible now (button dimmed; tapping it shows the reason) */
  disabled?: string;
  danger?: boolean;
  /** background colour for glyph icons (building fill) */
  fill?: string;
  submenu?: () => RadialItem[];
  run?: () => void;
}

export interface RadialSpec {
  title: string;
  subtitle?: string;
  /** owner colour shown on the title */
  color?: string;
  /** primary action in the middle; null = just a close button */
  centre: RadialItem | null;
  slices: RadialItem[];
}

const BTN = 54; // slice button diameter (px), see .rad-btn in styles.css
const MIN_R = 88;
const EDGE = 12;

function iconEl(item: RadialItem): HTMLElement {
  const box = el('span', 'rad-ic');
  if (item.glyph) box.innerHTML = worldGlyph(item.glyph, 24);
  else if (hasLineIcon(item.icon)) box.innerHTML = lineIcon(item.icon, 22, 1.8);
  else {
    box.classList.add('glyph-txt');
    box.textContent = item.icon;
    if (item.fill) {
      box.style.background = item.fill;
      box.classList.add('filled');
    }
  }
  return box;
}

export class RadialMenu {
  readonly el: HTMLElement;
  private wrap: HTMLElement;
  private origin: HTMLElement;
  private caption: HTMLElement;
  private open_ = false;
  private spec: RadialSpec | null = null;
  private point = { x: 0, y: 0 };

  /** `onDone` runs after an action was chosen (the owner closes the menu and refreshes). */
  constructor(private onDone: () => void) {
    this.el = el('div', 'radial hidden');
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
    this.origin = el('div', 'rad-origin');
    this.wrap = el('div', 'rad-wrap');
    this.caption = el('div', 'rad-caption');
    this.el.append(this.origin, this.wrap);
  }

  get isOpen(): boolean {
    return this.open_;
  }

  /** Opens at screen point (x, y) (client coordinates). */
  open(x: number, y: number, spec: RadialSpec): void {
    this.point = { x, y };
    this.spec = spec;
    this.open_ = true;
    this.el.classList.remove('hidden');
    this.render(spec.centre, spec.slices, false);
  }

  close(): void {
    if (!this.open_) return;
    this.open_ = false;
    this.spec = null;
    this.el.classList.add('hidden');
    this.wrap.replaceChildren();
  }

  contains(n: Node | null): boolean {
    return !!n && this.el.contains(n);
  }

  private render(centre: RadialItem | null, slices: RadialItem[], sub: boolean): void {
    const spec = this.spec;
    if (!spec) return;
    const n = slices.length;
    const R = Math.max(MIN_R, (n * (BTN + 12)) / (2 * Math.PI));
    // Keep the ring and its labels on screen.
    const W = window.innerWidth;
    const H = window.innerHeight;
    const padX = R + BTN / 2 + 34 + EDGE;
    const padTop = R + BTN / 2 + 40 + EDGE;
    const padBottom = R + BTN / 2 + 76 + EDGE; // caption below the ring
    const cx = W < 2 * padX ? W / 2 : Math.min(Math.max(this.point.x, padX), W - padX);
    const cy = H < padTop + padBottom ? H / 2 : Math.min(Math.max(this.point.y, padTop), H - padBottom);
    const moved = Math.abs(cx - this.point.x) + Math.abs(cy - this.point.y) > 4;
    this.origin.classList.toggle('hidden', !moved);
    this.origin.style.transform = `translate(${Math.round(this.point.x)}px, ${Math.round(this.point.y)}px)`;
    this.wrap.style.transform = `translate(${Math.round(cx)}px, ${Math.round(cy)}px)`;
    this.wrap.replaceChildren();
    this.wrap.classList.remove('shown');

    const ring = el('div', 'rad-ring');
    const d = 2 * R + BTN + 10;
    ring.style.width = ring.style.height = `${d}px`;
    ring.style.transform = `translate(${-d / 2}px, ${-d / 2}px)`;
    this.wrap.append(ring);

    const title = el('div', 'rad-title');
    const tname = el('span', 'rad-tname', spec.title);
    title.append(tname);
    if (spec.subtitle) title.append(el('span', 'rad-tsub', spec.subtitle));
    if (spec.color) title.style.setProperty('--c', spec.color);
    title.style.transform = `translate(-50%, ${-R - BTN / 2 - 38}px)`;
    this.wrap.append(title);

    this.caption.style.transform = `translate(-50%, ${R + BTN / 2 + 26}px)`;
    this.wrap.append(this.caption);
    const defaultCaption = () => this.setCaption(centre ?? null, sub ? 'Back' : 'Close');

    slices.forEach((it, k) => {
      const a = -Math.PI / 2 + (k * 2 * Math.PI) / Math.max(1, n);
      const x = Math.cos(a) * R;
      const y = Math.sin(a) * R;
      const b = this.button(it, 'rad-btn', () => defaultCaption());
      b.style.setProperty('--x', `${x.toFixed(1)}px`);
      b.style.setProperty('--y', `${y.toFixed(1)}px`);
      b.style.transitionDelay = `${Math.min(k, 12) * 12}ms`;
      this.wrap.append(b);
    });

    // Centre: primary action, or Back / Close.
    const c: RadialItem = centre ?? (sub ? { label: 'Back', icon: 'back' } : { label: 'Close', icon: 'decline' });
    const cb = this.button(c, 'rad-centre' + (centre ? ' primary' : ''), () => defaultCaption());
    if (!centre) {
      cb.onclick = (e) => {
        e.stopPropagation();
        if (sub) this.render(spec.centre, spec.slices, false);
        else this.onDone();
      };
    }
    this.wrap.append(cb);
    defaultCaption();
    // Next frame: animate the slices out from the centre.
    requestAnimationFrame(() => this.wrap.classList.add('shown'));
    const first = this.wrap.querySelector<HTMLButtonElement>('.rad-centre');
    first?.focus({ preventScroll: true });
  }

  private button(it: RadialItem, cls: string, leave: () => void): HTMLButtonElement {
    const b = el('button', cls + (it.danger ? ' danger' : '') + (it.disabled ? ' off' : '') + (it.submenu ? ' has-sub' : ''));
    b.type = 'button';
    b.setAttribute('aria-label', it.label + (it.hint ? ` (${it.hint})` : ''));
    if (it.disabled) b.setAttribute('aria-disabled', 'true');
    b.append(iconEl(it), el('span', 'rad-label', it.label));
    b.addEventListener('pointerenter', () => this.setCaption(it));
    b.addEventListener('focus', () => this.setCaption(it));
    b.addEventListener('pointerleave', leave);
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (it.disabled) {
        this.setCaption(it);
        b.classList.remove('shake');
        void b.offsetWidth;
        b.classList.add('shake');
        return;
      }
      if (it.submenu) {
        this.render(null, it.submenu(), true);
        return;
      }
      it.run?.();
      this.onDone();
    });
    return b;
  }

  private setCaption(it: RadialItem | null, fallback = ''): void {
    this.caption.replaceChildren();
    if (!it) {
      this.caption.append(el('span', 'rad-cap-l', fallback));
      return;
    }
    this.caption.append(el('span', 'rad-cap-l', it.label));
    if (it.disabled) this.caption.append(el('span', 'rad-cap-bad', it.disabled));
    else if (it.hint) this.caption.append(el('span', 'rad-cap-h', it.hint));
  }
}
