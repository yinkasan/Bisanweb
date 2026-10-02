/**
 * /stock-value — port of server/src/routes/stockValue.routes.js. Special
 * flow: one record per depot per day; corrections keep full history.
 */
import { HttpError, json } from '../../_shared/http.ts';
import { query, queryOne, withTransaction } from '../../_shared/db.ts';
import { assertDepotAccess, assertPermission, hasPermission, type UserContext } from '../../_shared/auth.ts';
import { logAdjustments, logAudit } from '../../_shared/audit.ts';
import { optionalString, requireAmount, requireDate, requireString, serverStamps } from '../../_shared/stamps.ts';
import { badRequest, bodyOf, conflict, notFound, parsePagination, under, type Ctx, type ModuleHandler } from '../_ctx.ts';

const forbidden = (m: string) => new HttpError(403, m);

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

function buildWhere(user: UserContext, q: URLSearchParams): { whereSql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.get('depotId')) {
    params.push(assertDepotAccess(user, q.get('depotId')));
    where.push(`s.depot_id = $${params.length}`);
  } else if (!user.isSuperAdmin && !user.allDepots) {
    const ids = user.depots.map((d) => d.id);
    if (ids.length === 0) where.push('1 = 0');
    else {
      params.push(ids);
      where.push(`s.depot_id = ANY($${params.length}::int[])`);
    }
  }
  const from = q.get('from');
  const to = q.get('to');
  const enteredBy = q.get('enteredBy');
  const status = q.get('status');
  const search = q.get('search');
  if (from) { params.push(requireDate(from, 'from')); where.push(`s.transaction_date >= $${params.length}`); }
  if (to) { params.push(requireDate(to, 'to')); where.push(`s.transaction_date <= $${params.length}`); }
  if (enteredBy) { params.push(Number(enteredBy)); where.push(`s.entered_by = $${params.length}`); }
  if (status && status !== 'all') {
    if (!['posted', 'reversed'].includes(status)) throw badRequest('status must be posted, reversed or all');
    params.push(status); where.push(`s.status = $${params.length}`);
  }
  if (search) {
    params.push(`%${String(search).trim()}%`);
    where.push(`(s.reference ILIKE $${params.length} OR s.notes ILIKE $${params.length} OR s.entered_by_name ILIKE $${params.length})`);
  }
  return { whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

async function getById(user: UserContext, id: number): Promise<Record<string, any>> {
  const params: unknown[] = [id];
  let accessSql = '';
  if (!user.isSuperAdmin && !user.allDepots) {
    params.push(user.depots.map((d) => d.id));
    accessSql = `AND s.depot_id = ANY($2::int[])`;
  }
  const row = await queryOne<Record<string, any>>(`${SELECT_SQL} WHERE s.id = $1 ${accessSql}`, params);
  if (!row) throw notFound('Stock value record not found');
  return row;
}

export const handleStockValue: ModuleHandler = async (c: Ctx): Promise<Response | null> => {
  const rest = under(c.path, '/stock-value');
  if (!rest) return null;
  const { method, req, url, user } = c;

  // GET /stock-value
  if (method === 'GET' && rest === '/') {
    assertPermission(user, PAGE, 'view');
    const q = url.searchParams;
    const { whereSql, params } = buildWhere(user, q);
    const { page, pageSize, offset } = parsePagination(q, 50, 500);

    const totals = await queryOne<{ n: number; latest_value: string | null }>(
      `SELECT COUNT(*)::int AS n,
              MAX(s.stock_value) FILTER (WHERE s.status = 'posted') AS latest_value
         FROM stock_value_records s ${whereSql}`,
      params,
    );
    const items = await query(
      `${SELECT_SQL} ${whereSql}
        ORDER BY s.transaction_date DESC, s.created_at DESC
        LIMIT ${pageSize} OFFSET ${offset}`,
      params,
    );
    return json({
      items,
      total: totals?.n ?? 0,
      latestValue: totals?.latest_value ?? null,
      page,
      pageSize,
    });
  }

  // GET /stock-value/:id/history — full correction history
  const historyMatch = /^\/(\d+)\/history$/.exec(rest);
  if (method === 'GET' && historyMatch) {
    assertPermission(user, PAGE, 'view_history');
    const record = await getById(user, Number(historyMatch[1]));
    const rows = await query(
      `SELECT id, action, original_value, new_value, reason,
              changed_by, changed_by_name, changed_at
         FROM stock_value_history
        WHERE stock_value_record_id = $1
        ORDER BY changed_at ASC, id ASC`,
      [record.id],
    );
    return json({ record, history: rows });
  }

  // POST /stock-value — record the stock value for a day
  if (method === 'POST' && rest === '/') {
    if (!hasPermission(user, PAGE, 'input')) {
      throw forbidden('You do not have "input" permission on the Stock Balance page');
    }
    const body = await bodyOf(req);
    const depotId = assertDepotAccess(user, body.depotId);
    const transactionDate = requireDate(body.transactionDate, 'transactionDate');
    const stockValue = requireAmount(body.stockValue, 'stockValue', true);
    const reference = optionalString(body.reference, 120);
    const notes = optionalString(body.notes, 2000);
    const stamps = serverStamps();

    const id = await withTransaction(async (tx) => {
      // ::text keeps the date a plain string (postgres.js Date would break the <).
      const settings = await tx.queryOne<{ opening_balance_date: string | null }>(
        'SELECT opening_balance_date::text AS opening_balance_date FROM depot_settings WHERE depot_id = $1',
        [depotId],
      );
      if (!settings) throw badRequest('Depot is not configured (missing depot settings)');
      if (settings.opening_balance_date && transactionDate < settings.opening_balance_date) {
        throw badRequest(`Transaction date is before this depot's opening balance date (${settings.opening_balance_date})`);
      }

      const existing = await tx.queryOne<{ id: number }>(
        `SELECT id FROM stock_value_records
          WHERE depot_id = $1 AND transaction_date = $2 AND status = 'posted'`,
        [depotId, transactionDate],
      );
      if (existing) {
        throw conflict(
          `A stock value for ${transactionDate} already exists for this depot. ` +
          'Open it and use "Correct" to change the value — the original stays in history.',
        );
      }

      const ins = await tx.queryOne<{ id: number }>(
        `INSERT INTO stock_value_records
           (company_id, depot_id, transaction_date, stock_value, reference, notes,
            entry_date, entry_time, entered_by, entered_by_name, entered_by_role)
         VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id`,
        [depotId, transactionDate, stockValue, reference, notes,
          stamps.entryDate, stamps.entryTime, user.id, user.fullName ?? user.username, user.roleName],
      );
      const recordId = Number(ins!.id);

      await tx.query(
        `INSERT INTO stock_value_history
           (stock_value_record_id, action, original_value, new_value, reason, changed_by, changed_by_name)
         VALUES ($1, 'creation', NULL, $2, 'Initial entry', $3, $4)`,
        [recordId, stockValue, user.id, user.fullName ?? user.username],
      );
      await logAudit({
        tx, actor: user, req,
        action: 'CREATE', entityType: 'stock_value', entityId: recordId,
        description: `Recorded stock value ${stockValue} for ${transactionDate}`,
        newValue: { depotId, transactionDate, stockValue, reference },
      });
      return recordId;
    });

    return json({ item: await getById(user, id) }, 201);
  }

  const idMatch = /^\/(\d+)(\/.*)?$/.exec(rest);
  if (!idMatch) return null;
  const id = Number(idMatch[1]);
  const sub = idMatch[2] ?? '/';

  // PUT /stock-value/:id — correction (SRS §6.4/§27: original retained)
  if (method === 'PUT' && sub === '/') {
    if (!hasPermission(user, PAGE, 'edit')) {
      throw forbidden('You do not have "edit" permission on the Stock Balance page');
    }
    const before = await getById(user, id);
    if (before.status === 'reversed') throw conflict('This stock value was reversed and can no longer be corrected');

    const body = await bodyOf(req);
    const newValue = requireAmount(body.stockValue, 'stockValue', true);
    const reason = requireString(body.reason, 'reason', 500);

    await withTransaction(async (tx) => {
      await tx.query(
        `UPDATE stock_value_records
            SET stock_value = $2,
                last_updated_by = $3, last_updated_by_name = $4, last_updated_at = now(),
                updated_at = now()
          WHERE id = $1`,
        [before.id, newValue, user.id, user.fullName ?? user.username],
      );
      await tx.query(
        `INSERT INTO stock_value_history
           (stock_value_record_id, action, original_value, new_value, reason, changed_by, changed_by_name)
         VALUES ($1, 'correction', $2, $3, $4, $5, $6)`,
        [before.id, before.stock_value, newValue, reason, user.id, user.fullName ?? user.username],
      );
      await logAdjustments({
        tx, actor: user, entityType: 'stock_value', entityId: before.id,
        changes: [{ field: 'stock_value', oldValue: before.stock_value, newValue }],
        reason,
      });
      await logAudit({
        tx, actor: user, req,
        action: 'CORRECTION', entityType: 'stock_value', entityId: before.id,
        description: `Corrected stock value from ${before.stock_value} to ${newValue}: ${reason}`,
        previousValue: { stock_value: before.stock_value },
        newValue: { stock_value: newValue, reason },
      });
    });

    return json({ item: await getById(user, Number(before.id)) });
  }

  // POST /stock-value/:id/reverse
  if (method === 'POST' && sub === '/reverse') {
    if (!hasPermission(user, PAGE, 'edit')) {
      throw forbidden('You do not have "edit" permission on the Stock Balance page');
    }
    const before = await getById(user, id);
    if (before.status === 'reversed') throw conflict('This stock value has already been reversed');
    const body = await bodyOf(req);
    const reason = requireString(body?.reason, 'reason', 500);

    await withTransaction(async (tx) => {
      const rev = await tx.queryOne<{ id: number }>(
        `INSERT INTO transaction_reversals
           (transaction_type, transaction_id, action, amount, depot_id, reason, performed_by, performed_by_name)
         VALUES ('stock_value', $1, 'reversal', $2, $3, $4, $5, $6) RETURNING id`,
        [before.id, before.stock_value, before.depot_id, reason, user.id, user.fullName ?? user.username],
      );
      await tx.query(
        `UPDATE stock_value_records SET status = 'reversed', reversal_id = $2, updated_at = now() WHERE id = $1`,
        [before.id, rev!.id],
      );
      await logAudit({
        tx, actor: user, req,
        action: 'REVERSAL', entityType: 'stock_value', entityId: before.id,
        description: `Reversed stock value #${before.id} (${before.stock_value}): ${reason}`,
        previousValue: { status: 'posted', stock_value: before.stock_value },
        newValue: { status: 'reversed', reason },
      });
    });

    return json({ item: await getById(user, Number(before.id)) });
  }

  return null;
};
