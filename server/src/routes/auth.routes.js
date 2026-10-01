import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { query } from '../db/pool.js';
import { asyncHandler, badRequest, unauthorized } from '../middleware/errors.js';
import { signToken, setAuthCookie, clearAuthCookie, requireAuth } from '../middleware/auth.js';
import { logAudit } from '../middleware/audit.js';
import { loadUserContext } from '../services/accessService.js';
import { loadSessionPolicy } from '../services/sessionPolicyService.js';

const router = Router();

// POST /api/auth/login
router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { username, password } = req.body ?? {};
    if (!username || !password) throw badRequest('Username and password are required');

    const result = await query(
      `SELECT id, username, full_name, password_hash, is_active FROM users WHERE username = $1`,
      [String(username).trim()]
    );
    const user = result.rows[0];

    if (!user || !(await bcrypt.compare(String(password), user.password_hash))) {
      await logAudit({
        actor: user ? { id: user.id, fullName: user.full_name, roleName: null } : null,
        req,
        action: 'LOGIN_FAILED',
        entityType: 'user',
        entityId: user?.id ?? null,
        description: `Failed sign-in attempt for "${username}"`,
      });
      throw unauthorized('Invalid username or password');
    }
    if (!user.is_active) {
      await logAudit({
        actor: { id: user.id, fullName: user.full_name, roleName: null },
        req,
        action: 'LOGIN_BLOCKED',
        entityType: 'user',
        entityId: user.id,
        description: 'Sign-in blocked: account deactivated',
      });
      throw unauthorized('This account has been deactivated. Contact the Super Admin.');
    }

    const context = await loadUserContext(user.id);
    const token = signToken(user.id);
    setAuthCookie(res, token);
    await query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
    await logAudit({
      actor: context,
      req,
      action: 'LOGIN',
      entityType: 'user',
      entityId: user.id,
      description: `${context.fullName} signed in`,
    });

    // The token is returned for mobile clients (they store it and send it as
    // `Authorization: Bearer <token>`). The web app keeps using the httpOnly
    // cookie and can ignore this field. `policy` carries the session rules
    // (idle sign-out window) every client must enforce.
    res.json({ user: context, token, policy: await loadSessionPolicy() });
  })
);

// POST /api/auth/logout
router.post(
  '/logout',
  asyncHandler(async (req, res) => {
    // Best-effort audit: the token may already be invalid/expired.
    if (req.cookies?.depot_token) {
      try {
        const { default: jwt } = await import('jsonwebtoken');
        const { config } = await import('../config.js');
        const payload = jwt.verify(req.cookies.depot_token, config.jwtSecret);
        const context = await loadUserContext(payload.uid);
        await logAudit({
          actor: context,
          req,
          action: 'LOGOUT',
          entityType: 'user',
          entityId: context.id,
          description: `${context.fullName} signed out`,
        });
      } catch { /* token invalid/expired — nothing to log */ }
    }
    clearAuthCookie(res);
    res.json({ ok: true });
  })
);

// GET /api/auth/me
router.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    // `policy` rides along with every session refresh, so a Super Admin's change
    // to the idle window reaches each device on its next foreground — no polling
    // and no settings:view permission required.
    res.json({ user: req.user, policy: await loadSessionPolicy() });
  })
);

// POST /api/auth/change-password
router.post(
  '/change-password',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.body ?? {};
    if (!currentPassword || !newPassword) {
      throw badRequest('Current password and new password are required');
    }
    if (String(newPassword).length < 8) {
      throw badRequest('New password must be at least 8 characters');
    }
    const result = await query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    const ok = await bcrypt.compare(String(currentPassword), result.rows[0].password_hash);
    if (!ok) throw badRequest('Current password is incorrect');

    const hash = await bcrypt.hash(String(newPassword), 10);
    await query('UPDATE users SET password_hash = $1, updated_at = now(), updated_by = $2 WHERE id = $3', [
      hash, req.user.id, req.user.id,
    ]);
    await logAudit({
      actor: req.user,
      req,
      action: 'PASSWORD_CHANGE',
      entityType: 'user',
      entityId: req.user.id,
      description: 'Changed own password',
    });
    res.json({ ok: true });
  })
);

export default router;
