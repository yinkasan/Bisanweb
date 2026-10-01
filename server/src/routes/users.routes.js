import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { query, withTransaction } from '../db/pool.js';
import { asyncHandler, badRequest, notFound, forbidden, conflict } from '../middleware/errors.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { logAudit, logAdjustments, diffFields } from '../middleware/audit.js';
import { optionalString, requireString } from '../utils/stamps.js';

const router = Router();
router.use(requireAuth);

const PAGE = 'users';
const ROLE_PAGE = 'roles_permissions';

const USER_FIELDS = ['username', 'full_name', 'email', 'phone', 'is_active', 'all_depots'];

async function loadUserById(id) {
  const res = await query(
    `SELECT u.id, u.username, u.full_name, u.email, u.phone, u.is_active, u.all_depots,
            u.last_login_at, u.created_at,
            r.key AS role_key, r.name AS role_name
       FROM users u
       JOIN user_roles ur ON ur.user_id = u.id AND ur.is_active
       JOIN roles r ON r.id = ur.role_id
      WHERE u.id = $1`,
    [id]
  );
  if (res.rowCount === 0) throw notFound('User not found');
  return res.rows[0];
}

/** Only the Super Admin may touch users who are themselves Super Admins. */
function guardSuperAdminTarget(req, target) {
  if (target.role_key === 'super_admin' && !req.user.isSuperAdmin) {
    throw forbidden('Only the Super Admin can modify a Super Admin account');
  }
}

