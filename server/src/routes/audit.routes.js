import { Router } from 'express';
import { query } from '../db/pool.js';
import { asyncHandler } from '../middleware/errors.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { optionalDate, parsePagination, requireDate } from '../utils/stamps.js';

const router = Router();
router.use(requireAuth);

const PAGE = 'audit_trail';

// GET /api/audit-logs?userId&action&entityType&entityId&from&to&search&page
router.get(
  '/',
  requirePermission(PAGE, 'view'),
  asyncHandler(async (req, res) => {
    const q = req.query;
    const where = [];
    const params = [];

    if (q.userId) { params.push(Number(q.userId)); where.push(`a.user_id = $${params.length}`); }
    if (q.action) { params.push(String(q.action)); where.push(`a.action = $${params.length}`); }
    if (q.entityType) { params.push(String(q.entityType)); where.push(`a.entity_type = $${params.length}`); }
    if (q.entityId) { params.push(String(q.entityId)); where.push(`a.entity_id = $${params.length}`); }
    if (q.from) { params.push(requireDate(q.from, 'from')); where.push(`a.created_at >= $${params.length}::date`); }
    if (q.to) {
      params.push(requireDate(q.to, 'to'));
      where.push(`a.created_at < ($${params.length}::date + INTERVAL '1 day')`);
    }
    if (q.search) {
      params.push(`%${String(q.search).trim()}%`);
      const i = params.length;
      where.push(`(a.description ILIKE $${i} OR a.user_name ILIKE $${i} OR a.entity_type ILIKE $${i})`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const { page, pageSize, offset } = parsePagination(q, { defaultPageSize: 100, maxPageSize: 500 });

    const total = await query(`SELECT COUNT(*)::int AS n FROM audit_logs a ${whereSql}`, params);
    const rows = await query(
      `SELECT a.id, a.user_id, a.user_name, a.user_role, a.action, a.entity_type, a.entity_id,
              a.description, a.previous_value, a.new_value, a.ip_address, a.created_at
         FROM audit_logs a
         ${whereSql}
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT ${pageSize} OFFSET ${offset}`,
      params
    );

    const actions = await query('SELECT DISTINCT action FROM audit_logs ORDER BY action');
    const entityTypes = await query(
      'SELECT DISTINCT entity_type FROM audit_logs WHERE entity_type IS NOT NULL ORDER BY entity_type'
    );

    res.json({
      items: rows.rows,
      total: total.rows[0].n,
      page,
      pageSize,
      filters: {
        actions: actions.rows.map((r) => r.action),
        entityTypes: entityTypes.rows.map((r) => r.entity_type),
      },
    });
  })
);

// GET /api/audit-logs/adjustments — field-level old -> new history (SRS §27)
router.get(
  '/adjustments',
  requirePermission(PAGE, 'view'),
  asyncHandler(async (req, res) => {
    const q = req.query;
    const where = [];
    const params = [];
    if (q.entityType) { params.push(String(q.entityType)); where.push(`a.entity_type = $${params.length}`); }
    if (q.entityId) { params.push(String(q.entityId)); where.push(`a.entity_id = $${params.length}`); }
    if (q.from) { params.push(requireDate(q.from, 'from')); where.push(`a.created_at >= $${params.length}::date`); }
    if (q.to) {
      params.push(requireDate(q.to, 'to'));
      where.push(`a.created_at < ($${params.length}::date + INTERVAL '1 day')`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const { page, pageSize, offset } = parsePagination(q, { defaultPageSize: 100, maxPageSize: 500 });
    const total = await query(`SELECT COUNT(*)::int AS n FROM adjustment_logs a ${whereSql}`, params);
    const rows = await query(
      `SELECT a.id, a.entity_type, a.entity_id, a.field, a.old_value, a.new_value,
              a.reason, a.adjusted_by, a.adjusted_by_name, a.created_at
         FROM adjustment_logs a
         ${whereSql}
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT ${pageSize} OFFSET ${offset}`,
      params
    );
    res.json({ items: rows.rows, total: total.rows[0].n, page, pageSize });
  })
);

// GET /api/audit-logs/reversals — transaction reversals / adjustments
router.get(
  '/reversals',
  requirePermission(PAGE, 'view'),
  asyncHandler(async (req, res) => {
    const q = req.query;
    const where = [];
    const params = [];
    if (q.transactionType) { params.push(String(q.transactionType)); where.push(`r.transaction_type = $${params.length}`); }
    if (q.from) { params.push(requireDate(q.from, 'from')); where.push(`r.created_at >= $${params.length}::date`); }
    if (q.to) {
      params.push(requireDate(q.to, 'to'));
      where.push(`r.created_at < ($${params.length}::date + INTERVAL '1 day')`);
    }
    if (!req.user.isSuperAdmin && !req.user.allDepots) {
      const ids = req.user.depots.map((d) => d.id);
      if (ids.length === 0) where.push('1 = 0');
      else {
        params.push(ids);
        where.push(`r.depot_id = ANY($${params.length}::int[])`);
      }
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const { page, pageSize, offset } = parsePagination(q, { defaultPageSize: 100, maxPageSize: 500 });
    const total = await query(`SELECT COUNT(*)::int AS n FROM transaction_reversals r ${whereSql}`, params);
    const rows = await query(
      `SELECT r.id, r.transaction_type, r.transaction_id, r.action, r.amount, r.reason,
              r.replacement_transaction_id, r.performed_by, r.performed_by_name, r.created_at,
              d.code AS depot_code
         FROM transaction_reversals r
         LEFT JOIN depots d ON d.id = r.depot_id
         ${whereSql}
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT ${pageSize} OFFSET ${offset}`,
      params
    );
    res.json({ items: rows.rows, total: total.rows[0].n, page, pageSize });
  })
);

export default router;
