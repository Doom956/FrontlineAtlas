// The Settings panel: four tabs (Sound, Display, Gameplay, About), shared by the title screen's Settings page
// (menu.ts) and the in-game Menu drawer (hud/drawers.ts SettingsPage). Every control saves at once (settings/store.ts)
// and applies at once (settings/apply.ts and the parts that read the store); each tab has its own Reset to defaults.
// Tabs are plain buttons in the Tab order (no arrow-key handling, so no new keys); the open tab is remembered while
// the page is open.
import { el, setText } from '../dom';
import { iconSpan, lineIcon } from '../hud/glyph';
import { btn, setClass, slider, syncSlider } from '../hud/dom';
import { deviceReducedMotion } from '../fx/settings';
import { creditsContent } from '../sound/creditsView';
import { clientBuildId } from '../../net/client';
import { PROTOCOL_VERSION } from '../../net/protocol';
import { qualityInfo, testSound } from './apply';
import { DISPLAY_KEYS, getSettings, resetSettings, setSetting, SOUND_KEYS, type Quality, type ReduceMotion } from './store';
import './settings.css';

export type SettingsTab = 'sound' | 'display' | 'gameplay' | 'about';
export const SETTINGS_TABS: readonly { id: SettingsTab; label: string; icon: string }[] = [
  { id: 'sound', label: 'Sound', icon: 'sound' },
  { id: 'display', label: 'Display', icon: 'eye' },
  { id: 'gameplay', label: 'Gameplay', icon: 'help' },
  { id: 'about', label: 'About', icon: 'info' },
];

/** The advisor and the guide: the live HUD in a game, their saved picks on the title screen. */
export interface GameplayHooks {
  advisorOn(): boolean;
  setAdvisor(on: boolean): void;
  guideOn(): boolean;
  setGuide(on: boolean): void;
  restartGuide(): void;
  /** what Restart guide does here (shown under it) */
  restartNote: string;
  /** online games: the chat on/off switch */
  chat?: { on(): boolean; set(on: boolean): void };
}

export interface SettingsPanelOptions {
  gameplay: GameplayHooks;
  /** in a game: rows added at the end of the Display tab (the map overlays of this game) */
  displayExtra?: (sec: HTMLElement, sync: (fn: () => void) => void) => void;
}