// GET /api/users
router.get(
  '/',
  requirePermission(PAGE, 'view'),
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT u.id, u.username, u.full_name, u.email, u.phone, u.is_active, u.all_depots,
              u.last_login_at, u.created_at,
              r.key AS role_key, r.name AS role_name, r.level AS role_level,
              COALESCE((SELECT COUNT(*) FROM user_depot_assignments a WHERE a.user_id = u.id), 0)::int AS depot_count
         FROM users u
         JOIN user_roles ur ON ur.user_id = u.id AND ur.is_active
         JOIN roles r ON r.id = ur.role_id
        ORDER BY r.level, u.full_name`
    );
    res.json({ users: rows });
  })
);

// GET /api/users/:id — detail with permissions, depots and role history
router.get(
  '/:id',
  requirePermission(PAGE, 'view'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const user = await loadUserById(id);
    const perms = await query(
      `SELECT page_key, can_view, can_input, can_edit, can_view_history, can_export, can_approve
         FROM user_permissions WHERE user_id = $1 ORDER BY page_key`,
      [id]
    );
    const depots = await query(
      `SELECT d.id, d.code, d.name, a.assigned_at
         FROM user_depot_assignments a JOIN depots d ON d.id = a.depot_id
        WHERE a.user_id = $1 ORDER BY d.code`,
      [id]
    );
    const history = await query(
      `SELECT l.id, l.changed_at AS created_at, l.reason,
              old.name AS old_role, new.name AS new_role,
              cb.full_name AS changed_by_name
         FROM role_change_logs l
         LEFT JOIN roles old ON old.id = l.old_role_id
         LEFT JOIN roles new ON new.id = l.new_role_id
         LEFT JOIN users cb ON cb.id = l.changed_by
        WHERE l.user_id = $1 ORDER BY l.created_at DESC`,
      [id]
    ).catch(() => ({ rows: [] }));
    res.json({ user, permissions: perms.rows, depots: depots.rows, roleHistory: history.rows });
  })
);

// POST /api/users
router.post(
  '/',
  requirePermission(PAGE, 'input'),
  asyncHandler(async (req, res) => {
    const body = req.body ?? {};
    const username = requireString(body.username, 'username', { max: 60 });
    const fullName = requireString(body.fullName, 'fullName', { max: 120 });
    const email = optionalString(body.email, { max: 160 });
    const phone = optionalString(body.phone, { max: 40 });
    const password = requireString(body.password, 'password', { max: 200 });
    const roleKey = requireString(body.roleKey, 'roleKey', { max: 40 });
    const allDepots = body.allDepots === true;
    const depotIds = Array.isArray(body.depotIds) ? body.depotIds.map(Number) : [];

    if (password.length < 8) throw badRequest('Password must be at least 8 characters');
    if (roleKey === 'super_admin' && !req.user.isSuperAdmin) {
      throw forbidden('Only the Super Admin can assign the Super Admin role');
    }

    const created = await withTransaction(async (client) => {
      const role = await client.query('SELECT id, name, key FROM roles WHERE key = $1', [roleKey]);
      if (role.rowCount === 0) throw badRequest('Unknown role');
      if (!allDepots && depotIds.length === 0) {
        throw badRequest('Assign the user to at least one depot, or grant all depots');
      }
      for (const depotId of depotIds) {
        const d = await client.query('SELECT id FROM depots WHERE id = $1', [depotId]);
        if (d.rowCount === 0) throw badRequest(`Unknown depot id ${depotId}`);
      }

      const exists = await client.query('SELECT 1 FROM users WHERE username = $1', [username]);
      if (exists.rowCount > 0) throw conflict('That username is already taken');

      const hash = await bcrypt.hash(password, 10);
      const u = await client.query(
        `INSERT INTO users (username, full_name, email, phone, password_hash, all_depots, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING id`,
        [username, fullName, email, phone, hash, allDepots, req.user.id]
      );
      const userId = u.rows[0].id;

      await client.query(
        'INSERT INTO user_roles (user_id, role_id, assigned_by) VALUES ($1, $2, $3)',
        [userId, role.rows[0].id, req.user.id]
      );
      for (const depotId of depotIds) {
        await client.query(
          'INSERT INTO user_depot_assignments (user_id, depot_id, assigned_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [userId, depotId, req.user.id]
        );
      }
      await logAudit({
        executor: client,
        actor: req.user,
        req,
        action: 'CREATE',
        entityType: 'user',
        entityId: userId,
        description: `Created user "${username}" with role ${role.rows[0].name}`,
        newValue: { username, fullName, roleKey, allDepots, depotIds },
      });
      return userId;
    });

    const user = await loadUserById(created);
    res.status(201).json({ user });
  })
);

// PUT /api/users/:id — profile fields, activation, all_depots flag
router.put(
  '/:id',
  requirePermission(PAGE, 'edit'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const target = await loadUserById(id);
    guardSuperAdminTarget(req, target);
    if (id === req.user.id && req.body.is_active === false) {
      throw badRequest('You cannot deactivate your own account');
    }

    const body = req.body ?? {};
    const updates = {};
    if (body.fullName !== undefined) updates.full_name = requireString(body.fullName, 'fullName', { max: 120 });
    if (body.email !== undefined) updates.email = optionalString(body.email, { max: 160 });
    if (body.phone !== undefined) updates.phone = optionalString(body.phone, { max: 40 });
    if (body.is_active !== undefined) updates.is_active = body.is_active === true;
    if (body.allDepots !== undefined) updates.all_depots = body.allDepots === true;

    if (Object.keys(updates).length === 0) throw badRequest('Nothing to update');

    // Never allow removing the last active Super Admin.
    if (updates.is_active === false && target.role_key === 'super_admin') {
      const count = await query(
        `SELECT COUNT(*)::int AS n FROM users u
          JOIN user_roles ur ON ur.user_id = u.id AND ur.is_active
          JOIN roles r ON r.id = ur.role_id
         WHERE r.key = 'super_admin' AND u.is_active AND u.id <> $1`,
        [id]
      );
      if (count.rows[0].n === 0) throw badRequest('At least one active Super Admin must remain');
    }

    await withTransaction(async (client) => {
      const cols = Object.keys(updates);
      const setSql = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
      await client.query(
        `UPDATE users SET ${setSql}, updated_at = now(), updated_by = $${cols.length + 2} WHERE id = $1`,
        [id, ...cols.map((c) => updates[c]), req.user.id]
      );
      const changes = diffFields(target, { ...target, ...updates }, ['full_name', 'email', 'phone', 'is_active', 'all_depots']);
      await logAdjustments({
        executor: client, actor: req.user, entityType: 'user', entityId: id,
        changes, reason: 'User record update',
      });
      await logAudit({
        executor: client, actor: req.user, req,
        action: 'UPDATE', entityType: 'user', entityId: id,
        description: `Updated user "${target.username}"`,
        previousValue: Object.fromEntries(USER_FIELDS.map((f) => [f, target[f] ?? null])),
        newValue: updates,
      });
    });

    res.json({ user: await loadUserById(id) });
  })
);

// PUT /api/users/:id/role — role change with history
router.put(
  '/:id/role',
  requirePermission(PAGE, 'edit'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const target = await loadUserById(id);
    guardSuperAdminTarget(req, target);

    const roleKey = requireString(req.body?.roleKey, 'roleKey', { max: 40 });
    const reason = optionalString(req.body?.reason, { max: 500 });
    if (roleKey === 'super_admin' && !req.user.isSuperAdmin) {
      throw forbidden('Only the Super Admin can assign the Super Admin role');
    }
    if (id === req.user.id && target.role_key === 'super_admin' && roleKey !== 'super_admin') {
      throw badRequest('You cannot remove your own Super Admin role');
    }

    await withTransaction(async (client) => {
      const role = await client.query('SELECT id, name FROM roles WHERE key = $1', [roleKey]);
      if (role.rowCount === 0) throw badRequest('Unknown role');
      if (target.role_key === roleKey) throw badRequest(`User already has the ${role.rows[0].name} role`);

      const oldRole = await client.query('SELECT id, name FROM roles WHERE key = $1', [target.role_key]);

      if (target.role_key === 'super_admin' && roleKey !== 'super_admin') {
        const count = await client.query(
          `SELECT COUNT(*)::int AS n FROM users u
            JOIN user_roles ur ON ur.user_id = u.id AND ur.is_active
            JOIN roles r ON r.id = ur.role_id
           WHERE r.key = 'super_admin' AND u.is_active AND u.id <> $1`,
          [id]
        );
        if (count.rows[0].n === 0) throw badRequest('At least one active Super Admin must remain');
      }

      await client.query('UPDATE user_roles SET is_active = false WHERE user_id = $1 AND is_active', [id]);
      await client.query(
        'INSERT INTO user_roles (user_id, role_id, assigned_by) VALUES ($1, $2, $3)',
        [id, role.rows[0].id, req.user.id]
      );
      await client.query(
        `INSERT INTO role_change_logs (user_id, old_role_id, new_role_id, changed_by, reason)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, oldRole.rows[0].id, role.rows[0].id, req.user.id, reason]
      );
      await logAudit({
        executor: client, actor: req.user, req,
        action: 'ROLE_CHANGE', entityType: 'user', entityId: id,
        description: `Changed role of "${target.username}" from ${oldRole.rows[0].name} to ${role.rows[0].name}`,
        previousValue: { role: oldRole.rows[0].name },
        newValue: { role: role.rows[0].name, reason },
      });
    });

    res.json({ user: await loadUserById(id) });
  })
);

