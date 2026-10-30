// Hand-written validators for every client -> server message. They check shape, types, finiteness and bounds only
// (game rules are checked by the sim on every client). Valid messages are rebuilt field by field, so unknown extra
// fields are never relayed to other clients.

import { BUILDINGS, TECHS } from '../src/sim/config';
import { DEFAULT_MODIFIERS, validateSetup } from '../src/sim/setup';
import { DOCTRINE_IDS } from '../src/sim/types';
import type { Action, GameSetup, Modifiers } from '../src/sim/types';
import {
  BUILD_MAX_LENGTH,
  CLIENT_ID_PATTERN,
  LOBBY_LIMITS,
  NAME_MAX_LENGTH,
  normalizeLobbyCode,
} from '../src/net/protocol';
import type { ClientMessage, LobbySettingsPatch, RGB } from '../src/net/protocol';

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
  | { k: 'tile' }
  | { k: 'id' }
  | { k: 'player' }
  | { k: 'amount' }
  | { k: 'share' } // 0..1
  | { k: 'bool'; optional?: boolean }
  | { k: 'enum'; values: readonly string[] }
  | { k: 'troops' };

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
  transport: { from: TILE, to: TILE, troops: TROOPS },
  buildWarship: { port: ID },
  moveWarship: { unitId: ID, tile: TILE },
  buildAircraft: { airfield: ID, kind: { k: 'enum', values: ['bomber', 'fighter'] } },
  bomb: { airfield: ID, tile: TILE },
  launchMissile: { silo: ID, kind: { k: 'enum', values: ['rocket', 'atomBomb'] }, tile: TILE },
  paradrop: { airfield: TILE, tile: TILE, troops: { k: 'amount' } },
  barrage: { tile: TILE },
  requestAlliance: { to: PLAYER },
  answerAlliance: { from: PLAYER, accept: { k: 'bool' } },
  breakAlliance: { with: PLAYER },
  gift: { to: PLAYER, gold: { k: 'amount' }, troops: { k: 'amount' } },
  toggleEmbargo: { with: PLAYER },
  setAuto: { mix: { k: 'bool', optional: true }, research: { k: 'bool', optional: true } },
  startNow: {},
  chooseDoctrine: { doctrine: { k: 'enum', values: DOCTRINE_IDS } },
};

function checkField(spec: FieldSpec, v: unknown): Result<unknown> {
  switch (spec.k) {
    case 'tile':
      return isInt(v, 0, MAX_TILE) ? ok(v) : fail('bad tile');
    case 'id':
      return isInt(v, 0, MAX_ID) ? ok(v) : fail('bad id');
    case 'player':
      return isInt(v, 0, MAX_PLAYER) ? ok(v) : fail('bad player id');
    case 'amount':
      return isNum(v, 0, MAX_AMOUNT) ? ok(v) : fail('bad amount');
    case 'share':
      return isNum(v, 0, 1) ? ok(v) : fail('bad share (0..1)');
    case 'bool':
      if (v === undefined && spec.optional) return ok(undefined);
      return typeof v === 'boolean' ? ok(v) : fail('bad boolean');
    case 'enum':
      return typeof v === 'string' && spec.values.includes(v) ? ok(v) : fail('bad value');
    case 'troops': {
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

/** Trims, removes control characters and collapses spaces; null when empty or too long afterwards. */
export function cleanName(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > NAME_MAX_LENGTH * 4) return null;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, '').replace(/\s+/g, ' ').trim();
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
    case 'ping':
      if (m.t !== undefined && !isNum(m.t, -1e15, 1e15)) return fail('ping: bad t');
      return ok(m.t === undefined ? { type: 'ping' } : { type: 'ping', t: m.t });
    default:
      return fail('unknown message type');
  }
}
