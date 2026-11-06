// Hand-written validators for every client -> server message. They check shape, types, finiteness and bounds only
// (game rules are checked by the sim on every client). Valid messages are rebuilt field by field, so unknown extra
// fields are never relayed to other clients.

import { BUILDINGS, MAX_GROUP_UNITS, STRIKE, TECHS, UPGRADE_SELECTION_MAX } from '../src/sim/config';
import { ADMIN_OP_LIST } from '../src/sim/admin';
import { CONTROL, MARK_PILES, cleanChatText } from './chat';
import { DEFAULT_MODIFIERS, validateSetup } from '../src/sim/setup';
import { AIR_MISSIONS, DIVISION_MODES, DOCTRINE_IDS, NAVAL_VARIANTS, WARSHIP_STANCES } from '../src/sim/types';
import type { Action, GameSetup, Modifiers } from '../src/sim/types';
import {
  ADMIN_CODE_MAX_LENGTH,
  ANNOUNCE_SECONDS,
  ANNOUNCE_STYLES,
  BROADCAST_LABEL_MAX,
  BROADCAST_TEXT_MAX,
  BROADCAST_TITLE_MAX,
  FLIP_MODES,
  MUTE_MAX_MINUTES,
  SPECTACLE_KINDS,
  spectacleSecondsRange,
  cleanBroadcastText,
  BUILD_MAX_LENGTH,
  CHAT_MAX_LENGTH,
  CLIENT_ID_PATTERN,
  LOBBY_LIMITS,
  NAME_MAX_LENGTH,
  normalizeLobbyCode,
} from '../src/net/protocol';
import type { AdminClientMessage, AnnounceStyle, BroadcastScope, ClientMessage, LobbySettingsPatch, RGB, SpectacleKind, FlipMode } from '../src/net/protocol';

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = <T>(error: string): Result<T> => ({ ok: false, error });

type Obj = Record<string, unknown>;
function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isInt(v: unknown, lo: number, hi: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
}
function isNum(v: unknown, lo: number, hi: number): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
}

// ------------------------------------------------------------------------------------------------ actions

/** Largest tile index we accept (far above the largest map; the sim checks the real bound). */
const MAX_TILE = 1 << 22;
/** Ids (attacks, units, buildings) are positive integers below this. */
const MAX_ID = 0x7fffffff;
/** Player ids (players[] index). */
const MAX_PLAYER = 4096;
const MAX_AMOUNT = 1e12;

type FieldSpec =
  | { k: 'tile'; optional?: boolean }
  | { k: 'id' }
  | { k: 'player'; optional?: boolean }
  | { k: 'amount' }
  | { k: 'share' } // 0..1
  | { k: 'bool'; optional?: boolean }
  | { k: 'enum'; values: readonly string[]; optional?: boolean }
  | { k: 'troops'; optional?: boolean }
  /** a port / site tile, or -1 = let the sim pick (buildWarship with a target tile) */
  | { k: 'siteOrAuto' }
  /** unit id list for group orders: 1..MAX_GROUP_UNITS distinct ids */
  | { k: 'ids' }
  /** tile list (Action upgradeBuildings): 1..UPGRADE_SELECTION_MAX distinct tiles */
  | { k: 'tiles' }
  /** any finite number within +-MAX_AMOUNT (owner console amounts may be negative) */
  | { k: 'signed'; optional?: boolean }
  /** short identifier (owner console key: resource, tech, building, doctrine ...) */
  | { k: 'word'; optional?: boolean }
  /** salvo size: an integer 0..STRIKE.maxSalvo (0 = every ready launcher) */
  | { k: 'count'; optional?: boolean };

/** One spec per Action type, with exactly that action's fields (tsc fails when the Action union changes). */
type ActionSpecs = {
  [K in Action['type']]: { [F in Exclude<keyof Extract<Action, { type: K }>, 'type'>]-?: FieldSpec };
};

