import { Router } from 'express';
import { query, withTransaction } from '../db/pool.js';
import { asyncHandler, badRequest, conflict, forbidden, notFound } from '../middleware/errors.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { logAudit, logAdjustments } from '../middleware/audit.js';
import { assertDepotAccess, hasPermission } from '../services/accessService.js';
import { serverStamps, requireDate, requireAmount, optionalString, requireString } from '../utils/stamps.js';

const router = Router();
router.use(requireAuth);

const PAGE = 'stock_balance';

const SELECT_SQL = `
  SELECT s.id, s.depot_id, d.code AS depot_code, d.name AS depot_name,
         s.transaction_date, s.stock_value,
         s.reference, s.notes, s.status,
         s.entry_date, s.entry_time, s.entered_by, s.entered_by_name, s.entered_by_role,
         s.last_updated_by, s.last_updated_by_name, s.last_updated_at,
         s.reversal_id, tr.reason AS reversal_reason, tr.performed_by_name AS reversed_by_name,
         s.created_at, s.updated_at,
         (SELECT COUNT(*) FROM stock_value_history h WHERE h.stock_value_record_id = s.id AND h.action = 'correction')::int AS correction_count
    FROM stock_value_records s
    JOIN depots d ON d.id = s.depot_id
    LEFT JOIN transaction_reversals tr ON tr.id = s.reversal_id
`;

function buildWhere(user, q) {
  const where = [];
  const params = [];
  if (q.depotId) {
    params.push(assertDepotAccess(user, q.depotId));
    where.push(`s.depot_id = $${params.length}`);
  } else if (!user.isSuperAdmin && !user.allDepots) {
    const ids = user.depots.map((d) => d.id);
    if (ids.length === 0) where.push('1 = 0');
    else {
      params.push(ids);
      where.push(`s.depot_id = ANY($${params.length}::int[])`);
    }
  }
  if (q.from) { params.push(requireDate(q.from, 'from')); where.push(`s.transaction_date >= $${params.length}`); }
  if (q.to) { params.push(requireDate(q.to, 'to')); where.push(`s.transaction_date <= $${params.length}`); }
  if (q.enteredBy) { params.push(Number(q.enteredBy)); where.push(`s.entered_by = $${params.length}`); }
  if (q.status && q.status !== 'all') {
    if (!['posted', 'reversed'].includes(q.status)) throw badRequest('status must be posted, reversed or all');
    params.push(q.status); where.push(`s.status = $${params.length}`);
  }
  if (q.search) {
    params.push(`%${String(q.search).trim()}%`);
    where.push(`(s.reference ILIKE $${params.length} OR s.notes ILIKE $${params.length} OR s.entered_by_name ILIKE $${params.length})`);
  }
  return { whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

async function getById(user, id) {
  const params = [id];
  let accessSql = '';
  if (!user.isSuperAdmin && !user.allDepots) {
    params.push(user.depots.map((d) => d.id));
    accessSql = `AND s.depot_id = ANY($2::int[])`;
  }
  const res = await query(`${SELECT_SQL} WHERE s.id = $1 ${accessSql}`, params);
  if (res.rowCount === 0) throw notFound('Stock value record not found');
  return res.rows[0];
}

// GET /api/stock-value
router.get(
  '/',
  requirePermission(PAGE, 'view'),
  asyncHandler(async (req, res) => {
    const q = req.query;
    const { whereSql, params } = buildWhere(req.user, q);
    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(500, Math.max(1, Number(q.pageSize) || 50));

    const total = await query(
      `SELECT COUNT(*)::int AS n,
              MAX(s.stock_value) FILTER (WHERE s.status = 'posted') AS latest_value
         FROM stock_value_records s ${whereSql}`,
      params
    );
    const latest = await query(
      `${SELECT_SQL} ${whereSql}
        ORDER BY s.transaction_date DESC, s.created_at DESC
        LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
      params
    );
    res.json({
      items: latest.rows,
      total: total.rows[0].n,
      latestValue: total.rows[0].latest_value,
      page,
      pageSize,
    });
  })
);

// GET /api/stock-value/:id/history — full correction history
router.get(
  '/:id/history',
  requirePermission(PAGE, 'view_history'),
  asyncHandler(async (req, res) => {
    const record = await getById(req.user, Number(req.params.id));
    const { rows } = await query(
      `SELECT id, action, original_value, new_value, reason,
              changed_by, changed_by_name, changed_at
         FROM stock_value_history
        WHERE stock_value_record_id = $1
        ORDER BY changed_at ASC, id ASC`,
      [record.id]
    );
    res.json({ record, history: rows });
  })
);

// POST /api/stock-value — record the stock value for a day
router.post(
  '/',
  asyncHandler(async (req, res) => {
    if (!hasPermission(req.user, PAGE, 'input')) {
      throw forbidden('You do not have "input" permission on the Stock Balance page');
    }
    const body = req.body ?? {};
    const depotId = assertDepotAccess(req.user, body.depotId);
    const transactionDate = requireDate(body.transactionDate, 'transactionDate');
    const stockValue = requireAmount(body.stockValue, { fieldName: 'stockValue', allowZero: true });
    const reference = optionalString(body.reference, { max: 120 });
    const notes = optionalString(body.notes, { max: 2000 });
    const stamps = serverStamps();

    const id = await withTransaction(async (client) => {
      const settings = await client.query('SELECT opening_balance_date FROM depot_settings WHERE depot_id = $1', [depotId]);
      if (settings.rowCount === 0) throw badRequest('Depot is not configured (missing depot settings)');
      if (settings.rows[0].opening_balance_date && transactionDate < settings.rows[0].opening_balance_date) {
        throw badRequest(`Transaction date is before this depot's opening balance date (${settings.rows[0].opening_balance_date})`);
      }

      const existing = await client.query(
        `SELECT id FROM stock_value_records
          WHERE depot_id = $1 AND transaction_date = $2 AND status = 'posted'`,
        [depotId, transactionDate]
      );
      if (existing.rowCount > 0) {
        throw conflict(
          `A stock value for ${transactionDate} already exists for this depot. ` +
          'Open it and use "Correct" to change the value — the original stays in history.'
        );
      }

      const ins = await client.query(
        `INSERT INTO stock_value_records
           (company_id, depot_id, transaction_date, stock_value, reference, notes,
            entry_date, entry_time, entered_by, entered_by_name, entered_by_role)
         VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id`,
        [depotId, transactionDate, stockValue, reference, notes,
          stamps.entryDate, stamps.entryTime, req.user.id, req.user.fullName ?? req.user.username, req.user.roleName]
      );
      const recordId = ins.rows[0].id;

      await client.query(
        `INSERT INTO stock_value_history
           (stock_value_record_id, action, original_value, new_value, reason, changed_by, changed_by_name)
         VALUES ($1, 'creation', NULL, $2, 'Initial entry', $3, $4)`,
        [recordId, stockValue, req.user.id, req.user.fullName ?? req.user.username]
      );
      await logAudit({
        executor: client, actor: req.user, req,
        action: 'CREATE', entityType: 'stock_value', entityId: recordId,
        description: `Recorded stock value ${stockValue} for ${transactionDate}`,
        newValue: { depotId, transactionDate, stockValue, reference },
      });
      return recordId;
    });

    res.status(201).json({ item: await getById(req.user, id) });
  })
);

