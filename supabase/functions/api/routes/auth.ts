/**
 * /auth — port of server/src/routes/auth.routes.js. Login issues the same
 * HS256 app JWT the mobile app uses; the web client sends it back as
 * `Authorization: Bearer` on every call (no cookies across origins).
 */
import bcrypt from 'npm:bcryptjs@2.4.3';
import { json } from '../../_shared/http.ts';
import { HttpError } from '../../_shared/http.ts';
import { query, queryOne } from '../../_shared/db.ts';
import { loadUserContext, signToken } from '../../_shared/auth.ts';
import { logAudit } from '../../_shared/audit.ts';
import { loadSessionPolicy } from '../../_shared/sessionPolicy.ts';
import { bodyOf, type Ctx, type ModuleHandler } from '../_ctx.ts';

const badRequest = (m: string) => new HttpError(400, m);
const unauthorized = (m: string) => new HttpError(401, m);

export const handleAuth: ModuleHandler = async (c: Ctx): Promise<Response | null> => {
  const { method, path } = c;

  // POST /auth/login (public — index.ts leaves c.user null for it)
  if (method === 'POST' && path === '/auth/login') {
    const body = await bodyOf(c.req);
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!username || !password) throw badRequest('Username and password are required');

    const row = await queryOne<{ id: number; full_name: string; password_hash: string; is_active: boolean }>(
      'SELECT id, full_name, password_hash, is_active FROM users WHERE username = $1',
      [username],
    );

    const passwordOk = row ? await bcrypt.compare(password, row.password_hash) : false;
    if (!row || !passwordOk) {
      await logAudit({
        actor: row ? { id: row.id, fullName: row.full_name } : null,
        req: c.req,
        action: 'LOGIN_FAILED',
        entityType: 'user',
        entityId: row?.id ?? null,
        description: `Failed sign-in attempt for "${username}"`,
      });
      throw unauthorized('Invalid username or password');
    }
    if (!row.is_active) {
      await logAudit({
        actor: { id: row.id, fullName: row.full_name },
        req: c.req,
        action: 'LOGIN_BLOCKED',
        entityType: 'user',
        entityId: row.id,
        description: 'Sign-in blocked: account deactivated',
      });
      throw unauthorized('This account has been deactivated. Contact the Super Admin.');
    }

    const context = await loadUserContext(row.id);
    const token = await signToken(row.id);
    await query('UPDATE users SET last_login_at = now() WHERE id = $1', [row.id]);
    await logAudit({
      actor: context,
      req: c.req,
      action: 'LOGIN',
      entityType: 'user',
      entityId: row.id,
      description: `${context.fullName} signed in`,
    });

    // `policy` carries the session rules (idle sign-out window) every client
    // must enforce; `token` is the bearer credential for web + mobile.
    return json({ user: context, token, policy: await loadSessionPolicy() });
  }

  // Everything below requires a live session (index.ts authenticated it).
  if (method === 'POST' && path === '/auth/logout') {
    // Best-effort audit: c.user is null when the token was already invalid.
    const actor = c.user;
    if (actor) {
      await logAudit({
        actor,
        req: c.req,
        action: 'LOGOUT',
        entityType: 'user',
        entityId: actor.id,
        description: `${actor.fullName} signed out`,
      });
    }
    return json({ ok: true });
  }

  if (method === 'GET' && path === '/auth/me') {
    const user = c.user;
    // `policy` rides along with every session refresh, so a Super Admin's
    // change to the idle window reaches each device on its next foreground.
    return json({ user, policy: await loadSessionPolicy() });
  }

  if (method === 'POST' && path === '/auth/change-password') {
    const user = c.user;
    const body = await bodyOf(c.req);
    const { currentPassword, newPassword } = body ?? {};
    if (!currentPassword || !newPassword) {
      throw badRequest('Current password and new password are required');
    }
    if (String(newPassword).length < 8) {
      throw badRequest('New password must be at least 8 characters');
    }
    const row = await queryOne<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id = $1',
      [user.id],
    );
    if (!row || !(await bcrypt.compare(String(currentPassword), row.password_hash))) {
      throw badRequest('Current password is incorrect');
    }

    const hash = await bcrypt.hash(String(newPassword), 10);
    await query(
      'UPDATE users SET password_hash = $1, updated_at = now(), updated_by = $2 WHERE id = $3',
      [hash, user.id, user.id],
    );
    await logAudit({
      actor: user,
      req: c.req,
      action: 'PASSWORD_CHANGE',
      entityType: 'user',
      entityId: user.id,
      description: 'Changed own password',
    });
    return json({ ok: true });
  }

  return null;
};
