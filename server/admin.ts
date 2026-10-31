// Owner console online: the server is the authority. A client sends `adminAuth {code}`; the code is compared with
// the ADMIN_CODE environment variable (constant time). No ADMIN_CODE = no console online. After ADMIN_MAX_FAILS wrong
// codes from one address within ADMIN_FAIL_WINDOW_MS, further tries from it are ignored silently. A session that
// passed (and its clientId when it reconnects) may send `admin` intents; room.ts drops them from anyone else.
// Single player asks the same server over HTTP (POST /api/admin-check, server.ts): same code, same rate limit.
import { createHash, timingSafeEqual } from 'node:crypto';

export const ADMIN_MAX_FAILS = 5;
export const ADMIN_FAIL_WINDOW_MS = 3600_000;

export type AdminAttempt = 'ok' | 'wrong' | 'ignored';

const digest = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();

export class AdminGate {
  private readonly code: Buffer | null;
  /** wrong attempts per address (times, oldest first) */
  private readonly fails = new Map<string, number[]>();
  /** clientIds that proved the code (kept for the process's life: a reconnect stays admin) */
  private readonly admins = new Set<string>();

  constructor(
    code: string | undefined,
    private readonly now: () => number,
  ) {
    this.code = code ? digest(code) : null;
  }

  /** Whether the console is available online at all (ADMIN_CODE set). */
  get enabled(): boolean {
    return this.code !== null;
  }

  /** Checks a code from `ip` / `clientId`: 'ok' (now admin), 'wrong', or 'ignored' (rate-limited: no answer). */
  attempt(ip: string, clientId: string, code: string): AdminAttempt {
    const r = this.compare(ip, code);
    if (r === 'ok') this.admins.add(clientId);
    return r;
  }

  /** Plain yes/no for the HTTP check (single player): same compare and same rate limit, but nobody becomes admin. */
  check(ip: string, code: string): boolean {
    return this.compare(ip, code) === 'ok';
  }

  private compare(ip: string, code: string): AdminAttempt {
    const now = this.now();
    const list = (this.fails.get(ip) ?? []).filter((t) => now - t < ADMIN_FAIL_WINDOW_MS);
    if (list.length >= ADMIN_MAX_FAILS) {
      this.fails.set(ip, list);
      return 'ignored';
    }
    // Hash both sides so the comparison has a fixed length and takes the same time whatever was sent.
    const good = this.code !== null && timingSafeEqual(digest(code), this.code);
    if (good) return 'ok';
    list.push(now);
    this.fails.set(ip, list);
    return 'wrong';
  }

  isAdmin(clientId: string): boolean {
    return this.code !== null && clientId !== '' && this.admins.has(clientId);
  }

  /** Forgets wrong attempts older than the window (called by the hub's sweep). */
  sweep(): void {
    const now = this.now();
    for (const [ip, list] of this.fails) {
      const keep = list.filter((t) => now - t < ADMIN_FAIL_WINDOW_MS);
      if (keep.length) this.fails.set(ip, keep);
      else this.fails.delete(ip);
    }
  }
}
