import { query } from '../db/pool.js';
import { forbidden, notFound } from '../middleware/errors.js';

/**
 * Loads a user's full access context: profile, role, page permissions and
 * depot assignments. This is the single source of truth for authorization.
 */
export async function loadUserContext(userId) {
  const userRes = await query(
    `SELECT u.id, u.username, u.full_name, u.email, u.phone, u.is_active,
            u.all_depots, u.last_login_at,
            r.key AS role_key, r.name AS role_name, r.level AS role_level
       FROM users u
       JOIN user_roles ur ON ur.user_id = u.id AND ur.is_active
       JOIN roles r ON r.id = ur.role_id
      WHERE u.id = $1`,
    [userId]
  );
  if (userRes.rowCount === 0) throw notFound('User not found');
  const user = userRes.rows[0];
  if (!user.is_active) throw forbidden('This user account is deactivated');

  const isSuperAdmin = user.role_key === 'super_admin';

  const permRes = await query(
    `SELECT page_key, can_view, can_input, can_edit, can_view_history, can_export, can_approve
       FROM user_permissions WHERE user_id = $1`,
    [userId]
  );

  const permissions = {};
  for (const row of permRes.rows) {
    permissions[row.page_key] = {
      view: row.can_view,
      input: row.can_input,
      edit: row.can_edit,
      view_history: row.can_view_history,
      export: row.can_export,
      approve: row.can_approve,
    };
  }

  // Role-level grants (the role "category" defaults) merge in permissively:
  // a page/action is allowed when either the user's own grants or any of
  // their active roles grants it.
  const rolePermRes = await query(
    `SELECT rp.page_key, rp.can_view, rp.can_input, rp.can_edit,
            rp.can_view_history, rp.can_export, rp.can_approve
       FROM role_permissions rp
       JOIN user_roles ur ON ur.role_id = rp.role_id AND ur.is_active
      WHERE ur.user_id = $1`,
    [userId]
  );
  for (const row of rolePermRes.rows) {
    const cur = permissions[row.page_key] ?? {
      view: false, input: false, edit: false, view_history: false, export: false, approve: false,
    };
    permissions[row.page_key] = {
      view: cur.view || row.can_view,
      input: cur.input || row.can_input,
      edit: cur.edit || row.can_edit,
      view_history: cur.view_history || row.can_view_history,
      export: cur.export || row.can_export,
      approve: cur.approve || row.can_approve,
    };
  }

  // Component overrides for the role categories. Only explicit restrictions
  // are returned; keys that are absent default to visible + input allowed in
  // the UI (still gated by the page-level permissions above).
  const compRes = await query(
    `SELECT rpc.page_key, rpc.component_key, rpc.is_visible, rpc.can_input
       FROM role_page_components rpc
       JOIN user_roles ur ON ur.role_id = rpc.role_id AND ur.is_active
      WHERE ur.user_id = $1`,
    [userId]
  );
  const components = {};
  for (const row of compRes.rows) {
    const page = (components[row.page_key] ??= {});
    const cur = page[row.component_key] ?? { visible: false, input: false };
    page[row.component_key] = {
      visible: cur.visible || row.is_visible,
      input: cur.input || row.can_input,
    };
  }

  // Super Admin is not limited by grants (SRS: full control).
  if (isSuperAdmin) {
    const pages = await query('SELECT page_key FROM permissions');
    for (const { page_key: key } of pages.rows) {
      permissions[key] = {
        view: true, input: true, edit: true, view_history: true, export: true, approve: true,
      };
    }
  }

  const depotsRes = await query(
    `SELECT d.id, d.code, d.name
       FROM depots d
      WHERE d.is_active
        AND ($2::boolean = true
             OR EXISTS (SELECT 1 FROM user_depot_assignments a
                         WHERE a.depot_id = d.id AND a.user_id = $1))
      ORDER BY d.code`,
    [userId, user.all_depots]
  );

  return {
    id: user.id,
    username: user.username,
    fullName: user.full_name,
    email: user.email,
    phone: user.phone,
    roleKey: user.role_key,
    roleName: user.role_name,
    roleLevel: user.role_level,
    isSuperAdmin,
    allDepots: user.all_depots,
    lastLoginAt: user.last_login_at,
    permissions,
    components,
    depots: depotsRes.rows.map((d) => ({ id: d.id, code: d.code, name: d.name })),
  };
}

export function hasPermission(ctx, pageKey, action = 'view') {
  if (!ctx) return false;
  if (ctx.isSuperAdmin) return true;
  const page = ctx.permissions?.[pageKey];
  return Boolean(page && page[action]);
}

/** Throws unless the user may access the given depot (SRS 4.2). */
export function assertDepotAccess(ctx, depotId) {
  const id = Number(depotId);
  if (!Number.isInteger(id) || id <= 0) throw forbidden('A valid depot is required');
  if (ctx.isSuperAdmin || ctx.allDepots) return id;
  if (!ctx.depots.some((d) => d.id === id)) {
    throw forbidden('You do not have access to this depot');
  }
  return id;
}

/** Depots the user may query. Super Admin / all_depots => every active depot. */
export function accessibleDepotIds(ctx) {
  return ctx.depots.map((d) => d.id);
}
