/**
 * /customers + /suppliers — port of server/src/routes/accounts.routes.js.
 * Customers/Debtors and Suppliers/Creditors are the same shape of account;
 * one factory builds both handlers. Balances are always calculated from
 * transactions — there is no editable balance column anywhere.
 */
import { HttpError, json } from '../../_shared/http.ts';
import { query, queryOne, withTransaction } from '../../_shared/db.ts';
import { assertDepotAccess, assertPermission, hasPermission, type UserContext } from '../../_shared/auth.ts';
import { diffFields, logAdjustments, logAudit } from '../../_shared/audit.ts';
import { optionalDate, optionalString, requireString, todayIso } from '../../_shared/stamps.ts';
import { notifyCustomerDebt, notifySupplierDebt } from '../../_shared/notify.ts';
import { badRequest, bodyOf, conflict, notFound, parsePagination, under, type Ctx, type ModuleHandler } from '../_ctx.ts';

const forbidden = (m: string) => new HttpError(403, m);

interface AccountConfig {
  kind: string;
  prefix: string;
  table: string;
  pageKey: string;
  entity: string;
  label: string;
  debitTable: string;
  creditTable: string;
  fk: string;
  ledgerView: string;
  notify: (id: number) => Promise<void>;
}

const CONFIGS: Record<string, AccountConfig> = {
  customers: {
    kind: 'customers', prefix: '/customers',
    table: 'customers', pageKey: 'customers', entity: 'customer', label: 'Customer',
    debitTable: 'credit_sales', creditTable: 'customer_payments', fk: 'customer_id',
    ledgerView: 'customer_account_ledger',
    notify: notifyCustomerDebt,
  },
  suppliers: {
    kind: 'suppliers', prefix: '/suppliers',
    table: 'suppliers', pageKey: 'suppliers', entity: 'supplier', label: 'Supplier',
    debitTable: 'supplier_purchases', creditTable: 'supplier_payments', fk: 'supplier_id',
    ledgerView: 'supplier_account_ledger',
    notify: notifySupplierDebt,
  },
};

