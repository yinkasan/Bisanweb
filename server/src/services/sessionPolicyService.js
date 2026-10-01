import { query } from '../db/pool.js';

/**
 * Session policy delivered to authenticated clients on /auth/login and
 * /auth/me, so every signed-in device enforces the same rule without needing
 * settings:view permission (the mobile app's idle sign-out watchdog reads it
 * from there). A Super Admin changes the value on the System Settings page and
 * it reaches all devices on their next sign-in or app resume.
 */

const DEFAULT_IDLE_MINUTES = 2;
// Mirrors the mobile clamp (src/auth/idlePolicy.ts) and the settings PUT guard,
// so a hand-edited row can never produce an instant or never-ending session.
const MIN_IDLE_MINUTES = 1;
const MAX_IDLE_MINUTES = 240;

export async function loadSessionPolicy() {
  const res = await query("SELECT value FROM system_settings WHERE key = 'session_idle_minutes'");
  const n = Number(res.rows[0]?.value);
  const minutes = Number.isInteger(n) && n >= MIN_IDLE_MINUTES && n <= MAX_IDLE_MINUTES
    ? n
    : DEFAULT_IDLE_MINUTES;
  return { sessionIdleMinutes: minutes };
}
