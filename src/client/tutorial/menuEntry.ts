// Menu side of the tutorial: the title screen's Tutorial button (starts the tutorial at once; a short note says how
// long it takes, or that it was finished) and the one-time "New here? Try the tutorial" hint.
import { button, el } from '../dom';
import { iconSpan, lineIcon } from '../hud/glyph';
import { isChapterDone, markSuggested, suggestionDue } from './engine';
import { QUICK_TUTORIAL } from './steps';
import './tutorial.css';

/** The hint shows on every title screen of the page load where it first appeared (and never after that). */
let hintThisLoad: boolean | null = null;

/** The title screen's Tutorial button. */
export function tutorialButton(onStart: () => void): HTMLButtonElement {
  const done = isChapterDone(QUICK_TUTORIAL.id);
  const b = button('', 'big', () => {
    hintThisLoad = false;
    onStart();
  });
  b.dataset.test = 'menu-tutorial';
  const note = el('span', 'tut-menu-note' + (done ? ' done' : ''));
  note.dataset.test = 'menu-tutorial-note';
  if (done) note.append(iconSpan(lineIcon('accept', 12, 2.4)), document.createTextNode(' Done'));
  else note.textContent = `${QUICK_TUTORIAL.minutes} min`;
  b.append(el('span', '', 'Tutorial'), note);
  b.title = done ? 'Play the tutorial again: the basics in one short practice game' : 'The basics in one short practice game, step by step';
  return b;
}

/** The title screen's hint row, or null once it was shown in an earlier visit. */
export function tutorialHint(onStart: () => void): HTMLElement | null {
  if (hintThisLoad === null) {
    hintThisLoad = suggestionDue();
    if (hintThisLoad) markSuggested();
  }
  if (!hintThisLoad) return null;
  const row = el('div', 'menu-hint');
  row.dataset.test = 'tutorial-hint';
  const go = button('Start tutorial', 'primary', () => {
    hintThisLoad = false;
    onStart();
  });
  go.classList.add('wr-btn', 'mini');
  row.append(el('span', '', `New here? Try the ${QUICK_TUTORIAL.minutes}-minute tutorial.`), go);
  return row;
}
