/**
 * /users — port of server/src/routes/users.routes.js. User administration:
 * CRUD, role changes with history, page-permission grants, depot assignments
 * and password resets. All Super Admin safeguards are preserved.
 */
import bcrypt from 'npm:bcryptjs@2.4.3';
import { json } from '../../_shared/http.ts';
import { HttpError } from '../../_shared/http.ts';
import { query, queryOne, withTransaction } from '../../_shared/db.ts';
import { assertPermission, type UserContext } from '../../_shared/auth.ts';
import { diffFields, logAdjustments, logAudit } from '../../_shared/audit.ts';
import { optionalString, requireString } from '../../_shared/stamps.ts';
import { badRequest, bodyOf, conflict, notFound, under, type Ctx, type ModuleHandler } from '../_ctx.ts';

const forbidden = (m: string) => new HttpError(403, m);

const PAGE = 'users';
const ROLE_PAGE = 'roles_permissions';

const USER_FIELDS = ['username', 'full_name', 'email', 'phone', 'is_active', 'all_depots'];

async function loadUserById(id: number): Promise<Record<string, any>> {
  const user = await queryOne<Record<string, any>>(
    `SELECT u.id, u.username, u.full_name, u.email, u.phone, u.is_active, u.all_depots,
            u.last_login_at, u.created_at,
            r.key AS role_key, r.name AS role_name
       FROM users u
       JOIN user_roles ur ON ur.user_id = u.id AND ur.is_active
       JOIN roles r ON r.id = ur.role_id
      WHERE u.id = $1`,
    [id],
  );
  if (!user) throw notFound('User not found');
  return user;
}

/** Only the Super Admin may touch users who are themselves Super Admins. */
function guardSuperAdminTarget(actor: UserContext, target: Record<string, any>): void {
  if (target.role_key === 'super_admin' && !actor.isSuperAdmin) {
    throw forbidden('Only the Super Admin can modify a Super Admin account');
  }
}

