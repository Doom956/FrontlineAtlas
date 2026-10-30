// Small DOM helpers shared by the menu, the setup screen and the HUD.

/** Creates an element with an optional class string and text. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Button with a click handler. */
export function button(label: string, cls: string, onClick: (e: MouseEvent) => void): HTMLButtonElement {
  const b = el('button', 'btn ' + cls, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

export function rgbCss(c: readonly [number, number, number], a = 1): string {
  return a >= 1 ? `rgb(${c[0]},${c[1]},${c[2]})` : `rgba(${c[0]},${c[1]},${c[2]},${a})`;
}

/** Text setter that skips the DOM write when nothing changed. */
export function setText(e: HTMLElement, text: string): void {
  if (e.textContent !== text) e.textContent = text;
}

