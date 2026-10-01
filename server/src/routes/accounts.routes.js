import { Router } from 'express';
import { query, withTransaction } from '../db/pool.js';
import { asyncHandler, badRequest, conflict, forbidden, notFound } from '../middleware/errors.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { logAudit, logAdjustments, diffFields } from '../middleware/audit.js';
import { assertDepotAccess, hasPermission } from '../services/accessService.js';
import { optionalDate, optionalString, requireString, parsePagination } from '../utils/stamps.js';
import { notifyCustomerDebt, notifySupplierDebt } from '../services/notifyService.js';

/**
 * Customers/Debtors and Suppliers/Creditors are the same shape of account.
 * This factory builds both routers. Balances are always calculated from
 * transactions — there is no editable balance column anywhere.
 */
const CONFIGS = {
  customers: {
    kind: 'customers',
    table: 'customers',
    pageKey: 'customers',
    entity: 'customer',
    label: 'Customer',
    codePrefix: 'CUS',
    debitTable: 'credit_sales',
    creditTable: 'customer_payments',
    fk: 'customer_id',
    ledgerView: 'customer_account_ledger',
    balanceLabel: 'outstanding credit',
    notify: notifyCustomerDebt,
  },
  suppliers: {
    kind: 'suppliers',
    table: 'suppliers',
    pageKey: 'suppliers',
    entity: 'supplier',
    label: 'Supplier',
    codePrefix: 'SUP',
    debitTable: 'supplier_purchases',
    creditTable: 'supplier_payments',
    fk: 'supplier_id',
    ledgerView: 'supplier_account_ledger',
    balanceLabel: 'outstanding debt',
    notify: notifySupplierDebt,
  },
};

