// Owner console access (client side). Nothing here is visible in the UI; adminConsole.ts uses it.
//   - one code everywhere: the ADMIN_CODE of the relay server (server/admin.ts); no code or hash is in the repository
//   - single player: the code typed at the hidden terminal line is sent to the server's POST /api/admin-check
//     (same server address as the multiplayer client: ?server=, VITE_SERVER_URL, same origin); only {ok:true}
//     unlocks. The free server may need up to a minute to wake, so the check waits for it.
//   - online: the code goes out as `adminAuth {code}` and only the server's `adminAuth {ok}` answer unlocks; a
//     rate-limited try gets no answer (treated as wrong after a wait)
//   - an unlock lasts for the browser session (sessionStorage; private windows or blocked storage just forget it)
import { defaultServerUrl } from '../net/client';

/** How long an online login waits for the server's answer before it counts as wrong (ms). */
export const ADMIN_AUTH_TIMEOUT_MS = 4000;
/** How long the single-player check waits for the server (ms): a sleeping free server takes up to ~60 s to wake. */
export const ADMIN_CHECK_TIMEOUT_MS = 75_000;
/** Path of the HTTP check on the multiplayer server. */
export const ADMIN_CHECK_PATH = '/api/admin-check';

const STORE_KEY = 'fa.console';

/** The HTTP address of the check for a server's WebSocket URL (ws -> http, wss -> https), or null. */
export function adminCheckUrl(wsUrl: string | null): string | null {
  if (!wsUrl) return null;
  try {
    const u = new URL(wsUrl);
    if (u.protocol === 'wss:') u.protocol = 'https:';
    else if (u.protocol === 'ws:') u.protocol = 'http:';
    else return null;
    u.pathname = ADMIN_CHECK_PATH;
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Single player: asks the multiplayer server whether `code` is the owner code. True only on `{ok: true}`; a wrong
 * code, a network failure, a timeout or any other answer is false (the line just clears).
 */
export async function checkAdminCode(code: string, url: string | null = adminCheckUrl(defaultServerUrl()), timeoutMs = ADMIN_CHECK_TIMEOUT_MS): Promise<boolean> {
  if (!code || !url || typeof fetch !== 'function') return false;
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => ctl?.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
      cache: 'no-store',
      credentials: 'omit',
      signal: ctl?.signal,
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: unknown };
    return body.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export type AdminScope = 'local' | 'online';

function storage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** Whether the console was unlocked in this browser session (single player and online are kept apart). */
export function isUnlocked(scope: AdminScope): boolean {
  try {
    const v = storage()?.getItem(STORE_KEY) ?? '';
    return v.split(',').includes(scope);
  } catch {
    return false;
  }
}

/** Remembers the unlock for the browser session (or forgets it). */
export function setUnlocked(scope: AdminScope, on: boolean): void {
  try {
    const st = storage();
    if (!st) return;
    const cur = new Set((st.getItem(STORE_KEY) ?? '').split(',').filter(Boolean));
    if (on) cur.add(scope);
    else cur.delete(scope);
    if (cur.size) st.setItem(STORE_KEY, [...cur].join(','));
    else st.removeItem(STORE_KEY);
  } catch {
    /* storage blocked: the unlock lasts for this page only */
  }
}

/** The bits of the network client an online login needs (NetClient fits). */
export interface AdminNet {
  send(msg: { type: 'adminAuth'; code: string }): boolean;
  on(fn: (msg: { type: string; ok?: boolean }) => void): () => void;
}

/**
 * Online: sends the code to the server and waits for its answer. Resolves true only on `adminAuth {ok: true}`;
 * false on a wrong code, no connection, or no answer within the timeout (the server stays silent when rate-limited).
 */
export function requestAdminAuth(net: AdminNet, code: string, timeoutMs = ADMIN_AUTH_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    if (!code) {
      resolve(false);
      return;
    }
    let done = false;
    let off: () => void = () => {};
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      off();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    off = net.on((msg) => {
      if (msg.type === 'adminAuth') finish(msg.ok === true);
    });
    if (!net.send({ type: 'adminAuth', code })) finish(false);
  });
}
