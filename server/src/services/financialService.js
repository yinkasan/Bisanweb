import { query, withTransaction } from '../db/pool.js';
import { badRequest, conflict, forbidden, notFound } from '../middleware/errors.js';
import { logAudit, logAdjustments } from '../middleware/audit.js';
import { assertDepotAccess, hasPermission } from '../services/accessService.js';
import { serverStamps, requireDate, requireAmount, optionalString, requireString } from '../utils/stamps.js';
import { notifyCustomerDebt, notifySupplierDebt } from '../services/notifyService.js';

/**
 * Configuration for each "flow" transaction table. The routers for cash sales,
 * POS sales, credit sales, customer payments, supplier purchases, supplier
 * payments and depot expenses all run through this single engine.
 */
export const FLOW_CONFIGS = {
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

const PAYMENT_METHODS = ['Cash', 'POS', 'Bank Transfer', 'Cheque', 'Bank Deposit'];

function joinsFor(config) {
  const parts = [];
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

function selectExtras(config) {
  const cols = [];
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

const BASE_SELECT = (config) => `
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
function buildFilters(config, user, q) {
  const where = [];
  const params = [];

  if (q.depotId) {
    const depotId = assertDepotAccess(user, q.depotId);
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

  if (q.from) {
    params.push(requireDate(q.from, 'from'));
    where.push(`t.transaction_date >= $${params.length}`);
  }
  if (q.to) {
    params.push(requireDate(q.to, 'to'));
    where.push(`t.transaction_date <= $${params.length}`);
  }
  if (q.entryFrom) {
    params.push(requireDate(q.entryFrom, 'entryFrom'));
    where.push(`t.entry_date >= $${params.length}`);
  }
  if (q.entryTo) {
    params.push(requireDate(q.entryTo, 'entryTo'));
    where.push(`t.entry_date <= $${params.length}`);
  }
  if (q.enteredBy) {
    params.push(Number(q.enteredBy));
    where.push(`t.entered_by = $${params.length}`);
  }
  if (q.status && q.status !== 'all') {
    if (!['posted', 'reversed'].includes(q.status)) throw badRequest('status must be posted, reversed or all');
    params.push(q.status);
    where.push(`t.status = $${params.length}`);
  }
  if (q.customerId && config.extraFields.includes('customer_id')) {
    params.push(Number(q.customerId));
    where.push(`t.customer_id = $${params.length}`);
  }
  if (q.supplierId && config.extraFields.includes('supplier_id')) {
    params.push(Number(q.supplierId));
    where.push(`t.supplier_id = $${params.length}`);
  }
  if (q.categoryId && config.extraFields.includes('category_id')) {
    params.push(Number(q.categoryId));
    where.push(`t.category_id = $${params.length}`);
  }
  if (q.paymentMethod && config.extraFields.includes('payment_method')) {
    params.push(String(q.paymentMethod));
    where.push(`t.payment_method = $${params.length}`);
  }
  if (q.search) {
    params.push(`%${String(q.search).trim()}%`);
    const i = params.length;
    const searches = [`t.reference ILIKE $${i}`, `t.notes ILIKE $${i}`, `t.entered_by_name ILIKE $${i}`];
    if (config.extraFields.includes('customer_id')) searches.push(`c.name ILIKE $${i}`, `c.code ILIKE $${i}`);
    if (config.extraFields.includes('supplier_id')) searches.push(`sp.name ILIKE $${i}`, `sp.code ILIKE $${i}`);
    if (config.extraFields.includes('description')) searches.push(`t.description ILIKE $${i}`);
    where.push(`(${searches.join(' OR ')})`);
  }

  return { whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

export async function listFlow(config, user, q) {
  const { whereSql, params } = buildFilters(config, user, q);

  const page = Math.max(1, Number(q.page) || 1);
  const pageSize = Math.min(500, Math.max(1, Number(q.pageSize) || 50));
  const offset = (page - 1) * pageSize;

  const totalRes = await query(
    `SELECT COUNT(*)::int AS total,
            COALESCE(SUM(t.amount) FILTER (WHERE t.status = 'posted'), 0) AS posted_total
       FROM ${config.table} t
       ${joinsFor(config)}
       ${whereSql}`,
    params
  );

  const listRes = await query(
    `${BASE_SELECT(config)}
     ${whereSql}
     ORDER BY t.transaction_date DESC, t.created_at DESC, t.id DESC
     LIMIT ${pageSize} OFFSET ${offset}`,
    params
  );

  return {
    items: listRes.rows,
    total: totalRes.rows[0].total,
    postedTotal: totalRes.rows[0].posted_total,
    page,
    pageSize,
  };
}

export async function getFlowById(config, user, id) {
  const params = [Number(id)];
  let accessSql = '';
  if (!user.isSuperAdmin && !user.allDepots) {
    params.push(user.depots.map((d) => d.id));
    accessSql = `AND t.depot_id = ANY($2::int[])`;
  }
  const res = await query(`${BASE_SELECT(config)} WHERE t.id = $1 ${accessSql}`, params);
  if (res.rowCount === 0) throw notFound(`${config.label} not found`);
  return res.rows[0];
}

async function assertDepotOpen(client, depotId, transactionDate) {
  const res = await client.query(
    'SELECT opening_balance_date FROM depot_settings WHERE depot_id = $1',
    [depotId]
  );
  if (res.rowCount === 0) throw badRequest('Depot is not configured (missing depot settings)');
  const opening = res.rows[0].opening_balance_date;
  if (opening && transactionDate < opening) {
    throw badRequest(
      `Transaction date is before this depot's opening balance date (${opening}). ` +
      'Adjust the depot opening date in System Settings first.'
    );
  }
}