export function createAccountRouter(kindName) {
  const cfg = CONFIGS[kindName];
  if (!cfg) throw new Error(`Unknown account kind: ${kindName}`);

  const router = Router();
  router.use(requireAuth);

  const C = cfg;
  const balanceExpr = (asOfParamIndex) => `
    COALESCE((
      SELECT SUM(amount) FROM ${C.debitTable}
       WHERE ${C.fk} = a.id AND status = 'posted'
         AND ($${asOfParamIndex}::date IS NULL OR transaction_date <= $${asOfParamIndex}::date)
    ), 0)
    - COALESCE((
      SELECT SUM(amount) FROM ${C.creditTable}
       WHERE ${C.fk} = a.id AND status = 'posted'
         AND ($${asOfParamIndex}::date IS NULL OR transaction_date <= $${asOfParamIndex}::date)
    ), 0)
  `;

  function buildWhere(user, q, params, asOf) {
    // PostgreSQL rejects bind parameters the statement never references
    // ("bind message supplies 1 parameters, but prepared statement requires 0"),
    // so this always-true clause keeps $<asOf> in the count query even when no
    // filters are applied.
    const where = [`($${asOf}::date IS NULL OR $${asOf}::date IS NOT NULL)`];
    if (q.depotId) {
      params.push(assertDepotAccess(user, q.depotId));
      where.push(`a.depot_id = $${params.length}`);
    } else if (!user.isSuperAdmin && !user.allDepots) {
      const ids = user.depots.map((d) => d.id);
      if (ids.length === 0) where.push('1 = 0');
      else {
        params.push(ids);
        where.push(`a.depot_id = ANY($${params.length}::int[])`);
      }
    }
    if (q.search) {
      params.push(`%${String(q.search).trim()}%`);
      const i = params.length;
      where.push(`(a.name ILIKE $${i} OR a.code ILIKE $${i} OR a.phone ILIKE $${i} OR a.reference ILIKE $${i})`);
    }
    if (q.isActive !== undefined && q.isActive !== 'all') {
      params.push(q.isActive === 'true' || q.isActive === true);
      where.push(`a.is_active = $${params.length}`);
    }
    if (q.withBalance === 'true') {
      where.push(`${balanceExpr(asOf)} <> 0`);
    }
    return where.length ? `WHERE ${where.join(' AND ')}` : '';
  }

  async function getAccount(user, id, asOf) {
    const params = [id, asOf];
    let accessSql = '';
    if (!user.isSuperAdmin && !user.allDepots) {
      params.push(user.depots.map((d) => d.id));
      accessSql = `AND a.depot_id = ANY($3::int[])`;
    }
    const res = await query(
      `SELECT a.id, a.code, a.reference, a.name, a.phone, a.address, a.notes, a.is_active,
              a.depot_id, d.code AS depot_code, d.name AS depot_name,
              a.created_at, a.created_by_name, a.updated_at,
              ${balanceExpr(2)} AS balance
         FROM ${C.table} a
         JOIN depots d ON d.id = a.depot_id
        WHERE a.id = $1 ${accessSql}`,
      params
    );
    if (res.rowCount === 0) throw notFound(`${C.label} not found`);
    return res.rows[0];
  }

  // Names must be unique across every depot (case- and whitespace-insensitive).
  async function assertNameAvailable(name, excludeId = null) {
    const res = await query(
      `SELECT code FROM ${C.table}
        WHERE lower(btrim(name)) = lower(btrim($1))
          AND ($2::int IS NULL OR id <> $2::int)
        LIMIT 1`,
      [name, excludeId]
    );
    if (res.rowCount > 0) {
      throw conflict(
        `${C.label} "${name}" already exists (${res.rows[0].code}) — every ${C.label.toLowerCase()} name must be unique.`
      );
    }
  }

  // GET / — list with computed balances as of `to` (default: today)
  router.get(
    '/',
    requirePermission(C.pageKey, 'view'),
    asyncHandler(async (req, res) => {
      const q = req.query;
      const asOf = optionalDate(q.to, 'to') ?? new Date().toISOString().slice(0, 10);
      const { page, pageSize, offset } = parsePagination(q);
      // $1 is always the as-of date; filtered clauses are appended after it.
      const params = [asOf];
      const whereSql = buildWhere(req.user, q, params, 1);

      const totalRes = await query(
        `SELECT COUNT(*)::int AS n FROM ${C.table} a ${whereSql}`,
        params
      );
      const listRes = await query(
        `SELECT a.id, a.code, a.reference, a.name, a.phone, a.address, a.notes, a.is_active,
                a.depot_id, d.code AS depot_code, d.name AS depot_name,
                a.created_at, a.created_by_name,
                ${balanceExpr(1)} AS balance,
                (SELECT MAX(transaction_date) FROM ${C.debitTable}
                  WHERE ${C.fk} = a.id AND status = 'posted') AS last_activity_date
           FROM ${C.table} a
           JOIN depots d ON d.id = a.depot_id
           ${whereSql}
          ORDER BY a.name
          LIMIT ${pageSize} OFFSET ${offset}`,
        params
      );
      const totalsRes = await query(
        `SELECT COALESCE(SUM(${balanceExpr(1)}), 0) AS total_balance FROM ${C.table} a ${whereSql}`,
        params
      );

      res.json({
        items: listRes.rows,
        total: totalRes.rows[0].n,
        totalBalance: totalsRes.rows[0].total_balance,
        asOf,
        page,
        pageSize,
      });
    })
  );

  // GET /:id — account detail with summary
  router.get(
    '/:id',
    requirePermission(C.pageKey, 'view'),
    asyncHandler(async (req, res) => {
      const asOf = optionalDate(req.query.to, 'to') ?? new Date().toISOString().slice(0, 10);
      const account = await getAccount(req.user, Number(req.params.id), asOf);

      const totals = await query(
        `SELECT
           COALESCE((SELECT SUM(amount) FROM ${C.debitTable}
                      WHERE ${C.fk} = $1 AND status='posted' AND transaction_date <= $2), 0) AS debit_total,
           COALESCE((SELECT SUM(amount) FROM ${C.creditTable}
                      WHERE ${C.fk} = $1 AND status='posted' AND transaction_date <= $2), 0) AS credit_total`,
        [account.id, asOf]
      );

      res.json({ account, totals: totals.rows[0], asOf });
    })
  );

  // GET /:id/ledger — running-balance ledger (history permission)
  router.get(
    '/:id/ledger',
    requirePermission(C.pageKey, 'view_history'),
    asyncHandler(async (req, res) => {
      const asOf = optionalDate(req.query.to, 'to') ?? new Date().toISOString().slice(0, 10);
      const account = await getAccount(req.user, Number(req.params.id), asOf);
      const { rows } = await query(
        `SELECT source_id, entry_type, direction, amount, signed_amount, running_balance,
                transaction_date, entry_date, entry_time, reference, entered_by, entered_by_name
           FROM ${C.ledgerView}
          WHERE ${C.fk} = $1 AND transaction_date <= $2
          ORDER BY transaction_date, created_at, source_id`,
        [account.id, asOf]
      );
      res.json({ account, ledger: rows, asOf });
    })
  );

  // POST / — create account
  router.post(
    '/',
    asyncHandler(async (req, res) => {
      if (!hasPermission(req.user, C.pageKey, 'input')) {
        throw forbidden(`You do not have "input" permission on the ${C.pageKey} page`);
      }
      const body = req.body ?? {};
      const depotId = assertDepotAccess(req.user, body.depotId);
      const name = requireString(body.name, 'name', { max: 160 });
      await assertNameAvailable(name);
      const phone = optionalString(body.phone, { max: 40 });
      const address = optionalString(body.address, { max: 300 });
      const reference = optionalString(body.reference, { max: 80 });
      const notes = optionalString(body.notes, { max: 2000 });

      const id = await withTransaction(async (client) => {
        const res = await client.query(
          `INSERT INTO ${C.table} (depot_id, name, phone, address, reference, notes, created_by, created_by_name, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $7) RETURNING id, code`,
          [depotId, name, phone, address, reference, notes, req.user.id, req.user.fullName ?? req.user.username]
        );
        await logAudit({
          executor: client, actor: req.user, req,
          action: 'CREATE', entityType: C.entity, entityId: res.rows[0].id,
          description: `Created ${C.label.toLowerCase()} ${res.rows[0].code} — ${name}`,
          newValue: { depotId, name, phone, address, reference },
        });
        return res.rows[0].id;
      });

      res.status(201).json({ account: await getAccount(req.user, id, null) });
    })
  );

  // PUT /:id — edit master data or activate/deactivate (never the balance)
  router.put(
    '/:id',
    asyncHandler(async (req, res) => {
      if (!hasPermission(req.user, C.pageKey, 'edit')) {
        throw forbidden(`You do not have "edit" permission on the ${C.pageKey} page`);
      }
      const before = await getAccount(req.user, Number(req.params.id), null);
      const body = req.body ?? {};

      const updates = {};
      if (body.name !== undefined) updates.name = requireString(body.name, 'name', { max: 160 });
      if (body.phone !== undefined) updates.phone = optionalString(body.phone, { max: 40 });
      if (body.address !== undefined) updates.address = optionalString(body.address, { max: 300 });
      if (body.reference !== undefined) updates.reference = optionalString(body.reference, { max: 80 });
      if (body.notes !== undefined) updates.notes = optionalString(body.notes, { max: 2000 });
      if (body.isActive !== undefined) updates.is_active = body.isActive === true;
      if (Object.keys(updates).length === 0) throw badRequest('Nothing to update');
      if (updates.name) await assertNameAvailable(updates.name, before.id);

      await withTransaction(async (client) => {
        const cols = Object.keys(updates);
        const setSql = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
        await client.query(
          `UPDATE ${C.table} SET ${setSql}, updated_at = now(), updated_by = $${cols.length + 2} WHERE id = $1`,
          [before.id, ...cols.map((c) => updates[c]), req.user.id]
        );
        await logAdjustments({
          executor: client, actor: req.user, entityType: C.entity, entityId: before.id,
          changes: diffFields(before, { ...before, ...updates }, ['name', 'phone', 'address', 'reference', 'notes', 'is_active']),
          reason: body.reason ? optionalString(body.reason, { max: 500 }) : `${C.label} record update`,
        });
        await logAudit({
          executor: client, actor: req.user, req,
          action: 'UPDATE', entityType: C.entity, entityId: before.id,
          description: `Updated ${C.label.toLowerCase()} ${before.code ?? before.name}`,
          previousValue: { name: before.name, phone: before.phone, address: before.address, reference: before.reference, notes: before.notes, is_active: before.is_active },
          newValue: updates,
        });
      });

      res.json({ account: await getAccount(req.user, before.id, null) });
    })
  );

  // DELETE /:id — only possible when there are no transactions at all.
  router.delete(
    '/:id',
    asyncHandler(async (req, res) => {
      if (!hasPermission(req.user, C.pageKey, 'edit')) {
        throw forbidden(`You do not have "edit" permission on the ${C.pageKey} page`);
      }
      const before = await getAccount(req.user, Number(req.params.id), null);
      const counts = await query(
        `SELECT
           (SELECT COUNT(*) FROM ${C.debitTable}  WHERE ${C.fk} = $1)::int AS debits,
           (SELECT COUNT(*) FROM ${C.creditTable} WHERE ${C.fk} = $1)::int AS credits`,
        [before.id]
      );
      const { debits, credits } = counts.rows[0];
      if (debits > 0 || credits > 0) {
        throw conflict(
          `${C.label} "${before.name}" has ${debits + credits} financial transaction(s) and cannot be deleted. ` +
          'Mark the record inactive instead — historical transactions remain accessible.'
        );
      }

      await withTransaction(async (client) => {
        await client.query(`DELETE FROM ${C.table} WHERE id = $1`, [before.id]);
        await logAudit({
          executor: client, actor: req.user, req,
          action: 'DELETE', entityType: C.entity, entityId: before.id,
          description: `Deleted unused ${C.label.toLowerCase()} ${before.code} — ${before.name}`,
          previousValue: { code: before.code, name: before.name },
        });
      });
      res.json({ ok: true });
    })
  );

  return router;
}
