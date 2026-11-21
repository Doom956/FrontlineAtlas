// Menu side of the tutorials: the title screen's Tutorial row (opens the Tutorials list) and the list itself: the
// basics first (marked "Start here" until finished), then a card for each chapter with its icon, plain name, about how
// long it takes and a tick once it was finished. Nothing is locked. When every tutorial is done the row carries a small
// "All tutorials done" badge. On a player's first visit the row is marked "New? Start here" (the first-visit hint).
import { button, el } from '../dom';
import { iconSpan, lineIcon } from '../hud/glyph';
import { ALL_TUTORIALS, allTutorialsDone } from './catalog';
import { doneChapters, markSuggested, suggestionDue, type TutorialChapter, type TutorialChapterId } from './engine';
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

/** The title screen's Tutorial row (a `.menu-row` button; menu.ts styles it). It opens the Tutorials list. */
export function tutorialButton(onOpen: () => void): HTMLButtonElement {
  const done = doneChapters();
  const basicsDone = done.includes('basics');
  const all = allTutorialsDone(done);
  const hint = !basicsDone && hintDue();
  const b = button('', 'menu-row', () => {
    hintThisLoad = false;
    onOpen();
  });
  b.dataset.test = 'menu-tutorial';
  const label = el('span', 'menu-row-label', 'Tutorials');
  if (hint) {
    b.classList.add('suggested');
    const tag = el('span', 'menu-row-hint', 'New? Start here');
    tag.dataset.test = 'tutorial-hint';
    label.append(tag);
  }
  const note = el('span', 'menu-row-note tut-menu-note' + (all ? ' done' : ''));
  note.dataset.test = 'menu-tutorial-note';
  if (all) {
    note.append(iconSpan(lineIcon('accept', 12, 2.4)), document.createTextNode(' All tutorials done'));
    note.dataset.test = 'tutorials-all-done';
  } else note.textContent = `${done.filter((id) => ALL_TUTORIALS.some((c) => c.id === id)).length} of ${ALL_TUTORIALS.length} done`;
  b.append(label, note, iconSpan(lineIcon('chevronRight', 16, 2)));
  b.title = 'Learn the game step by step: the basics, then short lessons on the navy, air, armor, defense, diplomacy, supply and seasons';
  return b;
}

/** One card of the Tutorials list. */
function card(c: TutorialChapter, done: boolean, startHere: boolean, onStart: (id: TutorialChapterId) => void): HTMLButtonElement {
  const b = button('', 'menu-row tut-card-row' + (startHere ? ' suggested' : ''), () => onStart(c.id));
  b.dataset.test = `tut-card-${c.id}`;
  b.append(iconSpan(lineIcon(c.icon ?? 'play', 20), 'ico menu-row-lead'));
  const text = el('span', 'tut-card-text');
  const name = el('span', 'tut-card-name', c.title);
  if (startHere) {
    const tag = el('span', 'tut-card-start', 'Start here');
    tag.dataset.test = 'tut-start-here';
    name.append(tag);
  }
  text.append(name, el('span', 'tut-card-blurb', c.blurb ?? ''));
  const note = el('span', 'menu-row-note tut-menu-note' + (done ? ' done' : ''));
  note.dataset.test = `tut-card-note-${c.id}`;
  if (done) note.append(iconSpan(lineIcon('accept', 12, 2.4)), document.createTextNode(' Done'));
  else note.textContent = `about ${c.minutes} min`;
  b.append(text, note, iconSpan(lineIcon('chevronRight', 16, 2)));
  b.setAttribute('aria-label', `${c.title}: ${c.blurb ?? ''}, about ${c.minutes} minutes${done ? ', done' : ''}`);
  return b;
}

/** The Tutorials list: the basics first, then the chapters (each opens its game through onStart). */
export function tutorialList(onStart: (id: TutorialChapterId) => void): HTMLElement {
  const done = doneChapters();
  const list = el('nav', 'menu-rows tut-list-menu');
  list.setAttribute('aria-label', 'Tutorials');
  list.dataset.test = 'tutorial-list';
  for (const c of ALL_TUTORIALS) list.append(card(c, done.includes(c.id), c.id === 'basics' && !done.includes('basics'), onStart));
  return list;
}
