/**
 * /audit-logs — port of server/src/routes/audit.routes.js. Read-only views
 * over the audit trail, field-level adjustments and reversals.
 */
import { json } from '../../_shared/http.ts';
import { query, queryOne } from '../../_shared/db.ts';
import { assertPermission } from '../../_shared/auth.ts';
import { requireDate } from '../../_shared/stamps.ts';
import { parsePagination, type Ctx, type ModuleHandler } from '../_ctx.ts';

const PAGE = 'audit_trail';

export const handleAuditLogs: ModuleHandler = async (c: Ctx): Promise<Response | null> => {
  const { method, path, url, user } = c;
  if (!path.startsWith('/audit-logs')) return null;
  if (method !== 'GET') return null;
  assertPermission(user, PAGE, 'view');

  const sp = url.searchParams;

  // GET /audit-logs/adjustments — field-level old -> new history (SRS §27)
  if (path === '/audit-logs/adjustments') {
    const where: string[] = [];
    const params: unknown[] = [];
    if (sp.get('entityType')) {
      params.push(String(sp.get('entityType')));
      where.push(`a.entity_type = $${params.length}`);
    }
    if (sp.get('entityId')) {
      params.push(String(sp.get('entityId')));
      where.push(`a.entity_id = $${params.length}`);
    }
    if (sp.get('from')) {
      params.push(requireDate(sp.get('from')!, 'from'));
      where.push(`a.created_at >= $${params.length}::date`);
    }
    if (sp.get('to')) {
      params.push(requireDate(sp.get('to')!, 'to'));
      where.push(`a.created_at < ($${params.length}::date + INTERVAL '1 day')`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const { page, pageSize, offset } = parsePagination(sp, 100, 500);
    const total = await queryOne<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM adjustment_logs a ${whereSql}`,
      params,
    );
    const rows = await query(
      `SELECT a.id, a.entity_type, a.entity_id, a.field, a.old_value, a.new_value,
              a.reason, a.adjusted_by, a.adjusted_by_name, a.created_at
         FROM adjustment_logs a
         ${whereSql}
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT ${pageSize} OFFSET ${offset}`,
      params,
    );
    return json({ items: rows, total: total?.n ?? 0, page, pageSize });
  }

  // GET /audit-logs/reversals — transaction reversals / adjustments
  if (path === '/audit-logs/reversals') {
    const where: string[] = [];
    const params: unknown[] = [];
    if (sp.get('transactionType')) {
      params.push(String(sp.get('transactionType')));
      where.push(`r.transaction_type = $${params.length}`);
    }
    if (sp.get('from')) {
      params.push(requireDate(sp.get('from')!, 'from'));
      where.push(`r.created_at >= $${params.length}::date`);
    }
    if (sp.get('to')) {
      params.push(requireDate(sp.get('to')!, 'to'));
      where.push(`r.created_at < ($${params.length}::date + INTERVAL '1 day')`);
    }
    if (!user.isSuperAdmin && !user.allDepots) {
      const ids = user.depots.map((d) => d.id);
      if (ids.length === 0) where.push('1 = 0');
      else {
        params.push(ids);
        where.push(`r.depot_id = ANY($${params.length}::int[])`);
      }
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const { page, pageSize, offset } = parsePagination(sp, 100, 500);
    const total = await queryOne<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM transaction_reversals r ${whereSql}`,
      params,
    );
    const rows = await query(
      `SELECT r.id, r.transaction_type, r.transaction_id, r.action, r.amount, r.reason,
              r.replacement_transaction_id, r.performed_by, r.performed_by_name, r.created_at,
              d.code AS depot_code
         FROM transaction_reversals r
         LEFT JOIN depots d ON d.id = r.depot_id
         ${whereSql}
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT ${pageSize} OFFSET ${offset}`,
      params,
    );
    return json({ items: rows, total: total?.n ?? 0, page, pageSize });
  }

  // GET /audit-logs?userId&action&entityType&entityId&from&to&search&page
  if (path === '/audit-logs') {
    const where: string[] = [];
    const params: unknown[] = [];
    if (sp.get('userId')) {
      params.push(Number(sp.get('userId')));
      where.push(`a.user_id = $${params.length}`);
    }
    if (sp.get('action')) {
      params.push(String(sp.get('action')));
      where.push(`a.action = $${params.length}`);
    }
    if (sp.get('entityType')) {
      params.push(String(sp.get('entityType')));
      where.push(`a.entity_type = $${params.length}`);
    }
    if (sp.get('entityId')) {
      params.push(String(sp.get('entityId')));
      where.push(`a.entity_id = $${params.length}`);
    }
    if (sp.get('from')) {
      params.push(requireDate(sp.get('from')!, 'from'));
      where.push(`a.created_at >= $${params.length}::date`);
    }
    if (sp.get('to')) {
      params.push(requireDate(sp.get('to')!, 'to'));
      where.push(`a.created_at < ($${params.length}::date + INTERVAL '1 day')`);
    }
    if (sp.get('search')) {
      params.push(`%${String(sp.get('search')).trim()}%`);
      const i = params.length;
      where.push(`(a.description ILIKE $${i} OR a.user_name ILIKE $${i} OR a.entity_type ILIKE $${i})`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const { page, pageSize, offset } = parsePagination(sp, 100, 500);
    const total = await queryOne<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM audit_logs a ${whereSql}`,
      params,
    );
    const rows = await query(
      `SELECT a.id, a.user_id, a.user_name, a.user_role, a.action, a.entity_type, a.entity_id,
              a.description, a.previous_value, a.new_value, a.ip_address, a.created_at
         FROM audit_logs a
         ${whereSql}
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT ${pageSize} OFFSET ${offset}`,
      params,
    );
    const actions = await query<{ action: string }>(
      'SELECT DISTINCT action FROM audit_logs ORDER BY action',
    );
    const entityTypes = await query<{ entity_type: string }>(
      'SELECT DISTINCT entity_type FROM audit_logs WHERE entity_type IS NOT NULL ORDER BY entity_type',
    );
    return json({
      items: rows,
      total: total?.n ?? 0,
      page,
      pageSize,
      filters: {
        actions: actions.map((r) => r.action),
        entityTypes: entityTypes.map((r) => r.entity_type),
      },
    });
  }

  return null;
};