const BUILDING_TYPES = Object.keys(BUILDINGS);
const TECH_IDS = Object.keys(TECHS);
const TILE: FieldSpec = { k: 'tile' };
const ID: FieldSpec = { k: 'id' };
const PLAYER: FieldSpec = { k: 'player' };
const TROOPS: FieldSpec = { k: 'troops' };

const ACTION_SPECS: ActionSpecs = {
  spawn: { tile: TILE },
  attack: { tile: TILE, troops: TROOPS },
  retreat: { attackId: ID },
  build: { building: { k: 'enum', values: BUILDING_TYPES }, tile: TILE },
  demolish: { tile: TILE },
  setArmyMix: { armor: { k: 'share' }, artillery: { k: 'share' } },
  research: { tech: { k: 'enum', values: TECH_IDS } },
  procure: { tech: { k: 'enum', values: TECH_IDS } },
  transport: { from: TILE, to: TILE, troops: TROOPS },
  buildWarship: { port: { k: 'siteOrAuto' }, tile: { k: 'tile', optional: true }, variant: { k: 'enum', values: NAVAL_VARIANTS, optional: true } },
  moveWarship: { unitId: ID, tile: TILE },
  buildAircraft: { airfield: ID, kind: { k: 'enum', values: ['bomber', 'fighter'] } },
  // Salvos (protocol 14): a site of -1 = every own site; count = how many fly (absent 1, 0 = every ready one).
  bomb: { airfield: { k: 'siteOrAuto' }, tile: TILE, count: { k: 'count', optional: true } },
  launchMissile: { silo: { k: 'siteOrAuto' }, kind: { k: 'enum', values: ['rocket', 'atomBomb'] }, tile: TILE, count: { k: 'count', optional: true } },
  paradrop: { airfield: TILE, tile: TILE, troops: { k: 'amount' } },
  barrage: { tile: TILE },
  requestAlliance: { to: PLAYER },
  answerAlliance: { from: PLAYER, accept: { k: 'bool' } },
  breakAlliance: { with: PLAYER },
  gift: { to: PLAYER, gold: { k: 'amount' }, troops: { k: 'amount' } },
  toggleEmbargo: { with: PLAYER },
  requestAllyAttack: { ally: PLAYER, target: PLAYER },
  requestAllyAid: { ally: PLAYER },
  setAuto: { mix: { k: 'bool', optional: true }, research: { k: 'bool', optional: true } },
  startNow: {},
  chooseDoctrine: { doctrine: { k: 'enum', values: DOCTRINE_IDS } },
  // Part B: continue after the end (host only, room.ts), warship groups, tank divisions, the owner console
  // (relayed only from an admin session: server/admin.ts, room.ts).
  continueGame: {},
  moveWarships: { unitIds: { k: 'ids' }, tile: TILE },
  buildTankDivision: { tile: TILE },
  moveTankDivision: { unitIds: { k: 'ids' }, tile: TILE },
  admin: {
    op: { k: 'enum', values: ADMIN_OP_LIST },
    player: { k: 'player', optional: true },
    other: { k: 'player', optional: true },
    tile: { k: 'tile', optional: true },
    amount: { k: 'signed', optional: true },
    key: { k: 'word', optional: true },
    flag: { k: 'bool', optional: true },
    troops: { k: 'troops', optional: true },
  },
  hireMercenaries: { amount: { k: 'amount' } },
  fundAlly: { ally: PLAYER, gold: { k: 'amount' } },
  warBonds: {},
  buildMany: { building: { k: 'enum', values: BUILDING_TYPES }, tile: TILE, count: { k: 'amount' } },
  upgradeArea: { tile: TILE, radius: { k: 'amount' }, building: { k: 'enum', values: BUILDING_TYPES, optional: true }, levels: { k: 'amount' } },
  upgradeBuildings: { tiles: { k: 'tiles' }, levels: { k: 'amount' } },
  cancelQueuedLevels: { tile: TILE },
  // Follow my war (protocol 10): follow flags, a stance's pinned target, auto recon.
  setUnitStance: { unitIds: { k: 'ids' }, stance: { k: 'enum', values: WARSHIP_STANCES }, target: { k: 'tile', optional: true }, follow: { k: 'bool', optional: true } },
  setDivisionMode: { unitIds: { k: 'ids' }, mode: { k: 'enum', values: DIVISION_MODES }, front: { k: 'tile', optional: true }, follow: { k: 'bool', optional: true } },
  setAirMission: {
    airfield: { k: 'siteOrAuto' },
    mission: { k: 'enum', values: AIR_MISSIONS },
    target: { k: 'tile', optional: true },
    refill: { k: 'bool', optional: true },
    follow: { k: 'bool', optional: true },
  },
  reconFlight: { airfield: { k: 'siteOrAuto' }, tile: TILE },
  setAutoRecon: { airfield: { k: 'siteOrAuto' }, on: { k: 'bool' } },
  setAutoFire: { silo: { k: 'siteOrAuto' }, on: { k: 'bool' } },
};

