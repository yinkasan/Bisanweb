/**
 * Session policy delivered to authenticated clients on /auth/login and
 * /auth/me, mirroring server/src/services/sessionPolicyService.js so every
 * signed-in device enforces the same rule without needing settings:view
 * permission. A Super Admin changes the value on System Settings and it
 * reaches all devices on their next sign-in or resume.
 */
import { queryOne } from './db.ts';

const DEFAULT_IDLE_MINUTES = 2;
// Mirrors the mobile clamp (src/auth/idlePolicy.ts) and the settings PUT guard,
// so a hand-edited row can never produce an instant or never-ending session.
const MIN_IDLE_MINUTES = 1;
const MAX_IDLE_MINUTES = 240;

export interface SessionPolicy {
  sessionIdleMinutes: number;
}

export async function loadSessionPolicy(): Promise<SessionPolicy> {
  const row = await queryOne<{ value: string }>(
    `SELECT value FROM system_settings WHERE key = 'session_idle_minutes'`,
  );
  const n = Number(row?.value);
  const minutes = Number.isInteger(n) && n >= MIN_IDLE_MINUTES && n <= MAX_IDLE_MINUTES
    ? n
    : DEFAULT_IDLE_MINUTES;
  return { sessionIdleMinutes: minutes };
}
