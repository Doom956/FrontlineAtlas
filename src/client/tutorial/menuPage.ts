// Menu side of the tutorial: the chapter list page (done ticks, minutes, one line each) and the one-time
// "New here? Try the tutorial" hint on the title screen.
import { button, el } from '../dom';
import { iconSpan, lineIcon } from '../hud/glyph';
import { firstOpenChapter, loadProgress, markSuggested, suggestionDue, type TutorialChapterId } from './engine';
import { tutorialChapters } from './catalog';
import './tutorial.css';

/** The hint shows on every title screen of the page load where it first appeared (and never after that). */
let hintThisLoad: boolean | null = null;

/** The title screen's hint row, or null once it was shown in an earlier visit. */
export function tutorialHint(onStart: (id: TutorialChapterId) => void): HTMLElement | null {
  if (hintThisLoad === null) {
    hintThisLoad = suggestionDue();
    if (hintThisLoad) markSuggested();
  }
  if (!hintThisLoad) return null;
  const first = tutorialChapters()[0];
  if (!first) return null;
  const row = el('div', 'menu-hint');
  row.dataset.test = 'tutorial-hint';
  const go = button(`Start ${first.title}`, 'primary', () => {
    hintThisLoad = false;
    onStart(first.id);
  });
  go.classList.add('wr-btn', 'mini');
  row.append(el('span', '', 'New here? Try the tutorial.'), go);
  return row;
}

/** Fills the menu card with the chapter list. */
export function showTutorialPage(card: HTMLElement, cb: { onBack: () => void; onStart: (id: TutorialChapterId) => void }): void {
  hintThisLoad = false;
  const top = el('div', 'menu-head');
  top.append(button('Back', 'ghost', cb.onBack), el('h2', '', 'Tutorial'));
  const note = el('p', 'tut-list-note', 'Short practice games, one topic each. Play them in order or pick any.');
  const chapters = tutorialChapters();
  const { done } = loadProgress();
  const next = firstOpenChapter(chapters, done);
  const list = el('ol', 'tut-chapters');
  list.dataset.test = 'tut-chapter-list';
  let focus: HTMLButtonElement | null = null;
  chapters.forEach((c, k) => {
    const isDone = done.includes(c.id);
    const li = el('li');
    const b = el('button', 'tut-ch' + (isDone ? ' done' : '') + (c === next && !isDone ? ' next' : ''));
    b.type = 'button';
    b.dataset.test = `tut-ch-${c.id}`;
    const n = el('span', 'tut-ch-n');
    if (isDone) n.append(iconSpan(lineIcon('accept', 16, 2.4)));
    else n.textContent = String(k + 1);
    const body = el('span', 'tut-ch-body');
    body.append(el('span', 'tut-ch-t', c.title), el('span', 'tut-ch-b', c.blurb));
    const m = el('span', 'tut-ch-m', isDone ? `Done · ${c.minutes} min` : `${c.minutes} min`);
    b.append(n, body, m);
    b.setAttribute('aria-label', `Chapter ${k + 1}: ${c.title}. ${c.blurb} About ${c.minutes} minutes.${isDone ? ' Done.' : ''}`);
    b.addEventListener('click', () => cb.onStart(c.id));
    b.addEventListener('keydown', (e) => {
      // arrow keys move between chapters
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const all = [...list.querySelectorAll<HTMLButtonElement>('.tut-ch')];
      const i = all.indexOf(b) + (e.key === 'ArrowDown' ? 1 : -1);
      all[Math.max(0, Math.min(all.length - 1, i))]?.focus();
    });
    if (c === next) focus = b;
    li.append(b);
    list.append(li);
  });
  const body = el('div', 'menu-scroll');
  body.append(note, list);
  card.append(top, body);
  (focus as HTMLButtonElement | null)?.focus({ preventScroll: true });
}