function checkField(spec: FieldSpec, v: unknown): Result<unknown> {
  switch (spec.k) {
    case 'tile':
      if (v === undefined && spec.optional) return ok(undefined);
      return isInt(v, 0, MAX_TILE) ? ok(v) : fail('bad tile');
    case 'id':
      return isInt(v, 0, MAX_ID) ? ok(v) : fail('bad id');
    case 'player':
      if (v === undefined && spec.optional) return ok(undefined);
      return isInt(v, 0, MAX_PLAYER) ? ok(v) : fail('bad player id');
    case 'amount':
      return isNum(v, 0, MAX_AMOUNT) ? ok(v) : fail('bad amount');
    case 'share':
      return isNum(v, 0, 1) ? ok(v) : fail('bad share (0..1)');
    case 'bool':
      if (v === undefined && spec.optional) return ok(undefined);
      return typeof v === 'boolean' ? ok(v) : fail('bad boolean');
    case 'enum':
      if (v === undefined && spec.optional) return ok(undefined);
      return typeof v === 'string' && spec.values.includes(v) ? ok(v) : fail('bad value');
    case 'siteOrAuto':
      return isInt(v, -1, MAX_ID) ? ok(v) : fail('bad site');
    case 'ids': {
      if (!Array.isArray(v) || v.length < 1 || v.length > MAX_GROUP_UNITS) return fail(`bad id list (1..${MAX_GROUP_UNITS})`);
      if (!v.every((x) => isInt(x, 0, MAX_ID)) || new Set(v).size !== v.length) return fail('bad id list');
      return ok(v.slice());
    }
    case 'tiles': {
      if (!Array.isArray(v) || v.length < 1 || v.length > UPGRADE_SELECTION_MAX) return fail(`bad tile list (1..${UPGRADE_SELECTION_MAX})`);
      if (!v.every((x) => isInt(x, 0, MAX_TILE)) || new Set(v).size !== v.length) return fail('bad tile list');
      return ok(v.slice());
    }
    case 'signed':
      if (v === undefined && spec.optional) return ok(undefined);
      return isNum(v, -MAX_AMOUNT, MAX_AMOUNT) ? ok(v) : fail('bad number');
    case 'count':
      if (v === undefined && spec.optional) return ok(undefined);
      return isInt(v, 0, STRIKE.maxSalvo) ? ok(v) : fail(`bad count (0..${STRIKE.maxSalvo})`);
    case 'word':
      if (v === undefined && spec.optional) return ok(undefined);
      return typeof v === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(v) ? ok(v) : fail('bad key');
    case 'troops': {
      if (v === undefined && spec.optional) return ok(undefined);
      if (!isObj(v)) return fail('bad troops');
      const { infantry, armor, artillery } = v;
      if (!isNum(infantry, 0, MAX_AMOUNT) || !isNum(armor, 0, MAX_AMOUNT) || !isNum(artillery, 0, MAX_AMOUNT)) {
        return fail('bad troops');
      }
      return ok({ infantry, armor, artillery });
    }
  }
}