// PUT /api/stock-value/:id — correction (SRS §6.4/§27: original retained)
router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    if (!hasPermission(req.user, PAGE, 'edit')) {
      throw forbidden('You do not have "edit" permission on the Stock Balance page');
    }
    const before = await getById(req.user, Number(req.params.id));
    if (before.status === 'reversed') throw conflict('This stock value was reversed and can no longer be corrected');

    const body = req.body ?? {};
    const newValue = requireAmount(body.stockValue, { fieldName: 'stockValue', allowZero: true });
    const reason = requireString(body.reason, 'reason', { max: 500 });

    await withTransaction(async (client) => {
      await client.query(
        `UPDATE stock_value_records
            SET stock_value = $2,
                last_updated_by = $3, last_updated_by_name = $4, last_updated_at = now(),
                updated_at = now()
          WHERE id = $1`,
        [before.id, newValue, req.user.id, req.user.fullName ?? req.user.username]
      );
      await client.query(
        `INSERT INTO stock_value_history
           (stock_value_record_id, action, original_value, new_value, reason, changed_by, changed_by_name)
         VALUES ($1, 'correction', $2, $3, $4, $5, $6)`,
        [before.id, before.stock_value, newValue, reason, req.user.id, req.user.fullName ?? req.user.username]
      );
      await logAdjustments({
        executor: client, actor: req.user, entityType: 'stock_value', entityId: before.id,
        changes: [{ field: 'stock_value', oldValue: before.stock_value, newValue }],
        reason,
      });
      await logAudit({
        executor: client, actor: req.user, req,
        action: 'CORRECTION', entityType: 'stock_value', entityId: before.id,
        description: `Corrected stock value from ${before.stock_value} to ${newValue}: ${reason}`,
        previousValue: { stock_value: before.stock_value },
        newValue: { stock_value: newValue, reason },
      });
    });

    res.json({ item: await getById(req.user, before.id) });
  })
);

// POST /api/stock-value/:id/reverse
router.post(
  '/:id/reverse',
  asyncHandler(async (req, res) => {
    if (!hasPermission(req.user, PAGE, 'edit')) {
      throw forbidden('You do not have "edit" permission on the Stock Balance page');
    }
    const before = await getById(req.user, Number(req.params.id));
    if (before.status === 'reversed') throw conflict('This stock value has already been reversed');
    const reason = requireString(req.body?.reason, 'reason', { max: 500 });

    await withTransaction(async (client) => {
      const rev = await client.query(
        `INSERT INTO transaction_reversals
           (transaction_type, transaction_id, action, amount, depot_id, reason, performed_by, performed_by_name)
         VALUES ('stock_value', $1, 'reversal', $2, $3, $4, $5, $6) RETURNING id`,
        [before.id, before.stock_value, before.depot_id, reason, req.user.id, req.user.fullName ?? req.user.username]
      );
      await client.query(
        `UPDATE stock_value_records SET status = 'reversed', reversal_id = $2, updated_at = now() WHERE id = $1`,
        [before.id, rev.rows[0].id]
      );
      await logAudit({
        executor: client, actor: req.user, req,
        action: 'REVERSAL', entityType: 'stock_value', entityId: before.id,
        description: `Reversed stock value #${before.id} (${before.stock_value}): ${reason}`,
        previousValue: { status: 'posted', stock_value: before.stock_value },
        newValue: { status: 'reversed', reason },
      });
    });

    res.json({ item: await getById(req.user, before.id) });
  })
);

export default router;
