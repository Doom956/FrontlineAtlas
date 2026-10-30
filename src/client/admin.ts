// Owner console access (client side). Nothing here is visible in the UI; adminConsole.ts uses it.
//   - single player: the code typed at the hidden terminal line is hashed (SHA-256, Web Crypto) and compared with
//     ADMIN_CODE_HASH; the plain code is never stored in the repo
//   - online: the relay server is the authority (server/admin.ts): the code goes out as `adminAuth {code}` and only
//     the server's `adminAuth {ok}` answer unlocks; a rate-limited try gets no answer (treated as wrong after a wait)
//   - an unlock lasts for the browser session (sessionStorage; private windows or blocked storage just forget it)

/** SHA-256 (hex) of the owner code. Regenerate: node -e "console.log(require('crypto').createHash('sha256').update('<code>').digest('hex'))" */
export const ADMIN_CODE_HASH = '0e5f31e7a5f4549f60018a676d1e22663d1a91219a3256aaedf77ac5e4d6d697';
/** How long an online login waits for the server's answer before it counts as wrong (ms). */
export const ADMIN_AUTH_TIMEOUT_MS = 4000;

const STORE_KEY = 'fa.console';

/** Lower-case hex SHA-256 of a text (Web Crypto; rejects where crypto.subtle is missing, e.g. plain http pages). */
export async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const buf = await globalThis.crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Equal-length strings compared without stopping at the first difference. */
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** Single player: whether `code` is the owner code (false when hashing is not available). */
export async function checkAdminCode(code: string, hash = ADMIN_CODE_HASH): Promise<boolean> {
  if (!code) return false;
  try {
    return sameText(await sha256Hex(code), hash);
  } catch {
    return false;
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