/** Validates an Action and returns a clean copy (only the known fields). */
export function validateAction(v: unknown): Result<Action> {
  if (!isObj(v) || typeof v.type !== 'string') return fail('action: missing type');
  if (!Object.prototype.hasOwnProperty.call(ACTION_SPECS, v.type)) return fail(`action: unknown type`);
  const type = v.type as Action['type'];
  const spec = ACTION_SPECS[type] as Record<string, FieldSpec>;
  const out: Record<string, unknown> = { type };
  for (const name of Object.keys(spec)) {
    const r = checkField(spec[name], v[name]);
    if (!r.ok) return fail(`action ${type}.${name}: ${r.error}`);
    if (r.value !== undefined) out[name] = r.value;
  }
  return ok(out as Action);
}

// ------------------------------------------------------------------------------------------------ fields

/**
 * Trims, removes control and invisible characters (the same set as chat text, server/chat.ts), cuts piles of
 * combining marks and collapses spaces; null when empty or too long afterwards. Names show next to every chat
 * message, so an invisible character must not make a second "Aurora" look like the first (room.ts uniqueName).
 */
export function cleanName(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > NAME_MAX_LENGTH * 4) return null;
  // line breaks and tabs part words; every other invisible character goes ("Au<zero width>rora" is "Aurora")
  const s = v.normalize('NFC').replace(/[\t\n\r\u2028\u2029]/g, ' ').replace(CONTROL, '').replace(MARK_PILES, '$1').replace(/\s+/g, ' ').trim();
  if (s.length === 0 || s.length > NAME_MAX_LENGTH) return null;
  return s;
}

export function checkColor(v: unknown): RGB | null {
  if (!Array.isArray(v) || v.length !== 3) return null;
  if (!v.every((c) => isInt(c, 0, 255))) return null;
  return [v[0], v[1], v[2]];
}

/**
 * Validates a partial LobbySettings: the shared setup fields with setup.validateSetup (every given field valid,
 * unknown fields an error; `modifiers` may be partial) plus maxPlayers. Rebuilt field by field.
 */
export function validateLobbySettings(v: unknown): Result<LobbySettingsPatch> {
  if (v === undefined) return ok({});
  if (!isObj(v)) return fail('settings must be an object');
  const { maxPlayers, ...setup } = v;
  if (maxPlayers !== undefined) {
    const [lo, hi] = LOBBY_LIMITS.maxPlayers;
    if (!isInt(maxPlayers, lo, hi)) return fail(`bad maxPlayers (${lo}..${hi})`);
  }
  const bad = validateSetup(setup, true);
  if (bad) return fail(bad.slice(0, 120));
  const out: LobbySettingsPatch = {};
  const src = setup as Partial<GameSetup>;
  if (src.map) out.map = src.map.kind === 'world' ? { kind: 'world', id: src.map.id } : { kind: 'generated', type: src.map.type, size: src.map.size };
  for (const k of ['aiCount', 'tribeCount', 'teamCount', 'difficulty', 'mode', 'timeLimit', 'victoryLandShare', 'preset'] as const) {
    if (src[k] !== undefined) (out as Record<string, unknown>)[k] = src[k];
  }
  if (src.modifiers) {
    const m: Partial<Modifiers> = {};
    for (const k of Object.keys(DEFAULT_MODIFIERS) as (keyof Modifiers)[]) {
      if (src.modifiers[k] !== undefined) (m as Record<string, unknown>)[k] = src.modifiers[k];
    }
    out.modifiers = m;
  }
  if (maxPlayers !== undefined) out.maxPlayers = maxPlayers as number;
  return ok(out);
}

