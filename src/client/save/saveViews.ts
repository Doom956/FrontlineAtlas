// Start page parts of save and continue: the saved-game card (Continue / Delete), the "replace your saved game?"
// dialog and the loading page with its progress bar. DOM only; main.ts runs the load (replay.ts).
import { button, el, setText } from '../dom';
import { clockText, loadNote, loadSeconds, saveFacts, savedAgo, type SaveSlot } from './format';
import './save.css';

export interface SaveCardHooks {
  onContinue: () => void;
  /** the save was deleted (the card is gone already) */
  onDeleted: () => void;
  /** deletes the stored save */
  remove: () => void;
}

/** The start page's saved-game card: what the game is and Continue; Delete asks once, inline. */
export function saveCard(slot: SaveSlot, hooks: SaveCardHooks, now = Date.now()): HTMLElement {
  const card = el('section', `menu-save ${slot.status}`);
  card.dataset.test = 'menu-save';
  card.setAttribute('aria-label', 'Saved game');
  const body = el('div', 'menu-save-body');
  const foot = el('div', 'menu-save-foot');
  card.append(body, foot);

  if (slot.status === 'ok') {
    const { save } = slot;
    const text = el('div', 'menu-save-text');
    text.append(el('span', 'menu-save-map', save.meta.map), el('span', 'menu-save-facts', saveFacts(save.meta)));
    const go = button('Continue', 'primary big menu-save-go', () => hooks.onContinue());
    go.dataset.test = 'menu-continue';
    body.append(text, go);
    const when = el('span', 'menu-save-when', savedAgo(save.savedAt, now));
    const note = loadNote(loadSeconds(save));
    if (note) when.append(el('span', 'menu-save-slow', note));
    foot.append(when);
  } else {
    const text = el('div', 'menu-save-text');
    const head = slot.status === 'old' ? 'Saved game from an older version' : "Saved game that can't be read";
    const why = slot.status === 'old' ? "This version of the game can't load it." : 'The stored data is damaged.';
    text.append(el('span', 'menu-save-map', head), el('span', 'menu-save-facts', slot.status === 'old' && slot.meta ? `${slot.meta.map}. ${why}` : why));
    body.append(text);
    foot.append(el('span', 'menu-save-when', slot.status === 'old' && slot.savedAt !== null ? savedAgo(slot.savedAt, now) : ''));
  }

  const del = button('Delete', 'ghost mini menu-save-del', () => {
    // one inline question instead of a dialog: the card turns into it
    foot.replaceChildren();
    const ask = el('span', 'menu-save-ask', 'Delete this game for good?');
    const yes = button('Delete game', 'danger mini', () => {
      hooks.remove();
      card.remove();
      hooks.onDeleted();
    });
    yes.dataset.test = 'menu-save-delete-yes';
    const no = button('Keep', 'ghost mini', () => {
      card.replaceWith(saveCard(slot, hooks));
    });
    foot.append(ask, no, yes);
    no.focus({ preventScroll: true });
  });
  del.dataset.test = 'menu-save-delete';
  del.title = 'Delete the saved game';
  foot.append(del);
  return card;
}

/** A small modal question over the menu. Escape or a click outside counts as Cancel. */
export function askDialog(
  root: HTMLElement,
  opts: { title: string; text: string; confirm: string; cancel?: string; danger?: boolean; testId?: string },
  onConfirm: () => void,
): void {
  const back = el('div', 'modal save-ask');
  const card = el('div', 'modal-card save-ask-card');
  card.setAttribute('role', 'alertdialog');
  card.setAttribute('aria-modal', 'true');
  const title = el('h2', 'save-ask-title', opts.title);
  title.id = 'save-ask-title';
  card.setAttribute('aria-labelledby', title.id);
  const close = () => {
    back.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  const yes = button(opts.confirm, opts.danger ? 'danger' : 'primary', () => {
    close();
    onConfirm();
  });
  if (opts.testId) yes.dataset.test = opts.testId;
  const no = button(opts.cancel ?? 'Cancel', 'ghost', close);
  const row = el('div', 'save-ask-buttons');
  row.append(no, yes);
  card.append(title, el('p', 'save-ask-text', opts.text), row);
  back.append(card);
  back.addEventListener('click', (e) => {
    if (e.target === back) close();
  });
  document.addEventListener('keydown', onKey, true);
  root.append(back);
  no.focus({ preventScroll: true });
}

export interface LoadPageHooks {
  onCancel: () => void;
}

/**
 * The loading page: the map's name, a progress bar drawn like a map's scale bar, and the time left. A load that
 * fails or doesn't match turns the page into a short explanation with its choices (problem()).
 */
export class LoadPage {
  readonly el: HTMLElement;
  private bar: HTMLElement;
  private fill: HTMLElement;
  private status: HTMLElement;
  private left: HTMLElement;
  private body: HTMLElement;
  private actions: HTMLElement;

  constructor(map: string, expectedSeconds: number, hooks: LoadPageHooks) {
    this.el = el('div', 'save-load');
    this.el.dataset.test = 'save-load';
    const head = el('h2', 'save-load-title', 'Loading your game');
    const sub = el('p', 'save-load-map', map);
    this.body = el('div', 'save-load-body');
    this.bar = el('div', 'save-bar');
    this.bar.setAttribute('role', 'progressbar');
    this.bar.setAttribute('aria-label', 'Loading progress');
    this.bar.setAttribute('aria-valuemin', '0');
    this.bar.setAttribute('aria-valuemax', '100');
    this.fill = el('div', 'save-bar-fill');
    this.bar.append(this.fill);
    const line = el('div', 'save-load-line');
    this.status = el('span', 'save-load-status', 'Building the map');
    this.left = el('span', 'save-load-left', '');
    line.append(this.status, this.left);
    this.body.append(this.bar, line);
    const note = loadNote(expectedSeconds);
    if (note) this.body.append(el('p', 'save-load-note', 'A saved game loads by playing it again at full speed, so long games take a while.'));
    this.actions = el('div', 'save-load-actions');
    const cancel = button('Cancel', 'ghost', () => hooks.onCancel());
    cancel.dataset.test = 'save-load-cancel';
    this.actions.append(cancel);
    this.el.append(head, sub, this.body, this.actions);
    this.set(0, null);
  }

  /** Progress 0..1 and the seconds left (null = not known yet). */
  set(progress: number, secondsLeft: number | null, status?: string): void {
    const pct = Math.round(Math.max(0, Math.min(1, progress)) * 100);
    this.fill.style.width = `${pct}%`;
    this.bar.setAttribute('aria-valuenow', String(pct));
    if (status) setText(this.status, status);
    setText(this.left, secondsLeft === null ? '' : `About ${clockText(secondsLeft)} left`);
  }

  /** Replaces the bar with a message and buttons (a mismatch or an error). */
  problem(title: string, text: string, buttons: HTMLButtonElement[]): void {
    this.el.classList.add('problem');
    const head = this.el.querySelector('.save-load-title');
    if (head) head.textContent = title;
    this.body.replaceChildren(el('p', 'save-load-text', text));
    this.actions.replaceChildren(...buttons);
    buttons[buttons.length - 1]?.focus({ preventScroll: true });
  }
}
