/**
 * Financial flow pages — port of server/src/services/financialService.js plus
 * server/src/routes/flowRoutes.js. One engine shared by cash sales, POS sales,
 * credit sales, customer payments, supplier purchases, supplier payments and
 * depot expenses. Endpoint shapes and error messages are unchanged.
 */
import { HttpError, json } from '../../_shared/http.ts';
import { query, queryOne, withTransaction } from '../../_shared/db.ts';
import { assertDepotAccess, assertPermission, hasPermission, type UserContext } from '../../_shared/auth.ts';
import { diffFields, logAdjustments, logAudit } from '../../_shared/audit.ts';
import { optionalString, requireAmount, requireDate, requireString, serverStamps } from '../../_shared/stamps.ts';
import { notifyCustomerDebt, notifySupplierDebt } from '../../_shared/notify.ts';
import { badRequest, bodyOf, conflict, notFound, parsePagination, under, type Ctx, type ModuleHandler } from '../_ctx.ts';

const forbidden = (m: string) => new HttpError(403, m);

interface FlowConfig {
  pageKey: string;
  table: string;
  entity: string;
  label: string;
  extraFields: string[];
}

/**
 * Configuration for each "flow" transaction table. The routers for cash sales,
 * POS sales, credit sales, customer payments, supplier purchases, supplier
 * payments and depot expenses all run through this single engine.
 */
const FLOW_CONFIGS: Record<string, FlowConfig> = {
  cash_sales: {
    pageKey: 'cash_sales', table: 'cash_sales', entity: 'cash_sale', label: 'Cash sale',
    extraFields: [],
  },
  pos_sales: {
    pageKey: 'pos_sales', table: 'pos_sales', entity: 'pos_sale', label: 'POS sale',
    extraFields: [],
  },
  credit_sales: {
    pageKey: 'credit_sales', table: 'credit_sales', entity: 'credit_sale', label: 'Credit sale',
    extraFields: ['customer_id'],
  },
  customer_payments: {
    pageKey: 'customer_payments', table: 'customer_payments', entity: 'customer_payment', label: 'Customer payment',
    extraFields: ['customer_id', 'payment_method'],
  },
  supplier_purchases: {
    pageKey: 'supplier_purchases', table: 'supplier_purchases', entity: 'supplier_purchase', label: 'Supplier purchase',
    extraFields: ['supplier_id', 'purchase_type'],
  },
  supplier_payments: {
    pageKey: 'supplier_payments', table: 'supplier_payments', entity: 'supplier_payment', label: 'Supplier payment',
    extraFields: ['supplier_id', 'payment_method'],
  },
  depot_expenses: {
    pageKey: 'depot_expenses', table: 'depot_expenses', entity: 'depot_expense', label: 'Expense',
    extraFields: ['category_id', 'description', 'payment_method'],
  },
};

/** Mount path -> config key, in the order the Express app mounted its routers. */
const FLOW_MOUNTS: [string, string][] = [
  ['/cash-sales', 'cash_sales'],
  ['/pos-sales', 'pos_sales'],
  ['/credit-sales', 'credit_sales'],
  ['/customer-payments', 'customer_payments'],
  ['/supplier-purchases', 'supplier_purchases'],
  ['/supplier-payments', 'supplier_payments'],
  ['/depot-expenses', 'depot_expenses'],
];

const PAYMENT_METHODS = ['Cash', 'POS', 'Bank Transfer', 'Cheque', 'Bank Deposit'];

type Runner = { query<T>(sql: string, params?: unknown[]): Promise<T[]>; queryOne<T>(sql: string, params?: unknown[]): Promise<T | null> };

function joinsFor(config: FlowConfig): string {
  const parts: string[] = [];
  if (config.extraFields.includes('customer_id')) {
    parts.push('LEFT JOIN customers c ON c.id = t.customer_id');
  }
  if (config.extraFields.includes('supplier_id')) {
    parts.push('LEFT JOIN suppliers sp ON sp.id = t.supplier_id');
  }
  if (config.extraFields.includes('category_id')) {
    parts.push('LEFT JOIN expense_categories ec ON ec.id = t.category_id');
  }
  return parts.join('\n');
}