// ------------------------------------------------------------------------------------------------ messages

/** Parses and validates one text frame. */
export function parseClientMessage(text: string): Result<ClientMessage> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail('not JSON');
  }
  return validateClientMessage(raw);
}

export function validateClientMessage(m: unknown): Result<ClientMessage> {
  if (!isObj(m) || typeof m.type !== 'string') return fail('missing type');
  switch (m.type) {
    case 'hello': {
      if (!isInt(m.protocol, 0, 1e6)) return fail('hello: bad protocol');
      const name = cleanName(m.name);
      if (!name) return fail(`hello: name must be 1..${NAME_MAX_LENGTH} characters`);
      const color = checkColor(m.color);
      if (!color) return fail('hello: color must be [r, g, b] with 0..255 integers');
      if (typeof m.clientId !== 'string' || !CLIENT_ID_PATTERN.test(m.clientId)) return fail('hello: bad clientId');
      let build = '';
      if (m.build !== undefined) {
        if (typeof m.build !== 'string' || m.build.length > BUILD_MAX_LENGTH) return fail('hello: bad build');
        build = m.build;
      }
      const out: ClientMessage = { type: 'hello', protocol: m.protocol, name, color, clientId: m.clientId, build };
      if (m.resume !== undefined && m.resume !== null) {
        const r = m.resume;
        const code = isObj(r) && typeof r.code === 'string' && r.code.length <= 32 ? normalizeLobbyCode(r.code) : null;
        if (!code || !isObj(r) || !isInt(r.haveTurns, 0, MAX_ID)) return fail('hello: bad resume');
        out.resume = { code, haveTurns: r.haveTurns };
      }
      return ok(out);
    }
    case 'createLobby': {
      const s = validateLobbySettings(m.settings);
      if (!s.ok) return fail(`createLobby: ${s.error}`);
      return ok({ type: 'createLobby', settings: s.value });
    }
    case 'joinLobby': {
      const code = typeof m.code === 'string' && m.code.length <= 32 ? normalizeLobbyCode(m.code) : null;
      if (!code) return fail('joinLobby: bad code');
      if (m.spectate !== undefined && typeof m.spectate !== 'boolean') return fail('joinLobby: bad spectate');
      if (m.haveTurns !== undefined && !isInt(m.haveTurns, 0, MAX_ID)) return fail('joinLobby: bad haveTurns');
      const out: ClientMessage = { type: 'joinLobby', code, spectate: m.spectate === true };
      if (m.haveTurns !== undefined) out.haveTurns = m.haveTurns;
      return ok(out);
    }
    case 'leaveLobby':
      return ok({ type: 'leaveLobby' });
    case 'updateLobbySettings': {
      if (m.settings === undefined) return fail('updateLobbySettings: missing settings');
      const s = validateLobbySettings(m.settings);
      if (!s.ok) return fail(`updateLobbySettings: ${s.error}`);
      return ok({ type: 'updateLobbySettings', settings: s.value });
    }
    case 'setTeam':
      if (!isInt(m.team, 0, LOBBY_LIMITS.teamCount[1])) return fail('setTeam: bad team');
      return ok({ type: 'setTeam', team: m.team });
    case 'kick':
      if (!isInt(m.memberId, 0, MAX_ID)) return fail('kick: bad memberId');
      return ok({ type: 'kick', memberId: m.memberId });
    case 'startGame':
      return ok({ type: 'startGame' });
    case 'intent': {
      const a = validateAction(m.action);
      if (!a.ok) return fail(`intent: ${a.error}`);
      return ok({ type: 'intent', action: a.value });
    }
    case 'hash':
      if (!isInt(m.turn, 0, MAX_ID)) return fail('hash: bad turn');
      if (!isInt(m.hash, 0, 0xffffffff)) return fail('hash: bad hash (unsigned 32-bit)');
      return ok({ type: 'hash', turn: m.turn, hash: m.hash });
    case 'gameOver':
      if (!isInt(m.turn, 0, MAX_ID)) return fail('gameOver: bad turn');
      if (!isInt(m.winner, 0, MAX_PLAYER)) return fail('gameOver: bad winner');
      return ok({ type: 'gameOver', turn: m.turn, winner: m.winner });
    case 'setPause':
      if (typeof m.paused !== 'boolean') return fail('setPause: bad paused (boolean)');
      return ok({ type: 'setPause', paused: m.paused });
    case 'adminAuth':
      if (typeof m.code !== 'string' || m.code.length === 0 || m.code.length > ADMIN_CODE_MAX_LENGTH) return fail('adminAuth: bad code');
      return ok({ type: 'adminAuth', code: m.code });
    case 'adminRooms':
    case 'adminAnnounce':
    case 'adminNotice':
    case 'adminSpectacle':
    case 'adminMute':
    case 'adminKick':
      return validateAdminMessage(m);
    case 'chat': {
      if (m.channel !== 'all' && m.channel !== 'team') return fail('chat: channel must be all or team');
      const text = cleanChatText(m.text);
      if (text === null) return fail(`chat: text must be 1..${CHAT_MAX_LENGTH} characters`);
      const out: ClientMessage = { type: 'chat', channel: m.channel, text };
      if (m.ping !== undefined) {
        if (!isInt(m.ping, 0, MAX_TILE)) return fail('chat: bad ping');
        out.ping = m.ping;
      }
      return ok(out);
    }
    case 'ping':
      if (m.t !== undefined && !isNum(m.t, -1e15, 1e15)) return fail('ping: bad t');
      return ok(m.t === undefined ? { type: 'ping' } : { type: 'ping', t: m.t });
    default:
      return fail('unknown message type');
  }
}