function createAccountHandler(C: AccountConfig): ModuleHandler {
  const balanceExpr = (asOfParamIndex: number) => `
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

  function buildWhere(user: UserContext, q: URLSearchParams, params: unknown[], asOf: number): string {
    // PostgreSQL rejects bind parameters the statement never references
    // ("bind message supplies 1 parameters, but prepared statement requires 0"),
    // so this always-true clause keeps $<asOf> in the count query even when no
    // filters are applied.
    const where: string[] = [`($${asOf}::date IS NULL OR $${asOf}::date IS NOT NULL)`];
    if (q.get('depotId')) {
      params.push(assertDepotAccess(user, q.get('depotId')));
      where.push(`a.depot_id = $${params.length}`);
    } else if (!user.isSuperAdmin && !user.allDepots) {
      const ids = user.depots.map((d) => d.id);
      if (ids.length === 0) where.push('1 = 0');
      else {
        params.push(ids);
        where.push(`a.depot_id = ANY($${params.length}::int[])`);
      }
    }
    if (q.get('search')) {
      params.push(`%${String(q.get('search')).trim()}%`);
      const i = params.length;
      where.push(`(a.name ILIKE $${i} OR a.code ILIKE $${i} OR a.phone ILIKE $${i} OR a.reference ILIKE $${i})`);
    }
    const isActive = q.get('isActive');
    if (isActive !== null && isActive !== 'all') {
      params.push(isActive === 'true');
      where.push(`a.is_active = $${params.length}`);
    }
    if (q.get('withBalance') === 'true') {
      where.push(`${balanceExpr(asOf)} <> 0`);
    }
    return where.length ? `WHERE ${where.join(' AND ')}` : '';
  }

  async function getAccount(user: UserContext, id: number, asOf: string | null): Promise<Record<string, any>> {
    const params: unknown[] = [id, asOf];
    let accessSql = '';
    if (!user.isSuperAdmin && !user.allDepots) {
      params.push(user.depots.map((d) => d.id));
      accessSql = `AND a.depot_id = ANY($3::int[])`;
    }
    const row = await queryOne<Record<string, any>>(
      `SELECT a.id, a.code, a.reference, a.name, a.phone, a.address, a.notes, a.is_active,
              a.depot_id, d.code AS depot_code, d.name AS depot_name,
              a.created_at, a.created_by_name, a.updated_at,
              ${balanceExpr(2)} AS balance
         FROM ${C.table} a
         JOIN depots d ON d.id = a.depot_id
        WHERE a.id = $1 ${accessSql}`,
      params,
    );
    if (!row) throw notFound(`${C.label} not found`);
    return row;
  }

  // Names must be unique across every depot (case- and whitespace-insensitive).
  async function assertNameAvailable(name: string, excludeId: number | null = null): Promise<void> {
    const row = await queryOne<{ code: string }>(
      `SELECT code FROM ${C.table}
        WHERE lower(btrim(name)) = lower(btrim($1))
          AND ($2::int IS NULL OR id <> $2::int)
        LIMIT 1`,
      [name, excludeId],
    );
    if (row) {
      throw conflict(
        `${C.label} "${name}" already exists (${row.code}) — every ${C.label.toLowerCase()} name must be unique.`,
      );
    }
  }

  return async (c: Ctx): Promise<Response | null> => {
    const rest = under(c.path, C.prefix);
    if (!rest) return null;
    const { method, req, url, user } = c;
    const q = url.searchParams;

    // GET / — list with computed balances as of `to` (default: today)
    if (method === 'GET' && rest === '/') {
      assertPermission(user, C.pageKey, 'view');
      const asOf = optionalDate(q.get('to'), 'to') ?? todayIso();
      const { page, pageSize, offset } = parsePagination(q);
      // $1 is always the as-of date; filtered clauses are appended after it.
      const params: unknown[] = [asOf];
      const whereSql = buildWhere(user, q, params, 1);

      const totalRes = await queryOne<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM ${C.table} a ${whereSql}`,
        params,
      );
      const items = await query(
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
        params,
      );
      const totalsRes = await queryOne<{ total_balance: string }>(
        `SELECT COALESCE(SUM(${balanceExpr(1)}), 0) AS total_balance FROM ${C.table} a ${whereSql}`,
        params,
      );

      return json({
        items,
        total: totalRes?.n ?? 0,
        totalBalance: totalsRes?.total_balance ?? 0,
        asOf,
        page,
        pageSize,
      });
    }

    // POST / — create account
    if (method === 'POST' && rest === '/') {
      if (!hasPermission(user, C.pageKey, 'input')) {
        throw forbidden(`You do not have "input" permission on the ${C.pageKey} page`);
      }
      const body = await bodyOf(req);
      const depotId = assertDepotAccess(user, body.depotId);
      const name = requireString(body.name, 'name', 160);
      await assertNameAvailable(name);
      const phone = optionalString(body.phone, 40);
      const address = optionalString(body.address, 300);
      const reference = optionalString(body.reference, 80);
      const notes = optionalString(body.notes, 2000);

      const id = await withTransaction(async (tx) => {
        const row = await tx.queryOne<{ id: number; code: string }>(
          `INSERT INTO ${C.table} (depot_id, name, phone, address, reference, notes, created_by, created_by_name, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $7) RETURNING id, code`,
          [depotId, name, phone, address, reference, notes, user.id, user.fullName ?? user.username],
        );
        await logAudit({
          tx, actor: user, req,
          action: 'CREATE', entityType: C.entity, entityId: row!.id,
          description: `Created ${C.label.toLowerCase()} ${row!.code} — ${name}`,
          newValue: { depotId, name, phone, address, reference },
        });
        return Number(row!.id);
      });

      return json({ account: await getAccount(user, id, null) }, 201);
    }

    const idMatch = /^\/(\d+)(\/.*)?$/.exec(rest);
    if (!idMatch) return null;
    const id = Number(idMatch[1]);
    const sub = idMatch[2] ?? '/';

    // GET /:id — account detail with summary
    if (method === 'GET' && sub === '/') {
      assertPermission(user, C.pageKey, 'view');
      const asOf = optionalDate(q.get('to'), 'to') ?? todayIso();
      const account = await getAccount(user, id, asOf);

      const totals = await queryOne<Record<string, unknown>>(
        `SELECT
           COALESCE((SELECT SUM(amount) FROM ${C.debitTable}
                      WHERE ${C.fk} = $1 AND status='posted' AND transaction_date <= $2), 0) AS debit_total,
           COALESCE((SELECT SUM(amount) FROM ${C.creditTable}
                      WHERE ${C.fk} = $1 AND status='posted' AND transaction_date <= $2), 0) AS credit_total`,
        [account.id, asOf],
      );

      return json({ account, totals, asOf });
    }

    // GET /:id/ledger — running-balance ledger (history permission)
    if (method === 'GET' && sub === '/ledger') {
      assertPermission(user, C.pageKey, 'view_history');
      const asOf = optionalDate(q.get('to'), 'to') ?? todayIso();
      const account = await getAccount(user, id, asOf);
      const rows = await query(
        `SELECT source_id, entry_type, direction, amount, signed_amount, running_balance,
                transaction_date, entry_date, entry_time, reference, entered_by, entered_by_name
           FROM ${C.ledgerView}
          WHERE ${C.fk} = $1 AND transaction_date <= $2
          ORDER BY transaction_date, created_at, source_id`,
        [account.id, asOf],
      );
      return json({ account, ledger: rows, asOf });
    }

    // PUT /:id — edit master data or activate/deactivate (never the balance)
    if (method === 'PUT' && sub === '/') {
      if (!hasPermission(user, C.pageKey, 'edit')) {
        throw forbidden(`You do not have "edit" permission on the ${C.pageKey} page`);
      }
      const before = await getAccount(user, id, null);
      const body = await bodyOf(req);

      const updates: Record<string, unknown> = {};
      if (body.name !== undefined) updates.name = requireString(body.name, 'name', 160);
      if (body.phone !== undefined) updates.phone = optionalString(body.phone, 40);
      if (body.address !== undefined) updates.address = optionalString(body.address, 300);
      if (body.reference !== undefined) updates.reference = optionalString(body.reference, 80);
      if (body.notes !== undefined) updates.notes = optionalString(body.notes, 2000);
      if (body.isActive !== undefined) updates.is_active = body.isActive === true;
      if (Object.keys(updates).length === 0) throw badRequest('Nothing to update');
      if (updates.name) await assertNameAvailable(String(updates.name), Number(before.id));

      await withTransaction(async (tx) => {
        const cols = Object.keys(updates);
        const setSql = cols.map((col, i) => `${col} = $${i + 2}`).join(', ');
        await tx.query(
          `UPDATE ${C.table} SET ${setSql}, updated_at = now(), updated_by = $${cols.length + 2} WHERE id = $1`,
          [before.id, ...cols.map((col) => updates[col]), user.id],
        );
        await logAdjustments({
          tx, actor: user, entityType: C.entity, entityId: before.id,
          changes: diffFields(before, { ...before, ...updates }, ['name', 'phone', 'address', 'reference', 'notes', 'is_active']),
          reason: body.reason ? optionalString(body.reason, 500) : `${C.label} record update`,
        });
        await logAudit({
          tx, actor: user, req,
          action: 'UPDATE', entityType: C.entity, entityId: before.id,
          description: `Updated ${C.label.toLowerCase()} ${before.code ?? before.name}`,
          previousValue: { name: before.name, phone: before.phone, address: before.address, reference: before.reference, notes: before.notes, is_active: before.is_active },
          newValue: updates,
        });
      });

      return json({ account: await getAccount(user, Number(before.id), null) });
    }

    // DELETE /:id — only possible when there are no transactions at all.
    if (method === 'DELETE' && sub === '/') {
      if (!hasPermission(user, C.pageKey, 'edit')) {
        throw forbidden(`You do not have "edit" permission on the ${C.pageKey} page`);
      }
      const before = await getAccount(user, id, null);
      const counts = await queryOne<{ debits: number; credits: number }>(
        `SELECT
           (SELECT COUNT(*) FROM ${C.debitTable}  WHERE ${C.fk} = $1)::int AS debits,
           (SELECT COUNT(*) FROM ${C.creditTable} WHERE ${C.fk} = $1)::int AS credits`,
        [before.id],
      );
      const debits = counts?.debits ?? 0;
      const credits = counts?.credits ?? 0;
      if (debits > 0 || credits > 0) {
        throw conflict(
          `${C.label} "${before.name}" has ${debits + credits} financial transaction(s) and cannot be deleted. ` +
          'Mark the record inactive instead — historical transactions remain accessible.',
        );
      }

      await withTransaction(async (tx) => {
        await tx.query(`DELETE FROM ${C.table} WHERE id = $1`, [before.id]);
        await logAudit({
          tx, actor: user, req,
          action: 'DELETE', entityType: C.entity, entityId: before.id,
          description: `Deleted unused ${C.label.toLowerCase()} ${before.code} — ${before.name}`,
          previousValue: { code: before.code, name: before.name },
        });
      });
      return json({ ok: true });
    }

    return null;
  };
}

export const handleCustomers = createAccountHandler(CONFIGS.customers);
export const handleSuppliers = createAccountHandler(CONFIGS.suppliers);