export const handleUsers: ModuleHandler = async (c: Ctx): Promise<Response | null> => {
  const rest = under(c.path, '/users');
  if (!rest) return null;
  const { method, user, req } = c;

  // GET /users
  if (method === 'GET' && rest === '/') {
    assertPermission(user, PAGE, 'view');
    const rows = await query(
      `SELECT u.id, u.username, u.full_name, u.email, u.phone, u.is_active, u.all_depots,
              u.last_login_at, u.created_at,
              r.key AS role_key, r.name AS role_name, r.level AS role_level,
              COALESCE((SELECT COUNT(*) FROM user_depot_assignments a WHERE a.user_id = u.id), 0)::int AS depot_count
         FROM users u
         JOIN user_roles ur ON ur.user_id = u.id AND ur.is_active
         JOIN roles r ON r.id = ur.role_id
        ORDER BY r.level, u.full_name`,
    );
    return json({ users: rows });
  }

  // POST /users — create user
  if (method === 'POST' && rest === '/') {
    assertPermission(user, PAGE, 'input');

    const body = await bodyOf(req);
    const username = requireString(body.username, 'username', 60);
    const fullName = requireString(body.fullName, 'fullName', 120);
    const email = optionalString(body.email, 160);
    const phone = optionalString(body.phone, 40);
    const password = requireString(body.password, 'password', 200);
    const roleKey = requireString(body.roleKey, 'roleKey', 40);
    const allDepots = body.allDepots === true;
    const depotIds: number[] = Array.isArray(body.depotIds) ? body.depotIds.map(Number) : [];

    if (password.length < 8) throw badRequest('Password must be at least 8 characters');
    if (roleKey === 'super_admin' && !user.isSuperAdmin) {
      throw forbidden('Only the Super Admin can assign the Super Admin role');
    }

    const created = await withTransaction(async (tx) => {
      const role = await tx.queryOne<{ id: number; name: string; key: string }>(
        'SELECT id, name, key FROM roles WHERE key = $1', [roleKey],
      );
      if (!role) throw badRequest('Unknown role');
      if (!allDepots && depotIds.length === 0) {
        throw badRequest('Assign the user to at least one depot, or grant all depots');
      }
      for (const depotId of depotIds) {
        const d = await tx.queryOne('SELECT id FROM depots WHERE id = $1', [depotId]);
        if (!d) throw badRequest(`Unknown depot id ${depotId}`);
      }

      const exists = await tx.queryOne('SELECT 1 AS present FROM users WHERE username = $1', [username]);
      if (exists) throw conflict('That username is already taken');

      const hash = await bcrypt.hash(password, 10);
      const u = await tx.queryOne<{ id: number }>(
        `INSERT INTO users (username, full_name, email, phone, password_hash, all_depots, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING id`,
        [username, fullName, email, phone, hash, allDepots, user.id],
      );
      const userId = Number(u!.id);

      await tx.query(
        'INSERT INTO user_roles (user_id, role_id, assigned_by) VALUES ($1, $2, $3)',
        [userId, role.id, user.id],
      );
      for (const depotId of depotIds) {
        await tx.query(
          'INSERT INTO user_depot_assignments (user_id, depot_id, assigned_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [userId, depotId, user.id],
        );
      }
      await logAudit({
        tx, actor: user, req,
        action: 'CREATE', entityType: 'user', entityId: userId,
        description: `Created user "${username}" with role ${role.name}`,
        newValue: { username, fullName, roleKey, allDepots, depotIds },
      });
      return userId;
    });

    return json({ user: await loadUserById(created) }, 201);
  }

  // GET /users/:id — detail with permissions, depots and role history
  const detailMatch = /^\/(\d+)(\/.*)?$/.exec(rest);
  if (!detailMatch) return null;
  const id = Number(detailMatch[1]);
  const sub = detailMatch[2] ?? '/';

  if (method === 'GET' && sub === '/') {
    assertPermission(user, PAGE, 'view');
    const target = await loadUserById(id);
    const permissions = await query(
      `SELECT page_key, can_view, can_input, can_edit, can_view_history, can_export, can_approve
         FROM user_permissions WHERE user_id = $1 ORDER BY page_key`,
      [id],
    );
    const depots = await query(
      `SELECT d.id, d.code, d.name, a.assigned_at
         FROM user_depot_assignments a JOIN depots d ON d.id = a.depot_id
        WHERE a.user_id = $1 ORDER BY d.code`,
      [id],
    );
    let roleHistory: Record<string, unknown>[] = [];
    try {
      roleHistory = await query(
        `SELECT l.id, l.changed_at AS created_at, l.reason,
                old.name AS old_role, new.name AS new_role,
                cb.full_name AS changed_by_name
           FROM role_change_logs l
           LEFT JOIN roles old ON old.id = l.old_role_id
           LEFT JOIN roles new ON new.id = l.new_role_id
           LEFT JOIN users cb ON cb.id = l.changed_by
          WHERE l.user_id = $1 ORDER BY l.created_at DESC`,
        [id],
      );
    } catch { /* table absent — same fallback as the Express route */ }
    return json({ user: target, permissions, depots, roleHistory });
  }

  // PUT /users/:id — profile fields, activation, all_depots flag
  if (method === 'PUT' && sub === '/') {
    assertPermission(user, PAGE, 'edit');
    const target = await loadUserById(id);
    guardSuperAdminTarget(user, target);
    const body = await bodyOf(req);
    if (id === user.id && body.is_active === false) {
      throw badRequest('You cannot deactivate your own account');
    }

    const updates: Record<string, unknown> = {};
    if (body.fullName !== undefined) updates.full_name = requireString(body.fullName, 'fullName', 120);
    if (body.email !== undefined) updates.email = optionalString(body.email, 160);
    if (body.phone !== undefined) updates.phone = optionalString(body.phone, 40);
    if (body.is_active !== undefined) updates.is_active = body.is_active === true;
    if (body.allDepots !== undefined) updates.all_depots = body.allDepots === true;

    if (Object.keys(updates).length === 0) throw badRequest('Nothing to update');

    // Never allow removing the last active Super Admin.
    if (updates.is_active === false && target.role_key === 'super_admin') {
      const count = await queryOne<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM users u
          JOIN user_roles ur ON ur.user_id = u.id AND ur.is_active
          JOIN roles r ON r.id = ur.role_id
         WHERE r.key = 'super_admin' AND u.is_active AND u.id <> $1`,
        [id],
      );
      if ((count?.n ?? 0) === 0) throw badRequest('At least one active Super Admin must remain');
    }

    await withTransaction(async (tx) => {
      const cols = Object.keys(updates);
      const setSql = cols.map((col, i) => `${col} = $${i + 2}`).join(', ');
      await tx.query(
        `UPDATE users SET ${setSql}, updated_at = now(), updated_by = $${cols.length + 2} WHERE id = $1`,
        [id, ...cols.map((col) => updates[col]), user.id],
      );
      const changes = diffFields(target, { ...target, ...updates }, ['full_name', 'email', 'phone', 'is_active', 'all_depots']);
      await logAdjustments({
        tx, actor: user, entityType: 'user', entityId: id,
        changes, reason: 'User record update',
      });
      await logAudit({
        tx, actor: user, req,
        action: 'UPDATE', entityType: 'user', entityId: id,
        description: `Updated user "${target.username}"`,
        previousValue: Object.fromEntries(USER_FIELDS.map((f) => [f, target[f] ?? null])),
        newValue: updates,
      });
    });

    return json({ user: await loadUserById(id) });
  }

  // PUT /users/:id/role — role change with history
  if (method === 'PUT' && sub === '/role') {
    assertPermission(user, PAGE, 'edit');
    const target = await loadUserById(id);
    guardSuperAdminTarget(user, target);

    const body = await bodyOf(req);
    const roleKey = requireString(body.roleKey, 'roleKey', 40);
    const reason = optionalString(body.reason, 500);
    if (roleKey === 'super_admin' && !user.isSuperAdmin) {
      throw forbidden('Only the Super Admin can assign the Super Admin role');
    }
    if (id === user.id && target.role_key === 'super_admin' && roleKey !== 'super_admin') {
      throw badRequest('You cannot remove your own Super Admin role');
    }

    await withTransaction(async (tx) => {
      const role = await tx.queryOne<{ id: number; name: string }>(
        'SELECT id, name FROM roles WHERE key = $1', [roleKey],
      );
      if (!role) throw badRequest('Unknown role');
      if (target.role_key === roleKey) throw badRequest(`User already has the ${role.name} role`);

      const oldRole = await tx.queryOne<{ id: number; name: string }>(
        'SELECT id, name FROM roles WHERE key = $1', [target.role_key],
      );
      if (!oldRole) throw badRequest('Unknown role');

      if (target.role_key === 'super_admin' && roleKey !== 'super_admin') {
        const count = await tx.queryOne<{ n: number }>(
          `SELECT COUNT(*)::int AS n FROM users u
            JOIN user_roles ur ON ur.user_id = u.id AND ur.is_active
            JOIN roles r ON r.id = ur.role_id
           WHERE r.key = 'super_admin' AND u.is_active AND u.id <> $1`,
          [id],
        );
        if ((count?.n ?? 0) === 0) throw badRequest('At least one active Super Admin must remain');
      }

      await tx.query('UPDATE user_roles SET is_active = false WHERE user_id = $1 AND is_active', [id]);
      await tx.query(
        'INSERT INTO user_roles (user_id, role_id, assigned_by) VALUES ($1, $2, $3)',
        [id, role.id, user.id],
      );
      await tx.query(
        `INSERT INTO role_change_logs (user_id, old_role_id, new_role_id, changed_by, reason)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, oldRole.id, role.id, user.id, reason],
      );
      await logAudit({
        tx, actor: user, req,
        action: 'ROLE_CHANGE', entityType: 'user', entityId: id,
        description: `Changed role of "${target.username}" from ${oldRole.name} to ${role.name}`,
        previousValue: { role: oldRole.name },
        newValue: { role: role.name, reason },
      });
    });

    return json({ user: await loadUserById(id) });
  }

  // PUT /users/:id/permissions — page-level grants (Super Admin functions)
  if (method === 'PUT' && sub === '/permissions') {
    assertPermission(user, ROLE_PAGE, 'edit');
    const target = await loadUserById(id);
    guardSuperAdminTarget(user, target);

    const body = await bodyOf(req);
    const grants = body.grants;
    if (!Array.isArray(grants)) throw badRequest('grants must be an array');
    const catalog = await query<{ page_key: string }>('SELECT page_key FROM permissions');
    const validKeys = new Set(catalog.map((r) => r.page_key));

    await withTransaction(async (tx) => {
      const before = await tx.query(
        `SELECT page_key, can_view, can_input, can_edit, can_view_history, can_export, can_approve
           FROM user_permissions WHERE user_id = $1`,
        [id],
      );
      await tx.query('DELETE FROM user_permissions WHERE user_id = $1', [id]);
      for (const g of grants) {
        if (!validKeys.has(g.pageKey)) throw badRequest(`Unknown page "${g.pageKey}"`);
        const any = g.view || g.input || g.edit || g.viewHistory || g.export || g.approve;
        if (!any) continue;
        await tx.query(
          `INSERT INTO user_permissions
             (user_id, page_key, can_view, can_input, can_edit, can_view_history, can_export, can_approve, granted_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            id, g.pageKey,
            g.view === true, g.input === true, g.edit === true,
            g.viewHistory === true, g.export === true, g.approve === true,
            user.id,
          ],
        );
      }
      await logAudit({
        tx, actor: user, req,
        action: 'PERMISSION_CHANGE', entityType: 'user', entityId: id,
        description: `Updated page permissions for "${target.username}"`,
        previousValue: { grants: before },
        newValue: { grants },
      });
    });

    return json({ ok: true });
  }

  // PUT /users/:id/depots — depot-level assignments (SRS 4.2)
  if (method === 'PUT' && sub === '/depots') {
    assertPermission(user, PAGE, 'edit');
    const target = await loadUserById(id);
    guardSuperAdminTarget(user, target);

    const body = await bodyOf(req);
    const allDepots = body.allDepots === true;
    const depotIds: number[] = Array.isArray(body.depotIds) ? body.depotIds.map(Number) : [];

    await withTransaction(async (tx) => {
      const before = await tx.query<{ depot_id: number }>(
        `SELECT depot_id FROM user_depot_assignments WHERE user_id = $1`, [id],
      );
      await tx.query(
        'UPDATE users SET all_depots = $2, updated_at = now(), updated_by = $3 WHERE id = $1',
        [id, allDepots, user.id],
      );
      await tx.query('DELETE FROM user_depot_assignments WHERE user_id = $1', [id]);
      for (const depotId of depotIds) {
        const d = await tx.queryOne('SELECT id FROM depots WHERE id = $1', [depotId]);
        if (!d) throw badRequest(`Unknown depot id ${depotId}`);
        await tx.query(
          'INSERT INTO user_depot_assignments (user_id, depot_id, assigned_by) VALUES ($1, $2, $3)',
          [id, depotId, user.id],
        );
      }
      await logAudit({
        tx, actor: user, req,
        action: 'DEPOT_ASSIGNMENT', entityType: 'user', entityId: id,
        description: `Updated depot access for "${target.username}"`,
        previousValue: { depotIds: before.map((r) => r.depot_id), allDepots: target.all_depots },
        newValue: { depotIds, allDepots },
      });
    });

    return json({ ok: true });
  }

  // POST /users/:id/reset-password
  if (method === 'POST' && sub === '/reset-password') {
    assertPermission(user, PAGE, 'edit');
    const target = await loadUserById(id);
    guardSuperAdminTarget(user, target);
    const body = await bodyOf(req);
    const newPassword = requireString(body.newPassword, 'newPassword', 200);
    if (newPassword.length < 8) throw badRequest('Password must be at least 8 characters');

    const hash = await bcrypt.hash(newPassword, 10);
    await query(
      'UPDATE users SET password_hash = $1, updated_at = now(), updated_by = $2 WHERE id = $3',
      [hash, user.id, id],
    );
    await logAudit({
      actor: user, req,
      action: 'PASSWORD_RESET', entityType: 'user', entityId: id,
      description: `Reset password for "${target.username}"`,
    });
    return json({ ok: true });
  }

  return null;
};
