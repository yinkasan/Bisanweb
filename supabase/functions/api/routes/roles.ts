/**
 * /roles — port of server/src/routes/roles.routes.js.
 * Role dropdowns, the page catalogue and the role-access editor.
 */
import { json } from '../../_shared/http.ts';
import { query, queryOne, withTransaction } from '../../_shared/db.ts';
import { assertPermission } from '../../_shared/auth.ts';
import { logAudit } from '../../_shared/audit.ts';
import { COMPONENT_CATALOG } from '../../_shared/permissionCatalog.ts';
import { notFound, under, type Ctx, type ModuleHandler } from '../_ctx.ts';

const PAGE = 'roles_permissions';

export const handleRoles: ModuleHandler = async (c: Ctx): Promise<Response | null> => {
  const { method, req, user } = c;

  const rest = under(c.path, '/roles');
  if (!rest) return null;

  // GET /roles/permissions — the page catalogue with actions per page
  if (method === 'GET' && rest === '/permissions') {
    assertPermission(user, PAGE, 'view');
    const rows = await query(
      'SELECT page_key, page_name, section, sort_order FROM permissions ORDER BY sort_order',
    );
    return json({ permissions: rows });
  }

  // GET /roles — the four role levels (for dropdowns)
  if (method === 'GET' && rest === '/') {
    const rows = await query(
      `SELECT id, key, name, level, description,
              (SELECT COUNT(*) FROM user_roles ur JOIN users u ON u.id = ur.user_id
                WHERE ur.role_id = roles.id AND ur.is_active)::int AS user_count
         FROM roles ORDER BY level`,
    );
    return json({ roles: rows });
  }

  // GET /roles/access — everything the role-access editor needs
  if (method === 'GET' && rest === '/access') {
    assertPermission(user, PAGE, 'view');
    const [roles, pages, rolePermissions, components] = await Promise.all([
      query(
        `SELECT r.id, r.key, r.name, r.level, r.description,
                (SELECT COUNT(*) FROM user_roles ur JOIN users u ON u.id = ur.user_id
                  WHERE ur.role_id = r.id AND ur.is_active)::int AS user_count
           FROM roles r ORDER BY r.level`,
      ),
      query('SELECT page_key, page_name, section, sort_order FROM permissions ORDER BY sort_order'),
      query(
        `SELECT role_id, page_key, can_view, can_input, can_edit,
                can_view_history, can_export, can_approve
           FROM role_permissions`,
      ),
      query('SELECT role_id, page_key, component_key, is_visible, can_input FROM role_page_components'),
    ]);
    return json({
      roles,
      pages,
      rolePermissions,
      components,
      componentCatalog: COMPONENT_CATALOG,
    });
  }

  // PUT /roles/:roleId/access — save page activation + component access
  const accessMatch = /^\/(\d+)\/access$/.exec(rest);
  if (method === 'PUT' && accessMatch) {
    assertPermission(user, PAGE, 'edit');
    const roleId = Number(accessMatch[1]);
    const role = await queryOne<{ id: number; name: string }>(
      'SELECT id, name FROM roles WHERE id = $1',
      [roleId],
    );
    if (!role) throw notFound('Role not found');

    const body = await req.json().catch(() => ({ pages: [], components: [] }));
    const pages: Record<string, any>[] = Array.isArray(body.pages) ? body.pages : [];
    const components: Record<string, any>[] = Array.isArray(body.components) ? body.components : [];
    const validPages = new Set(
      (await query<{ page_key: string }>('SELECT page_key FROM permissions')).map((r) => r.page_key),
    );

    await withTransaction(async (tx) => {
      await tx.query('DELETE FROM role_permissions WHERE role_id = $1', [roleId]);
      for (const p of pages) {
        if (!validPages.has(p.pageKey)) continue;
        const flags = [p.view, p.input, p.edit, p.viewHistory, p.export, p.approve].map(Boolean);
        if (!flags.some(Boolean)) continue; // a fully deactivated page = no row
        await tx.query(
          `INSERT INTO role_permissions (role_id, page_key, can_view, can_input, can_edit,
                                         can_view_history, can_export, can_approve)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [roleId, p.pageKey, ...flags],
        );
      }
      await tx.query('DELETE FROM role_page_components WHERE role_id = $1', [roleId]);
      for (const row of components) {
        if (!validPages.has(row.pageKey) || !row.componentKey) continue;
        await tx.query(
          `INSERT INTO role_page_components (role_id, page_key, component_key, is_visible, can_input)
           VALUES ($1, $2, $3, $4, $5)`,
          [roleId, row.pageKey, String(row.componentKey), row.visible !== false, row.input !== false],
        );
      }
    });

    await logAudit({
      actor: user, req,
      action: 'ROLE_ACCESS_UPDATE', entityType: 'role', entityId: roleId,
      description: `Updated page activation & component access for role "${role.name}"`,
    });
    return json({ ok: true });
  }

  return null;
};