function selectExtras(config: FlowConfig): string[] {
  const cols: string[] = [];
  if (config.extraFields.includes('customer_id')) {
    cols.push('t.customer_id', 'c.name AS customer_name', 'c.code AS customer_code');
  }
  if (config.extraFields.includes('supplier_id')) {
    cols.push('t.supplier_id', 'sp.name AS supplier_name', 'sp.code AS supplier_code');
  }
  if (config.extraFields.includes('category_id')) {
    cols.push('t.category_id', 'ec.name AS category_name', 't.description');
  }
  if (config.extraFields.includes('payment_method')) cols.push('t.payment_method');
  if (config.extraFields.includes('purchase_type')) cols.push('t.purchase_type');
  return cols;
}

const BASE_SELECT = (config: FlowConfig) => `
  SELECT t.id, t.depot_id, d.code AS depot_code, d.name AS depot_name,
         t.transaction_date, t.amount,
         t.reference, t.notes, t.status,
         t.entry_date, t.entry_time,
         t.entered_by, t.entered_by_name, t.entered_by_role,
         t.created_at, t.updated_at,
         t.reversal_id, tr.reason AS reversal_reason,
         tr.performed_by_name AS reversed_by_name, tr.created_at AS reversed_at,
         ${selectExtras(config).length ? `${selectExtras(config).join(', ')},` : ''}
         t.reversal_id IS NOT NULL AS is_reversed
    FROM ${config.table} t
    JOIN depots d ON d.id = t.depot_id
    ${joinsFor(config)}
    LEFT JOIN transaction_reversals tr ON tr.id = t.reversal_id
`;