async function resolveCustomer(client, customerId, depotId) {
  const res = await client.query('SELECT id, name, depot_id, is_active FROM customers WHERE id = $1', [customerId]);
  if (res.rowCount === 0) throw badRequest('Customer does not exist');
  const c = res.rows[0];
  if (c.depot_id !== depotId) throw badRequest(`Customer "${c.name}" belongs to another depot`);
  if (!c.is_active) throw badRequest(`Customer "${c.name}" is inactive`);
  return c;
}

async function resolveSupplier(client, supplierId, depotId) {
  const res = await client.query('SELECT id, name, depot_id, is_active FROM suppliers WHERE id = $1', [supplierId]);
  if (res.rowCount === 0) throw badRequest('Supplier does not exist');
  const s = res.rows[0];
  if (s.depot_id !== depotId) throw badRequest(`Supplier "${s.name}" belongs to another depot`);
  if (!s.is_active) throw badRequest(`Supplier "${s.name}" is inactive`);
  return s;
}

/** Validates the request body and returns the column values for INSERT/UPDATE. */
async function buildValues(config, client, user, body, { depotId }) {
  const values = {};

  values.transaction_date = requireDate(body.transactionDate, 'transactionDate');
  values.amount = requireAmount(body.amount, { fieldName: 'amount' });
  values.reference = optionalString(body.reference, { max: 120 });
  values.notes = optionalString(body.notes, { max: 2000 });

  if (config.extraFields.includes('customer_id')) {
    const customerId = Number(body.customerId);
    if (!Number.isInteger(customerId) || customerId <= 0) {
      throw badRequest('customerId is required — every credit sale and payment must be linked to a customer');
    }
    await resolveCustomer(client, customerId, depotId);
    values.customer_id = customerId;
  }
  if (config.extraFields.includes('supplier_id')) {
    const supplierId = Number(body.supplierId);
    if (!Number.isInteger(supplierId) || supplierId <= 0) {
      throw badRequest('supplierId is required — every supplier purchase and payment must be linked to a supplier');
    }
    await resolveSupplier(client, supplierId, depotId);
    values.supplier_id = supplierId;
  }
  if (config.extraFields.includes('category_id')) {
    if (body.categoryId !== undefined && body.categoryId !== null && body.categoryId !== '') {
      const categoryId = Number(body.categoryId);
      const cat = await client.query('SELECT id, is_active FROM expense_categories WHERE id = $1', [categoryId]);
      if (cat.rowCount === 0) throw badRequest('Expense category does not exist');
      if (!cat.rows[0].is_active) throw badRequest('Expense category is inactive');
      values.category_id = categoryId;
    } else {
      values.category_id = null;
    }
  }
  if (config.extraFields.includes('description')) {
    values.description = requireString(body.description, 'description', { max: 300 });
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

  await assertDepotOpen(client, depotId, values.transaction_date);
  return values;
}

export async function createFlow(config, user, body, req) {
  if (!hasPermission(user, config.pageKey, 'input')) {
    throw forbidden(`You do not have "input" permission on ${config.pageKey.replace(/_/g, ' ')}`);
  }
  const depotId = assertDepotAccess(user, body.depotId);
  const stamps = serverStamps();

  const created = await withTransaction(async (client) => {
    const values = await buildValues(config, client, user, body, { depotId });

    const insert = {
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
    const res = await client.query(
      `INSERT INTO ${config.table} (${cols.join(', ')}) VALUES (${placeholders}) RETURNING id`,
      vals
    );
    const id = res.rows[0].id;

    await logAudit({
      executor: client, actor: user, req,
      action: 'CREATE', entityType: config.entity, entityId: id,
      description: `Recorded ${config.label.toLowerCase()} of ${values.amount} for ${values.transaction_date}`,
      newValue: { depotId, ...values },
    });
    return id;
  });

  // Threshold notifications (best effort, after the entry is committed).
  try {
    if (config.entity === 'credit_sale' || config.entity === 'customer_payment') {
      await notifyCustomerDebt(body.customerId);
    }
    if (config.entity === 'supplier_purchase' || config.entity === 'supplier_payment') {
      await notifySupplierDebt(body.supplierId);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[notify] failed', err);
  }

  return getFlowById(config, user, created);
}

const EDITABLE_COMMON = ['amount', 'transactionDate', 'reference', 'notes', 'paymentMethod', 'purchaseType', 'description', 'categoryId'];

export async function updateFlow(config, user, id, body, req) {
  if (!hasPermission(user, config.pageKey, 'edit')) {
    throw forbidden(`You do not have "edit" permission on ${config.pageKey.replace(/_/g, ' ')}`);
  }
  const reason = requireString(body.reason, 'reason', { max: 500 });

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

  await withTransaction(async (client) => {
    const values = {};
    if (body.transactionDate !== undefined) values.transaction_date = requireDate(body.transactionDate, 'transactionDate');
    if (body.amount !== undefined) values.amount = requireAmount(body.amount, { fieldName: 'amount' });
    if (body.reference !== undefined) values.reference = optionalString(body.reference, { max: 120 });
    if (body.notes !== undefined) values.notes = optionalString(body.notes, { max: 2000 });
    if (body.categoryId !== undefined && config.extraFields.includes('category_id')) {
      if (body.categoryId === null) values.category_id = null;
      else {
        const cat = await client.query('SELECT id FROM expense_categories WHERE id = $1', [Number(body.categoryId)]);
        if (cat.rowCount === 0) throw badRequest('Expense category does not exist');
        values.category_id = Number(body.categoryId);
      }
    }
    if (body.description !== undefined && config.extraFields.includes('description')) {
      values.description = requireString(body.description, 'description', { max: 300 });
    }
    if (body.paymentMethod !== undefined && config.extraFields.includes('payment_method')) {
      if (!PAYMENT_METHODS.includes(body.paymentMethod)) throw badRequest('Invalid payment method');
      values.payment_method = body.paymentMethod;
    }
    if (body.purchaseType !== undefined && config.extraFields.includes('purchase_type')) {
      if (!['credit', 'cash'].includes(body.purchaseType)) throw badRequest('purchaseType must be credit or cash');
      values.purchase_type = body.purchaseType;
    }

    if (values.transaction_date) await assertDepotOpen(client, before.depot_id, values.transaction_date);

    const cols = Object.keys(values);
    if (cols.length > 0) {
      const setSql = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
      await client.query(
        `UPDATE ${config.table} SET ${setSql}, updated_at = now() WHERE id = $1`,
        [before.id, ...cols.map((c) => values[c])]
      );
    }

    // Original values remain visible: field-level old -> new history.
    const beforeRow = {
      transaction_date: before.transaction_date,
      amount: before.amount,
      reference: before.reference,
      notes: before.notes,
      payment_method: before.payment_method,
      purchase_type: before.purchase_type,
      description: before.description,
    };
    const changes = [];
    for (const [dbCol, newVal] of Object.entries(values)) {
      const oldVal = beforeRow[dbCol];
      if (String(oldVal ?? '') !== String(newVal ?? '')) {
        changes.push({ field: dbCol, oldValue: oldVal, newValue: newVal });
      }
    }
    await logAdjustments({
      executor: client, actor: user, entityType: config.entity, entityId: before.id,
      changes, reason,
    });
    await logAudit({
      executor: client, actor: user, req,
      action: 'CORRECTION', entityType: config.entity, entityId: before.id,
      description: `Corrected ${config.label.toLowerCase()} #${before.id}: ${reason}`,
      previousValue: beforeRow, newValue: values,
    });
  });

  try {
    if (config.extraFields.includes('customer_id')) await notifyCustomerDebt(before.customer_id);
    if (config.extraFields.includes('supplier_id')) await notifySupplierDebt(before.supplier_id);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[notify] failed', err);
  }

  return getFlowById(config, user, id);
}

export async function reverseFlow(config, user, id, body, req) {
  if (!hasPermission(user, config.pageKey, 'edit')) {
    throw forbidden(`You do not have "edit" permission on ${config.pageKey.replace(/_/g, ' ')}`);
  }
  const reason = requireString(body?.reason, 'reason', { max: 500 });
  const before = await getFlowById(config, user, id);
  if (before.status === 'reversed') throw conflict('This transaction has already been reversed');

  await withTransaction(async (client) => {
    const rev = await client.query(
      `INSERT INTO transaction_reversals
         (transaction_type, transaction_id, action, amount, depot_id, reason, performed_by, performed_by_name)
       VALUES ($1, $2, 'reversal', $3, $4, $5, $6, $7) RETURNING id`,
      [config.entity, before.id, before.amount, before.depot_id, reason, user.id, user.fullName ?? user.username]
    );
    await client.query(
      `UPDATE ${config.table} SET status = 'reversed', reversal_id = $2, updated_at = now() WHERE id = $1`,
      [before.id, rev.rows[0].id]
    );
    await logAudit({
      executor: client, actor: user, req,
      action: 'REVERSAL', entityType: config.entity, entityId: before.id,
      description: `Reversed ${config.label.toLowerCase()} #${before.id} (${before.amount}): ${reason}`,
      previousValue: { status: 'posted', amount: before.amount },
      newValue: { status: 'reversed', reason, reversalId: rev.rows[0].id },
    });
  });

  try {
    if (config.extraFields.includes('customer_id')) await notifyCustomerDebt(before.customer_id);
    if (config.extraFields.includes('supplier_id')) await notifySupplierDebt(before.supplier_id);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[notify] failed', err);
  }

  return getFlowById(config, user, id);
}
