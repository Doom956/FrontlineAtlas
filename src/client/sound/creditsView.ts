// The Credits section (title screen and the in-game Menu): the CC BY credit lines exactly as the sound candidates'
// manifest gives them, then the CC0 files as thanks. The web addresses in a line are links (the text stays as given).
import { el } from '../dom';
import { CC0_THANKS, CC_BY_CREDITS } from './credits.gen';

const URL_RE = /(https?:\/\/[^\s)]+)/g;

function linked(text: string): HTMLElement {
  const li = el('li', 'credit-line');
  let at = 0;
  for (const m of text.matchAll(URL_RE)) {
    const i = m.index ?? 0;
    if (i > at) li.append(document.createTextNode(text.slice(at, i)));
    const a = el('a', '', m[0]);
    a.href = m[0];
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    li.append(a);
    at = i + m[0].length;
  }
  if (at < text.length) li.append(document.createTextNode(text.slice(at)));
  return li;
}

export function creditsContent(): HTMLElement {
  const root = el('div', 'credits');
  root.dataset.test = 'credits';
  root.append(el('p', 'credits-intro', 'Frontline Atlas is made by Doom956. The art is drawn in code. The sounds and music are recordings and music made by people.'));
  root.append(el('h3', 'credits-h', 'Sound and music (CC BY)'));
  const by = el('ul', 'credits-list');
  for (const line of CC_BY_CREDITS) by.append(linked(line));
  root.append(by);
  root.append(el('h3', 'credits-h', 'With thanks (CC0)'));
  const zero = el('ul', 'credits-list');
  for (const c of CC0_THANKS) zero.append(linked(`"${c.title}" by ${c.author} (${c.source}), ${c.licence}`));
  root.append(zero);
  return root;
}