/** Builds shared WHERE clauses honouring depot access + universal filters. */
function buildFilters(config: FlowConfig, user: UserContext, q: URLSearchParams): { whereSql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];

  if (q.get('depotId')) {
    const depotId = assertDepotAccess(user, q.get('depotId'));
    params.push(depotId);
    where.push(`t.depot_id = $${params.length}`);
  } else if (!user.isSuperAdmin && !user.allDepots) {
    const ids = user.depots.map((d) => d.id);
    if (ids.length === 0) where.push('1 = 0');
    else {
      params.push(ids);
      where.push(`t.depot_id = ANY($${params.length}::int[])`);
    }
  }

  const from = q.get('from');
  const to = q.get('to');
  const entryFrom = q.get('entryFrom');
  const entryTo = q.get('entryTo');
  const enteredBy = q.get('enteredBy');
  const status = q.get('status');
  const customerId = q.get('customerId');
  const supplierId = q.get('supplierId');
  const categoryId = q.get('categoryId');
  const paymentMethod = q.get('paymentMethod');
  const search = q.get('search');

  if (from) {
    params.push(requireDate(from, 'from'));
    where.push(`t.transaction_date >= $${params.length}`);
  }
  if (to) {
    params.push(requireDate(to, 'to'));
    where.push(`t.transaction_date <= $${params.length}`);
  }
  if (entryFrom) {
    params.push(requireDate(entryFrom, 'entryFrom'));
    where.push(`t.entry_date >= $${params.length}`);
  }
  if (entryTo) {
    params.push(requireDate(entryTo, 'entryTo'));
    where.push(`t.entry_date <= $${params.length}`);
  }
  if (enteredBy) {
    params.push(Number(enteredBy));
    where.push(`t.entered_by = $${params.length}`);
  }
  if (status && status !== 'all') {
    if (!['posted', 'reversed'].includes(status)) throw badRequest('status must be posted, reversed or all');
    params.push(status);
    where.push(`t.status = $${params.length}`);
  }
  if (customerId && config.extraFields.includes('customer_id')) {
    params.push(Number(customerId));
    where.push(`t.customer_id = $${params.length}`);
  }
  if (supplierId && config.extraFields.includes('supplier_id')) {
    params.push(Number(supplierId));
    where.push(`t.supplier_id = $${params.length}`);
  }
  if (categoryId && config.extraFields.includes('category_id')) {
    params.push(Number(categoryId));
    where.push(`t.category_id = $${params.length}`);
  }
  if (paymentMethod && config.extraFields.includes('payment_method')) {
    params.push(String(paymentMethod));
    where.push(`t.payment_method = $${params.length}`);
  }
  if (search) {
    params.push(`%${String(search).trim()}%`);
    const i = params.length;
    const searches = [`t.reference ILIKE $${i}`, `t.notes ILIKE $${i}`, `t.entered_by_name ILIKE $${i}`];
    if (config.extraFields.includes('customer_id')) searches.push(`c.name ILIKE $${i}`, `c.code ILIKE $${i}`);
    if (config.extraFields.includes('supplier_id')) searches.push(`sp.name ILIKE $${i}`, `sp.code ILIKE $${i}`);
    if (config.extraFields.includes('description')) searches.push(`t.description ILIKE $${i}`);
    where.push(`(${searches.join(' OR ')})`);
  }

  return { whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

async function listFlow(config: FlowConfig, user: UserContext, q: URLSearchParams) {
  const { whereSql, params } = buildFilters(config, user, q);
  const { page, pageSize, offset } = parsePagination(q, 50, 500);

  const total = await queryOne<{ total: number; posted_total: string }>(
    `SELECT COUNT(*)::int AS total,
            COALESCE(SUM(t.amount) FILTER (WHERE t.status = 'posted'), 0) AS posted_total
       FROM ${config.table} t
       ${joinsFor(config)}
       ${whereSql}`,
    params,
  );

  const items = await query(
    `${BASE_SELECT(config)}
     ${whereSql}
     ORDER BY t.transaction_date DESC, t.created_at DESC, t.id DESC
     LIMIT ${pageSize} OFFSET ${offset}`,
    params,
  );

  return {
    items,
    total: total?.total ?? 0,
    postedTotal: total?.posted_total ?? 0,
    page,
    pageSize,
  };
}

async function getFlowById(config: FlowConfig, user: UserContext, id: number): Promise<Record<string, any>> {
  const params: unknown[] = [Number(id)];
  let accessSql = '';
  if (!user.isSuperAdmin && !user.allDepots) {
    params.push(user.depots.map((d) => d.id));
    accessSql = `AND t.depot_id = ANY($2::int[])`;
  }
  const row = await queryOne<Record<string, any>>(`${BASE_SELECT(config)} WHERE t.id = $1 ${accessSql}`, params);
  if (!row) throw notFound(`${config.label} not found`);
  return row;
}

async function assertDepotOpen(run: Runner, depotId: number, transactionDate: string): Promise<void> {
  // ::text keeps the column a plain 'YYYY-MM-DD' string for safe comparisons
  // (postgres.js would otherwise hand back a Date object).
  const row = await run.queryOne<{ opening_balance_date: string | null }>(
    'SELECT opening_balance_date::text AS opening_balance_date FROM depot_settings WHERE depot_id = $1',
    [depotId],
  );
  if (!row) throw badRequest('Depot is not configured (missing depot settings)');
  const opening = row.opening_balance_date;
  if (opening && transactionDate < opening) {
    throw badRequest(
      `Transaction date is before this depot's opening balance date (${opening}). ` +
      'Adjust the depot opening date in System Settings first.',
    );
  }
}

async function resolveCustomer(run: Runner, customerId: number, depotId: number): Promise<void> {
  const c = await run.queryOne<{ id: number; name: string; depot_id: number; is_active: boolean }>(
    'SELECT id, name, depot_id, is_active FROM customers WHERE id = $1', [customerId],
  );
  if (!c) throw badRequest('Customer does not exist');
  if (c.depot_id !== depotId) throw badRequest(`Customer "${c.name}" belongs to another depot`);
  if (!c.is_active) throw badRequest(`Customer "${c.name}" is inactive`);
}

async function resolveSupplier(run: Runner, supplierId: number, depotId: number): Promise<void> {
  const s = await run.queryOne<{ id: number; name: string; depot_id: number; is_active: boolean }>(
    'SELECT id, name, depot_id, is_active FROM suppliers WHERE id = $1', [supplierId],
  );
  if (!s) throw badRequest('Supplier does not exist');
  if (s.depot_id !== depotId) throw badRequest(`Supplier "${s.name}" belongs to another depot`);
  if (!s.is_active) throw badRequest(`Supplier "${s.name}" is inactive`);
}

/** Validates the request body and returns the column values for INSERT/UPDATE. */
async function buildValues(
  config: FlowConfig,
  run: Runner,
  body: Record<string, any>,
  opts: { depotId: number },
): Promise<Record<string, any>> {
  const depotId = opts.depotId;
  const values: Record<string, any> = {};

  values.transaction_date = requireDate(body.transactionDate, 'transactionDate');
  values.amount = requireAmount(body.amount, 'amount');
  values.reference = optionalString(body.reference, 120);
  values.notes = optionalString(body.notes, 2000);

  if (config.extraFields.includes('customer_id')) {
    const customerId = Number(body.customerId);
    if (!Number.isInteger(customerId) || customerId <= 0) {
      throw badRequest('customerId is required — every credit sale and payment must be linked to a customer');
    }
    await resolveCustomer(run, customerId, depotId);
    values.customer_id = customerId;
  }
  if (config.extraFields.includes('supplier_id')) {
    const supplierId = Number(body.supplierId);
    if (!Number.isInteger(supplierId) || supplierId <= 0) {
      throw badRequest('supplierId is required — every supplier purchase and payment must be linked to a supplier');
    }
    await resolveSupplier(run, supplierId, depotId);
    values.supplier_id = supplierId;
  }
  if (config.extraFields.includes('category_id')) {
    if (body.categoryId !== undefined && body.categoryId !== null && body.categoryId !== '') {
      const categoryId = Number(body.categoryId);
      const cat = await run.queryOne<{ id: number; is_active: boolean }>(
        'SELECT id, is_active FROM expense_categories WHERE id = $1', [categoryId],
      );
      if (!cat) throw badRequest('Expense category does not exist');
      if (!cat.is_active) throw badRequest('Expense category is inactive');
      values.category_id = categoryId;
    } else {
      values.category_id = null;
    }
  }
  if (config.extraFields.includes('description')) {
    values.description = requireString(body.description, 'description', 300);
  }
  if (config.extraFields.includes('payment_method')) {
    const method = body.paymentMethod ?? 'Cash';
    if (!PAYMENT_METHODS.includes(method)) {
      throw badRequest(`paymentMethod must be one of: ${PAYMENT_METHODS.join(', ')}`);
    }
    values.payment_method = method;
  }
  if (config.extraFields.includes('purchase_type')) {
    const type = body.purchaseType ?? 'credit';
    if (!['credit', 'cash'].includes(type)) throw badRequest('purchaseType must be credit or cash');
    values.purchase_type = type;
  }

  await assertDepotOpen(run, depotId, values.transaction_date);
  return values;
}

async function createFlow(config: FlowConfig, user: UserContext, body: Record<string, any>, req: Request) {
  if (!hasPermission(user, config.pageKey, 'input')) {
    throw forbidden(`You do not have "input" permission on ${config.pageKey.replace(/_/g, ' ')}`);
  }
  const depotId = assertDepotAccess(user, body.depotId);
  const stamps = serverStamps();

  const created = await withTransaction(async (tx) => {
    const values = await buildValues(config, tx, body, { depotId });

    const insert: Record<string, unknown> = {
      company_id: 1,
      depot_id: depotId,
      transaction_date: values.transaction_date,
      amount: values.amount,
      reference: values.reference,
      notes: values.notes,
      entry_date: stamps.entryDate,
      entry_time: stamps.entryTime,
      entered_by: user.id,
      entered_by_name: user.fullName ?? user.username,
      entered_by_role: user.roleName,
    };
    for (const extra of config.extraFields) {
      insert[extra] = values[extra];
    }
    const cols = Object.keys(insert);
    const vals = cols.map((c) => insert[c]);
    const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ');
    const row = await tx.queryOne<{ id: number }>(
      `INSERT INTO ${config.table} (${cols.join(', ')}) VALUES (${placeholders}) RETURNING id`,
      vals,
    );
    const id = Number(row!.id);

    await logAudit({
      tx, actor: user, req,
      action: 'CREATE', entityType: config.entity, entityId: id,
      description: `Recorded ${config.label.toLowerCase()} of ${values.amount} for ${values.transaction_date}`,
      newValue: { depotId, ...values },
    });
    return id;
  });

  // Threshold notifications (best effort, after the entry is committed).
  try {
    if (config.entity === 'credit_sale' || config.entity === 'customer_payment') {
      await notifyCustomerDebt(Number(body.customerId));
    }
    if (config.entity === 'supplier_purchase' || config.entity === 'supplier_payment') {
      await notifySupplierDebt(Number(body.supplierId));
    }
  } catch (err) {
    console.error('[notify] failed', err);
  }

  return getFlowById(config, user, created);
}

const EDITABLE_COMMON = ['amount', 'transactionDate', 'reference', 'notes', 'paymentMethod', 'purchaseType', 'description', 'categoryId'];

async function updateFlow(
  config: FlowConfig, user: UserContext, id: number, body: Record<string, any>, req: Request,
) {
  if (!hasPermission(user, config.pageKey, 'edit')) {
    throw forbidden(`You do not have "edit" permission on ${config.pageKey.replace(/_/g, ' ')}`);
  }
  const reason = requireString(body.reason, 'reason', 500);

  const before = await getFlowById(config, user, id);
  if (before.status === 'reversed') throw conflict('This transaction has been reversed — it can no longer be edited');

  const editableKeys = EDITABLE_COMMON.filter((k) => {
    if (k === 'paymentMethod') return config.extraFields.includes('payment_method');
    if (k === 'purchaseType') return config.extraFields.includes('purchase_type');
    if (k === 'description') return config.extraFields.includes('description');
    if (k === 'categoryId') return config.extraFields.includes('category_id');
    return true;
  });
  if (!Object.keys(body).some((k) => editableKeys.includes(k))) {
    throw badRequest(`Nothing to update. Editable fields: ${editableKeys.join(', ')}`);
  }

  await withTransaction(async (tx) => {
    const values: Record<string, unknown> = {};
    if (body.transactionDate !== undefined) values.transaction_date = requireDate(body.transactionDate, 'transactionDate');
    if (body.amount !== undefined) values.amount = requireAmount(body.amount, 'amount');
    if (body.reference !== undefined) values.reference = optionalString(body.reference, 120);
    if (body.notes !== undefined) values.notes = optionalString(body.notes, 2000);
    if (body.categoryId !== undefined && config.extraFields.includes('category_id')) {
      if (body.categoryId === null) values.category_id = null;
      else {
        const cat = await tx.queryOne<{ id: number }>(
          'SELECT id FROM expense_categories WHERE id = $1', [Number(body.categoryId)],
        );
        if (!cat) throw badRequest('Expense category does not exist');
        values.category_id = Number(body.categoryId);
      }
    }
    if (body.description !== undefined && config.extraFields.includes('description')) {
      values.description = requireString(body.description, 'description', 300);
    }
    if (body.paymentMethod !== undefined && config.extraFields.includes('payment_method')) {
      if (!PAYMENT_METHODS.includes(body.paymentMethod)) throw badRequest('Invalid payment method');
      values.payment_method = body.paymentMethod;
    }
    if (body.purchaseType !== undefined && config.extraFields.includes('purchase_type')) {
      if (!['credit', 'cash'].includes(body.purchaseType)) throw badRequest('purchaseType must be credit or cash');
      values.purchase_type = body.purchaseType;
    }

    if (values.transaction_date) await assertDepotOpen(tx, Number(before.depot_id), String(values.transaction_date));

    const cols = Object.keys(values);
    if (cols.length > 0) {
      const setSql = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
      await tx.query(
        `UPDATE ${config.table} SET ${setSql}, updated_at = now() WHERE id = $1`,
        [before.id, ...cols.map((c) => values[c])],
      );
    }

    // Original values remain visible: field-level old -> new history.
    const beforeRow: Record<string, unknown> = {
      transaction_date: before.transaction_date,
      amount: before.amount,
      reference: before.reference,
      notes: before.notes,
      payment_method: before.payment_method,
      purchase_type: before.purchase_type,
      description: before.description,
    };
    const changes = diffFields(beforeRow, { ...beforeRow, ...values }, Object.keys(values));
    await logAdjustments({
      tx, actor: user, entityType: config.entity, entityId: before.id,
      changes, reason,
    });
    await logAudit({
      tx, actor: user, req,
      action: 'CORRECTION', entityType: config.entity, entityId: before.id,
      description: `Corrected ${config.label.toLowerCase()} #${before.id}: ${reason}`,
      previousValue: beforeRow, newValue: values,
    });
  });

  try {
    if (config.extraFields.includes('customer_id')) await notifyCustomerDebt(Number(before.customer_id));
    if (config.extraFields.includes('supplier_id')) await notifySupplierDebt(Number(before.supplier_id));
  } catch (err) {
    console.error('[notify] failed', err);
  }

  return getFlowById(config, user, id);
}

async function reverseFlow(
  config: FlowConfig, user: UserContext, id: number, body: Record<string, any>, req: Request,
) {
  if (!hasPermission(user, config.pageKey, 'edit')) {
    throw forbidden(`You do not have "edit" permission on ${config.pageKey.replace(/_/g, ' ')}`);
  }
  const reason = requireString(body?.reason, 'reason', 500);
  const before = await getFlowById(config, user, id);
  if (before.status === 'reversed') throw conflict('This transaction has already been reversed');

  await withTransaction(async (tx) => {
    const rev = await tx.queryOne<{ id: number }>(
      `INSERT INTO transaction_reversals
         (transaction_type, transaction_id, action, amount, depot_id, reason, performed_by, performed_by_name)
       VALUES ($1, $2, 'reversal', $3, $4, $5, $6, $7) RETURNING id`,
      [config.entity, before.id, before.amount, before.depot_id, reason, user.id, user.fullName ?? user.username],
    );
    await tx.query(
      `UPDATE ${config.table} SET status = 'reversed', reversal_id = $2, updated_at = now() WHERE id = $1`,
      [before.id, rev!.id],
    );
    await logAudit({
      tx, actor: user, req,
      action: 'REVERSAL', entityType: config.entity, entityId: before.id,
      description: `Reversed ${config.label.toLowerCase()} #${before.id} (${before.amount}): ${reason}`,
      previousValue: { status: 'posted', amount: before.amount },
      newValue: { status: 'reversed', reason, reversalId: rev!.id },
    });
  });

  try {
    if (config.extraFields.includes('customer_id')) await notifyCustomerDebt(Number(before.customer_id));
    if (config.extraFields.includes('supplier_id')) await notifySupplierDebt(Number(before.supplier_id));
  } catch (err) {
    console.error('[notify] failed', err);
  }

  return getFlowById(config, user, id);
}

/**
 * One handler for all seven flow pages (mirrors createFlowRouter per mount).
 * Write operations re-check permissions inside the engine so the rules live
 * in one place.
 */
export const handleFlows: ModuleHandler = async (c: Ctx): Promise<Response | null> => {
  for (const [prefix, configKey] of FLOW_MOUNTS) {
    const rest = under(c.path, prefix);
    if (rest === null) continue;
    const config = FLOW_CONFIGS[configKey];
    const { method, req, url, user } = c;

    // GET / — filtered, paginated list with posted totals
    if (method === 'GET' && rest === '/') {
      assertPermission(user, config.pageKey, 'view');
      return json(await listFlow(config, user, url.searchParams));
    }

    // POST / — record a transaction (needs "input")
    if (method === 'POST' && rest === '/') {
      const item = await createFlow(config, user, await bodyOf(req), req);
      return json({ item }, 201);
    }

    // POST /:id/reverse — never deletes; the original stays in the audit trail
    const reverseMatch = /^\/(\d+)\/reverse$/.exec(rest);
    if (method === 'POST' && reverseMatch) {
      const item = await reverseFlow(config, user, Number(reverseMatch[1]), await bodyOf(req), req);
      return json({ item });
    }

    // GET /:id
    const idMatch = /^\/(\d+)$/.exec(rest);
    if (idMatch) {
      const id = Number(idMatch[1]);
      if (method === 'GET') {
        assertPermission(user, config.pageKey, 'view');
        return json({ item: await getFlowById(config, user, id) });
      }
      // PUT /:id — correction in place, reason required, history preserved
      if (method === 'PUT') {
        const item = await updateFlow(config, user, id, await bodyOf(req), req);
        return json({ item });
      }
    }

    return null;
  }
  return null;
};
