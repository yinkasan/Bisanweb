import { Router } from 'express';
import { query, pool } from '../db/pool.js';
import { asyncHandler, notFound } from '../middleware/errors.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { logAudit } from '../middleware/audit.js';
import { COMPONENT_CATALOG } from '../services/permissionCatalog.js';

const router = Router();
router.use(requireAuth);

// GET /api/roles — the four role levels (for dropdowns)
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT id, key, name, level, description,
              (SELECT COUNT(*) FROM user_roles ur JOIN users u ON u.id = ur.user_id
                WHERE ur.role_id = roles.id AND ur.is_active)::int AS user_count
         FROM roles ORDER BY level`
    );
    res.json({ roles: rows });
  })
);

// GET /api/permissions — the page catalogue with which actions exist per page
router.get(
  '/permissions',
  requirePermission('roles_permissions', 'view'),
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT page_key, page_name, section, sort_order FROM permissions ORDER BY sort_order`
    );
    res.json({ permissions: rows });
  })
);

// GET /api/roles/access — everything the role-access editor needs
router.get(
  '/access',
  requirePermission('roles_permissions', 'view'),
  asyncHandler(async (req, res) => {
    const [roles, pages, rolePermissions, components] = await Promise.all([
      query(
        `SELECT r.id, r.key, r.name, r.level, r.description,
                (SELECT COUNT(*) FROM user_roles ur JOIN users u ON u.id = ur.user_id
                  WHERE ur.role_id = r.id AND ur.is_active)::int AS user_count
           FROM roles r ORDER BY r.level`
      ),
      query('SELECT page_key, page_name, section, sort_order FROM permissions ORDER BY sort_order'),
      query(
        `SELECT role_id, page_key, can_view, can_input, can_edit,
                can_view_history, can_export, can_approve
           FROM role_permissions`
      ),
      query('SELECT role_id, page_key, component_key, is_visible, can_input FROM role_page_components'),
    ]);
    res.json({
      roles: roles.rows,
      pages: pages.rows,
      rolePermissions: rolePermissions.rows,
      components: components.rows,
      componentCatalog: COMPONENT_CATALOG,
    });
  })
);

// PUT /api/roles/:roleId/access — save page activation + component access
router.put(
  '/:roleId/access',
  requirePermission('roles_permissions', 'edit'),
  asyncHandler(async (req, res) => {
    const roleId = Number(req.params.roleId);
    const role = await query('SELECT id, name FROM roles WHERE id = $1', [roleId]);
    if (role.rowCount === 0) throw notFound('Role not found');

    const { pages = [], components = [] } = req.body ?? {};
    const validPages = new Set(
      (await query('SELECT page_key FROM permissions')).rows.map((r) => r.page_key)
    );

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM role_permissions WHERE role_id = $1', [roleId]);
      for (const p of pages) {
        if (!validPages.has(p.pageKey)) continue;
        const flags = [p.view, p.input, p.edit, p.viewHistory, p.export, p.approve].map(Boolean);
        if (!flags.some(Boolean)) continue; // a fully deactivated page = no row
        await client.query(
          `INSERT INTO role_permissions (role_id, page_key, can_view, can_input, can_edit,
                                         can_view_history, can_export, can_approve)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [roleId, p.pageKey, ...flags]
        );
      }
      await client.query('DELETE FROM role_page_components WHERE role_id = $1', [roleId]);
      for (const c of components) {
        if (!validPages.has(c.pageKey) || !c.componentKey) continue;
        await client.query(
          `INSERT INTO role_page_components (role_id, page_key, component_key, is_visible, can_input)
           VALUES ($1, $2, $3, $4, $5)`,
          [roleId, c.pageKey, String(c.componentKey), c.visible !== false, c.input !== false]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    await logAudit({
      actor: req.user,
      req,
      action: 'ROLE_ACCESS_UPDATE',
      entityType: 'role',
      entityId: roleId,
      description: `Updated page activation & component access for role "${role.rows[0].name}"`,
    });
    res.json({ ok: true });
  })
);

export default router;
