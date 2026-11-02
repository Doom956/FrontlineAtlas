// Menu side of the tutorial: the title screen's Tutorial row (starts the tutorial at once). Its note says how long it
// takes, or that it was finished. On a player's first visit the row is marked "New? Start here" (the first-visit hint).
import { button, el } from '../dom';
import { iconSpan, lineIcon } from '../hud/glyph';
import { isChapterDone, markSuggested, suggestionDue } from './engine';
import { QUICK_TUTORIAL } from './steps';
import './tutorial.css';

/** The hint shows on every title screen of the page load where it first appeared (and never after that). */
let hintThisLoad: boolean | null = null;

function hintDue(): boolean {
  if (hintThisLoad === null) {
    hintThisLoad = suggestionDue();
    if (hintThisLoad) markSuggested();
  }
  return hintThisLoad;
}

/** The title screen's Tutorial row (a `.menu-row` button; menu.ts styles it). */
export function tutorialButton(onStart: () => void): HTMLButtonElement {
  const done = isChapterDone(QUICK_TUTORIAL.id);
  const hint = !done && hintDue();
  const b = button('', 'menu-row', () => {
    hintThisLoad = false;
    onStart();
  });
  b.dataset.test = 'menu-tutorial';
  const label = el('span', 'menu-row-label', 'Tutorial');
  if (hint) {
    b.classList.add('suggested');
    const tag = el('span', 'menu-row-hint', 'New? Start here');
    tag.dataset.test = 'tutorial-hint';
    label.append(tag);
  }
  const note = el('span', 'menu-row-note tut-menu-note' + (done ? ' done' : ''));
  note.dataset.test = 'menu-tutorial-note';
  if (done) note.append(iconSpan(lineIcon('accept', 12, 2.4)), document.createTextNode(' Done'));
  else note.textContent = `${QUICK_TUTORIAL.minutes} min`;
  b.append(label, note, iconSpan(lineIcon('chevronRight', 16, 2)));
  b.title = done ? 'Play the tutorial again: the basics in one short practice game' : 'The basics in one short practice game, step by step';
  return b;
}