// PUT /api/users/:id/permissions — page-level grants (Super Admin functions)
router.put(
  '/:id/permissions',
  requirePermission(ROLE_PAGE, 'edit'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const target = await loadUserById(id);
    guardSuperAdminTarget(req, target);

    const grants = req.body?.grants;
    if (!Array.isArray(grants)) throw badRequest('grants must be an array');
    const catalog = await query('SELECT page_key FROM permissions');
    const validKeys = new Set(catalog.rows.map((r) => r.page_key));

    await withTransaction(async (client) => {
      const before = await client.query(
        `SELECT page_key, can_view, can_input, can_edit, can_view_history, can_export, can_approve
           FROM user_permissions WHERE user_id = $1`,
        [id]
      );
      await client.query('DELETE FROM user_permissions WHERE user_id = $1', [id]);
      for (const g of grants) {
        if (!validKeys.has(g.pageKey)) throw badRequest(`Unknown page "${g.pageKey}"`);
        const any = g.view || g.input || g.edit || g.viewHistory || g.export || g.approve;
        if (!any) continue;
        await client.query(
          `INSERT INTO user_permissions
             (user_id, page_key, can_view, can_input, can_edit, can_view_history, can_export, can_approve, granted_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            id, g.pageKey,
            g.view === true, g.input === true, g.edit === true,
            g.viewHistory === true, g.export === true, g.approve === true,
            req.user.id,
          ]
        );
      }
      await logAudit({
        executor: client, actor: req.user, req,
        action: 'PERMISSION_CHANGE', entityType: 'user', entityId: id,
        description: `Updated page permissions for "${target.username}"`,
        previousValue: { grants: before.rows },
        newValue: { grants },
      });
    });

    res.json({ ok: true });
  })
);

// PUT /api/users/:id/depots — depot-level assignments (SRS 4.2)
router.put(
  '/:id/depots',
  requirePermission(PAGE, 'edit'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const target = await loadUserById(id);
    guardSuperAdminTarget(req, target);

    const allDepots = req.body?.allDepots === true;
    const depotIds = Array.isArray(req.body?.depotIds) ? req.body.depotIds.map(Number) : [];

    await withTransaction(async (client) => {
      const before = await client.query(
        `SELECT depot_id FROM user_depot_assignments WHERE user_id = $1`, [id]
      );
      await client.query('UPDATE users SET all_depots = $2, updated_at = now(), updated_by = $3 WHERE id = $1',
        [id, allDepots, req.user.id]);
      await client.query('DELETE FROM user_depot_assignments WHERE user_id = $1', [id]);
      for (const depotId of depotIds) {
        const d = await client.query('SELECT id FROM depots WHERE id = $1', [depotId]);
        if (d.rowCount === 0) throw badRequest(`Unknown depot id ${depotId}`);
        await client.query(
          'INSERT INTO user_depot_assignments (user_id, depot_id, assigned_by) VALUES ($1, $2, $3)',
          [id, depotId, req.user.id]
        );
      }
      await logAudit({
        executor: client, actor: req.user, req,
        action: 'DEPOT_ASSIGNMENT', entityType: 'user', entityId: id,
        description: `Updated depot access for "${target.username}"`,
        previousValue: { depotIds: before.rows.map((r) => r.depot_id), allDepots: target.all_depots },
        newValue: { depotIds, allDepots },
      });
    });

    res.json({ ok: true });
  })
);

// POST /api/users/:id/reset-password
router.post(
  '/:id/reset-password',
  requirePermission(PAGE, 'edit'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const target = await loadUserById(id);
    guardSuperAdminTarget(req, target);
    const newPassword = requireString(req.body?.newPassword, 'newPassword', { max: 200 });
    if (newPassword.length < 8) throw badRequest('Password must be at least 8 characters');

    const hash = await bcrypt.hash(newPassword, 10);
    await query('UPDATE users SET password_hash = $1, updated_at = now(), updated_by = $2 WHERE id = $3',
      [hash, req.user.id, id]);
    await logAudit({
      actor: req.user, req,
      action: 'PASSWORD_RESET', entityType: 'user', entityId: id,
      description: `Reset password for "${target.username}"`,
    });
    res.json({ ok: true });
  })
);

export default router;
