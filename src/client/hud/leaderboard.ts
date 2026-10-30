// Top-left standings: top 5 nations by land plus you, one line each (rank, colour, name, land %, army).
// Click a row: centre on that nation and open its card. Collapses to a single line; "Show all" lists everyone.
import { isTeamGame, teamOf } from '../../sim/rules';
import { teamName } from '../../sim/victory';
import { areAllied, isTraitor } from '../../sim/diplomacy';
import type { GameState, Player } from '../../sim/types';
import { isTribe } from '../compat';
import { swatchCss } from './swatch';
import { formatCount } from '../render/common';
import { armyOf } from '../simx';
import { el, setClass, setText, setVisible, type HudCtx } from './dom';
import { iconSpan, lineIcon } from './glyph';

const TOP = 5;
const ALL_MAX = 40;

interface Row {
  root: HTMLButtonElement;
  rank: HTMLElement;
  sw: HTMLElement;
  name: HTMLElement;
  land: HTMLElement;
  army: HTMLElement;
}

export class Leaderboard {
  readonly el: HTMLElement;
  private list: HTMLElement;
  private rows = new Map<number, Row>();
  private order = '';
  private collapsed = false;
  private all = false;
  private more: HTMLButtonElement;
  private summary: HTMLElement;
  private chev: HTMLElement;

  constructor(private ctx: HudCtx) {
    this.el = el('section', 'lb');
    this.el.dataset.test = 'leaderboard';
    const head = el('button', 'lb-head');
    head.type = 'button';
    head.setAttribute('aria-label', 'Collapse or expand the standings');
    const title = el('span', 'wr-sec', 'Standings');
    this.summary = el('span', 'lb-sum');
    this.chev = iconSpan(lineIcon('chevronUp', 14, 2), 'ico lb-chev');
    head.append(title, this.summary, this.chev);
    head.addEventListener('click', () => {
      this.collapsed = !this.collapsed;
      setClass(this.el, 'collapsed', this.collapsed);
      this.chev.innerHTML = lineIcon(this.collapsed ? 'chevronDown' : 'chevronUp', 14, 2);
      ctx.refreshSoon();
    });
    this.list = el('div', 'lb-list');
    this.more = el('button', 'lb-more');
    this.more.type = 'button';
    this.more.addEventListener('click', () => {
      this.all = !this.all;
      setClass(this.el, 'all', this.all);
      this.order = '';
      ctx.refreshSoon();
    });
    this.el.append(head, this.list, this.more);
  }

  private makeRow(id: number): Row {
    const root = el('button', 'lb-row');
    root.type = 'button';
    const rank = el('span', 'c-rank');
    const sw = el('span', 'sw');
    const name = el('span', 'c-name');
    const land = el('span', 'c-land');
    const army = el('span', 'c-army');
    const nameBox = el('span', 'c-namebox');
    nameBox.append(sw, name);
    root.append(rank, nameBox, land, army);
    root.addEventListener('click', () => this.ctx.openNation(id));
    return { root, rank, sw, name, land, army };
  }

  update(s: GameState, me: Player): void {
    const ranked = s.players.filter((p) => p && p.id !== 0 && p.alive && p.spawned && !isTribe(p));
    ranked.sort((a, b) => b.tiles - a.tiles || a.id - b.id);
    const myRank = ranked.findIndex((p) => p.id === me.id) + 1;
    const land = Math.max(1, s.map.landTileCount);
    let shown: Player[];
    // short screens: top 3 + you, so the standings stay a small corner card
    const top = typeof window !== 'undefined' && window.innerHeight < 800 ? 3 : TOP;
    if (this.all) shown = ranked.slice(0, ALL_MAX);
    else {
      shown = ranked.slice(0, top);
      if (myRank > top) shown.push(me);
    }
    if (myRank > 0 && this.all && myRank > ALL_MAX) shown.push(me);
    // Teams: the summary shows your team's land added up (that is what wins).
    const myTeam = isTeamGame(s) ? teamOf(s, me.id) : 0;
    let teamTiles = 0;
    if (myTeam) for (const p of ranked) if (teamOf(s, p.id) === myTeam) teamTiles += p.tiles;
    const teamText = myTeam ? `${teamName(myTeam)}: ${((teamTiles / land) * 100).toFixed(1)}% land` : '';
    setText(this.summary, this.collapsed ? (myRank > 0 ? teamText || `You #${myRank} of ${ranked.length}, ${((me.tiles / land) * 100).toFixed(1)}% land` : `${ranked.length} nations`) : teamText || 'land, army');
    setText(this.more, this.all ? `Show top ${top}` : `Show all ${ranked.length}`);
    setVisible(this.more, ranked.length > top);
    const ids = new Set(shown.map((p) => p.id));
    for (const [id, r] of this.rows) {
      if (!ids.has(id)) {
        r.root.remove();
        this.rows.delete(id);
      }
    }
    for (const p of shown) {
      let r = this.rows.get(p.id);
      if (!r) {
        r = this.makeRow(p.id);
        this.rows.set(p.id, r);
      }
      const rank = ranked.indexOf(p) + 1;
      setText(r.rank, String(rank));
      r.sw.style.background = swatchCss(p, me.id);
      const isMe = p.id === me.id;
      setText(r.name, isMe ? `${p.name} (you)` : p.name);
      setText(r.land, `${((p.tiles / land) * 100).toFixed(1)}%`);
      setText(r.army, formatCount(armyOf(s, p.id)));
      setClass(r.root, 'me', isMe);
      setClass(r.root, 'ally', !isMe && areAllied(s, me.id, p.id));
      setClass(r.root, 'traitor', isTraitor(s, p.id));
      setClass(r.root, 'gap', !this.all && isMe && rank > top);
      const team = myTeam ? `\n${teamName(teamOf(s, p.id))}${teamOf(s, p.id) === myTeam ? ' (your team)' : ''}` : '';
      r.root.dataset.tip = (isMe ? 'Your nation: click to centre on your capital' : `Click: centre on ${p.name} and show their card`) + team;
    }
    const order = shown.map((p) => p.id).join(',');
    if (order !== this.order) {
      this.order = order;
      for (const p of shown) this.list.append(this.rows.get(p.id)!.root);
    }
  }
}