/** One button per choice (the segmented control of the HUD, .segc). The container carries `test` as data-test. */
function choice<T extends string>(items: readonly { v: T; label: string }[], pick: (v: T) => void, test?: string): { el: HTMLElement; set: (v: T) => void; buttons: HTMLButtonElement[] } {
  const g = el('div', 'segc');
  if (test) g.dataset.test = test;
  const buttons = items.map(({ v, label }) => {
    const b = el('button', 'segc-b', label);
    b.type = 'button';
    b.dataset.value = v;
    b.addEventListener('click', () => pick(v));
    g.append(b);
    return b;
  });
  return {
    el: g,
    buttons,
    set: (v) => {
      for (const b of buttons) {
        const on = b.dataset.value === v;
        setClass(b, 'on', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
    },
  };
}

/** A setting's name over its control, and an optional plain note under it. */
function field(label: string, control: HTMLElement, note?: HTMLElement | string): HTMLElement {
  const f = el('div', 'set-field');
  f.append(el('div', 'set-label', label), control);
  if (note) f.append(typeof note === 'string' ? el('p', 'note', note) : note);
  return f;
}

let lastTab: SettingsTab = 'sound';

export class SettingsPanel {
  readonly el: HTMLElement;
  private tabs = new Map<SettingsTab, { tab: HTMLButtonElement; sec: HTMLElement }>();
  private syncs: (() => void)[] = [];
  private tab: SettingsTab = lastTab;

  constructor(private opts: SettingsPanelOptions) {
    this.el = el('div', 'set-panel');
    this.el.dataset.test = 'settings-panel';
    const bar = el('div', 'set-tabs');
    bar.setAttribute('role', 'tablist');
    bar.setAttribute('aria-label', 'Settings');
    this.el.append(bar);
    for (const t of SETTINGS_TABS) {
      const tab = el('button', 'set-tab');
      tab.type = 'button';
      tab.id = `set-tab-${t.id}`;
      tab.dataset.test = `settings-tab-${t.id}`;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', `set-sec-${t.id}`);
      tab.append(iconSpan(lineIcon(t.icon, 16)), el('span', 'set-tab-l', t.label));
      tab.addEventListener('click', () => this.show(t.id));
      bar.append(tab);
      const sec = el('section', 'set-sec');
      sec.id = `set-sec-${t.id}`;
      sec.dataset.test = `settings-sec-${t.id}`;
      sec.setAttribute('role', 'tabpanel');
      sec.setAttribute('aria-labelledby', tab.id);
      this.el.append(sec);
      this.tabs.set(t.id, { tab, sec });
    }
    this.buildSound(this.sec('sound'));
    this.buildDisplay(this.sec('display'));
    this.buildGameplay(this.sec('gameplay'));
    this.buildAbout(this.sec('about'));
    this.show(this.tab);
  }

  private sec(id: SettingsTab): HTMLElement {
    return this.tabs.get(id)!.sec;
  }

  /** Opens a tab (remembered for the next time the panel is made). */
  show(id: SettingsTab): void {
    this.tab = lastTab = id;
    for (const [k, { tab, sec }] of this.tabs) {
      const on = k === id;
      setClass(tab, 'on', on);
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
      sec.hidden = !on;
    }
    this.sync();
  }
  get openTab(): SettingsTab {
    return this.tab;
  }

  /** Shows the settings as they are now (the drawer calls it every frame; the title page after each change). */
  sync(): void {
    for (const f of this.syncs) f();
  }

  /** "Reset to defaults" at the end of a tab, with a short line that says it happened. */
  private resetRow(sec: HTMLElement, id: SettingsTab, label: string, reset: () => void): void {
    const said = el('p', 'note set-said');
    said.setAttribute('aria-live', 'polite');
    const b = btn(label, 'ghost wide set-reset', () => {
      reset();
      this.sync();
      setText(said, 'Back to the defaults.');
      setTimeout(() => setText(said, ''), 2500);
    }, 'reset');
    b.dataset.test = `settings-reset-${id}`;
    sec.append(b, said);
  }

  // ---------------------------------------------------------------------------------------------- Sound

  private buildSound(sec: HTMLElement): void {
    const vol = (label: string, key: 'master' | 'sfx' | 'music', test: string) => {
      const row = el('div', 'slider-row');
      const s = slider(0, 100, 5);
      s.setAttribute('aria-label', `${label} volume`);
      s.dataset.test = test;
      const v = el('span', 'sv');
      s.addEventListener('input', () => {
        setSetting(key, Number(s.value) / 100);
        setText(v, `${s.value}%`);
        this.sync();
      });
      row.append(el('span', 'sl', label), s, v);
      sec.append(row);
      this.syncs.push(() => {
        const pct = Math.round(getSettings()[key] * 100);
        syncSlider(s, pct);
        setText(v, `${pct}%`);
      });
    };
    sec.append(el('div', 'set-label', 'Volume'));
    vol('Master', 'master', 'vol-master');
    vol('Effects', 'sfx', 'vol-effects');
    vol('Music', 'music', 'vol-music');
    const mute = choice([{ v: 'on', label: 'Sound on' }, { v: 'off', label: 'Muted' }], (v) => {
      setSetting('muted', v === 'off');
      this.sync();
    }, 'mute-toggle');
    sec.append(mute.el);
    this.syncs.push(() => mute.set(getSettings().muted ? 'off' : 'on'));
    // a short sound to check the volume; says why when it cannot play
    const why = el('p', 'note set-why');
    let unavailable = false;
    const test = btn('Test sound', 'wide', () => {
      unavailable = !testSound();
      this.sync();
    }, 'sound');
    test.dataset.test = 'settings-test-sound';
    sec.append(test, why);
    this.syncs.push(() => {
      const s = getSettings();
      const reason = s.muted ? 'Sound is muted: pick Sound on to test it.' : s.master <= 0 ? 'Master is at 0%: turn it up to test.' : s.sfx <= 0 ? 'Effects is at 0%: turn it up to test.' : unavailable ? 'Sound is not available in this browser.' : '';
      test.disabled = !!reason;
      setText(why, reason);
    });
    sec.append(el('p', 'note', 'Fighting is heard where you look: zoom in close to hear the guns, zoom out for quiet. News about your nation always sounds.'));
    this.resetRow(sec, 'sound', 'Reset sound to defaults', () => resetSettings(SOUND_KEYS));
  }

  // ---------------------------------------------------------------------------------------------- Display

  private buildDisplay(sec: HTMLElement): void {
    // the map look, the unit art and motion and the map effects are not picked here: every player gets the defaults
    // (settings/store.ts LOOK_KEYS)
    const reduceNote = el('p', 'note');
    const reduce = choice<ReduceMotion>([{ v: 'device', label: 'Auto' }, { v: 'on', label: 'On' }, { v: 'off', label: 'Off' }], (v) => {
      setSetting('reduceMotion', v);
      this.sync();
    }, 'settings-reduce-motion');
    sec.append(field('Reduce motion', reduce.el, reduceNote));
    this.syncs.push(() => {
      reduce.set(getSettings().reduceMotion);
      setText(reduceNote, `On stops the screen shake and the bobbing, pulsing and swaying, and blasts show a still picture. Auto follows your device, which asks for ${deviceReducedMotion() ? 'less motion' : 'full motion'}.`);
    });

    const qualityNote = el('p', 'note');
    const quality = choice<Quality>([{ v: 'auto', label: 'Auto' }, { v: 'high', label: 'High' }, { v: 'low', label: 'Low' }], (v) => {
      setSetting('quality', v);
      this.sync();
    }, 'settings-quality');
    sec.append(field('Graphics quality', quality.el, qualityNote));
    this.syncs.push(() => {
      const q = getSettings().quality;
      quality.set(q);
      const info = qualityInfo();
      const now = info ? (q === 'auto' ? ` Auto uses ${info.software ? 'Low here: this browser draws without a graphics card' : 'High here'}.` : '') : '';
      setText(qualityNote, `Low draws a simpler map at half the sharpness and fewer frames a second, for slow computers.${now}`);
    });

    this.opts.displayExtra?.(sec, (fn) => this.syncs.push(fn));
    this.resetRow(sec, 'display', 'Reset display to defaults', () => resetSettings(DISPLAY_KEYS));
  }

  // ---------------------------------------------------------------------------------------------- Gameplay

  private buildGameplay(sec: HTMLElement): void {
    const g = this.opts.gameplay;
    const adv = choice([{ v: 'on', label: 'Advisor on' }, { v: 'off', label: 'Advisor off' }], (v) => {
      g.setAdvisor(v === 'on');
      this.sync();
    }, 'advisor-toggle');
    sec.append(field('Advisor', adv.el, 'The advisor line above the command bar suggests a useful next step.'));
    this.syncs.push(() => adv.set(g.advisorOn() ? 'on' : 'off'));
    const guide = choice([{ v: 'on', label: 'Guide on' }, { v: 'off', label: 'Guide off' }], (v) => {
      g.setGuide(v === 'on');
      this.sync();
    }, 'guide-toggle');
    sec.append(field('Guide', guide.el, 'The guide bar walks you through your first game and explains new things once.'));
    this.syncs.push(() => guide.set(g.guideOn() ? 'on' : 'off'));
    const said = el('p', 'note set-said');
    said.setAttribute('aria-live', 'polite');
    const restart = btn('Restart guide', 'wide', () => {
      g.restartGuide();
      this.sync();
      setText(said, g.restartNote);
    }, 'help');
    restart.dataset.test = 'guide-restart';
    sec.append(restart, said);
    if (g.chat) {
      const chat = g.chat;
      const sw = choice([{ v: 'on', label: 'Chat on' }, { v: 'off', label: 'Chat off' }], (v) => {
        chat.set(v === 'on');
        this.sync();
      }, 'chat-toggle');
      sec.append(field('Chat', sw.el, 'Chat off hides messages and the Chat button. Turn it back on here.'));
      this.syncs.push(() => sw.set(chat.on() ? 'on' : 'off'));
    }
    this.resetRow(sec, 'gameplay', 'Reset gameplay to defaults', () => {
      g.setAdvisor(true);
      g.setGuide(true);
      g.chat?.set(true);
    });
  }

  // ---------------------------------------------------------------------------------------------- About

  private buildAbout(sec: HTMLElement): void {
    const facts = el('dl', 'set-facts');
    facts.dataset.test = 'settings-version';
    const fact = (k: string, v: string) => facts.append(el('dt', '', k), el('dd', '', v));
    fact('Version', appVersion());
    fact('Build', clientBuildId());
    fact('Multiplayer version', String(PROTOCOL_VERSION));
    const date = buildDate();
    if (date) fact('Built on', date);
    sec.append(el('div', 'set-label', 'Frontline Atlas'), facts, el('div', 'set-label', 'Credits'), creditsContent());
  }
}

/** package.json's version (vite.config.ts define), or "dev". */
function appVersion(): string {
  try {
    return typeof __APP_VERSION__ === 'string' && __APP_VERSION__ ? __APP_VERSION__ : 'dev';
  } catch {
    return 'dev';
  }
}
/** The day this build was made (vite.config.ts define), or ''. */
function buildDate(): string {
  try {
    return typeof __BUILD_DATE__ === 'string' ? __BUILD_DATE__ : '';
  } catch {
    return '';
  }
}