// ------------------------------------------------------------------------------------------------ owner powers

/** Optional room code of an owner power: absent = the owner's own room. */
function optCode(v: unknown): Result<string | undefined> {
  if (v === undefined) return ok(undefined);
  const code = typeof v === 'string' && v.length <= 32 ? normalizeLobbyCode(v) : null;
  return code ? ok(code) : fail('bad code');
}

/**
 * The owner powers (server/admin.ts checks the session first). Texts go through cleanBroadcastText (control and
 * bidi characters out, one line, length capped); every other field is an exact enum or integer range.
 */
export function validateAdminMessage(m: Obj): Result<AdminClientMessage> {
  const t = m.type as AdminClientMessage['type'];
  const code = optCode(m.code);
  if (!code.ok) return fail(`${t}: bad code`);
  const withCode = (out: AdminClientMessage): Result<AdminClientMessage> => {
    if (code.value) (out as { code?: string }).code = code.value;
    return ok(out);
  };
  const style = (v: unknown): AnnounceStyle | null => (typeof v === 'string' && (ANNOUNCE_STYLES as readonly string[]).includes(v) ? (v as AnnounceStyle) : null);
  const scope = (v: unknown): BroadcastScope | null => (v === 'room' || v === 'all' ? v : null);
  switch (t) {
    case 'adminRooms':
      return ok({ type: 'adminRooms' });
    case 'adminAnnounce': {
      const sc = scope(m.scope);
      const st = style(m.style);
      const text = cleanBroadcastText(m.text, BROADCAST_TEXT_MAX);
      const title = m.title === undefined ? '' : cleanBroadcastText(m.title, BROADCAST_TITLE_MAX);
      if (!sc) return fail('adminAnnounce: bad scope');
      if (!st) return fail('adminAnnounce: bad style');
      if (!text) return fail(`adminAnnounce: text must be 1..${BROADCAST_TEXT_MAX} characters`);
      if (title === null) return fail(`adminAnnounce: title must be at most ${BROADCAST_TITLE_MAX} characters`);
      if (!isInt(m.seconds, ANNOUNCE_SECONDS[0], ANNOUNCE_SECONDS[1])) return fail('adminAnnounce: bad seconds');
      return withCode({ type: 'adminAnnounce', scope: sc, title, text, style: st, seconds: m.seconds });
    }
    case 'adminNotice': {
      const st = style(m.style);
      const text = cleanBroadcastText(m.text, BROADCAST_TEXT_MAX);
      if (!isInt(m.memberId, 0, MAX_ID)) return fail('adminNotice: bad memberId');
      if (!st) return fail('adminNotice: bad style');
      if (!text) return fail(`adminNotice: text must be 1..${BROADCAST_TEXT_MAX} characters`);
      return withCode({ type: 'adminNotice', memberId: m.memberId, text, style: st });
    }
    case 'adminSpectacle': {
      const sc = scope(m.scope);
      if (!sc) return fail('adminSpectacle: bad scope');
      if (typeof m.kind !== 'string' || !(SPECTACLE_KINDS as readonly string[]).includes(m.kind)) return fail('adminSpectacle: bad kind');
      const kind = m.kind as SpectacleKind;
      const out: Extract<AdminClientMessage, { type: 'adminSpectacle' }> = { type: 'adminSpectacle', scope: sc, kind };
      if (m.tile !== undefined) {
        if (!isInt(m.tile, 0, MAX_TILE)) return fail('adminSpectacle: bad tile');
        if (kind !== 'ping' && kind !== 'confetti' && kind !== 'fireworks') return fail('adminSpectacle: this effect has no tile');
        out.tile = m.tile;
      }
      if (kind === 'ping' && out.tile === undefined) return fail('adminSpectacle: ping needs a tile');
      if (out.tile !== undefined && sc !== 'room') return fail('adminSpectacle: an effect on a tile goes to one game');
      if (m.label !== undefined) {
        const label = cleanBroadcastText(m.label, BROADCAST_LABEL_MAX);
        if (label === null) return fail(`adminSpectacle: label must be at most ${BROADCAST_LABEL_MAX} characters`);
        if (kind !== 'ping' && kind !== 'countdown') return fail('adminSpectacle: this effect has no label');
        if (label) out.label = label;
      }
      // every effect ends by itself: a countdown within COUNTDOWN_SECONDS, a prank within PRANK_SECONDS
      const range = spectacleSecondsRange(kind);
      if (m.seconds !== undefined || kind === 'countdown') {
        if (!range) return fail('adminSpectacle: this effect has no seconds');
        if (!isInt(m.seconds, range[0], range[1])) return fail(`adminSpectacle: seconds must be ${range[0]}..${range[1]}`);
        out.seconds = m.seconds;
      }
      if (m.mode !== undefined) {
        if (kind !== 'flip') return fail('adminSpectacle: only a flip has a mode');
        if (typeof m.mode !== 'string' || !(FLIP_MODES as readonly string[]).includes(m.mode)) return fail('adminSpectacle: bad mode');
        out.mode = m.mode as FlipMode;
      }
      if (m.memberId !== undefined) {
        if (!isInt(m.memberId, 0, MAX_ID)) return fail('adminSpectacle: bad memberId');
        if (sc !== 'room') return fail('adminSpectacle: one player is in one game');
        out.memberId = m.memberId;
      }
      return withCode(out);
    }
    case 'adminMute':
      if (!isInt(m.memberId, 0, MAX_ID)) return fail('adminMute: bad memberId');
      if (!isInt(m.minutes, 0, MUTE_MAX_MINUTES)) return fail(`adminMute: minutes must be 0..${MUTE_MAX_MINUTES}`);
      return withCode({ type: 'adminMute', memberId: m.memberId, minutes: m.minutes });
    case 'adminKick':
      if (!isInt(m.memberId, 0, MAX_ID)) return fail('adminKick: bad memberId');
      return withCode({ type: 'adminKick', memberId: m.memberId });
    default:
      return fail('unknown message type');
  }
}
