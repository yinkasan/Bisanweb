/**
 * mobile-api — Supabase Edge Function
 *
 * A mobile-optimised REST API for the Depot Manager Flutter app (and any
 * other client). It talks straight to the same Postgres database as the
 * Express API and returns the same payload shapes for the shared subset, so
 * the Flutter app can point at either backend:
 *
 *   POST /auth/login                 -> { user, token }
 *   GET  /auth/me                    -> { user }
 *   GET  /depots                     -> { depots }        (accessible only)
 *   GET  /dashboard/depot            -> { depot, metrics, daily, cash_at_bank, range }
 *   GET  /cash-sales                 -> { items, total, postedTotal, page, pageSize }
 *   POST /cash-sales                 -> 201 { item }
 *   GET  /credit-sales               -> { items, total, postedTotal, page, pageSize }
 *   POST /credit-sales               -> 201 { item }
 *   GET  /customers                  -> { items, total, totalBalance, page, pageSize }
 *   GET  /customers/:id/ledger       -> { account, ledger, asOf }
 *   GET  /notifications              -> { notifications, unread }
 *
 * Auth: Authorization: Bearer <JWT> — the same HS256 token the Express API
 * issues (shared JWT_SECRET), so web and mobile sessions are interchangeable.
 */
import bcrypt from 'npm:bcryptjs@2.4.3';
import { fail, handleOptions, HttpError, json, routePath } from '../_shared/http.ts';
import { query, queryOne } from '../_shared/db.ts';
import {
  assertDepotAccess,
  assertPermission,
  loadUserContext,
  requireUser,
  signToken,
  type UserContext,
} from '../_shared/auth.ts';
import { logAudit } from '../_shared/audit.ts';
import { notifyCustomerDebt } from '../_shared/notify.ts';
import { cashAtBank, depotMetrics, money } from '../_shared/metrics.ts';
import {
  optionalDate,
  optionalString,
  requireAmount,
  requireDate,
  resolveRange,
  serverStamps,
  todayIso,
} from '../_shared/stamps.ts';

const FUNCTION = 'mobile-api';

interface FlowConfig {
  table: string;
  pageKey: string;
  entity: string;
  label: string;
  customerLinked: boolean;
}

const CASH_SALES: FlowConfig = {
  table: 'cash_sales',
  pageKey: 'cash_sales',
  entity: 'cash_sale',
  label: 'Cash sale',
  customerLinked: false,
};

const CREDIT_SALES: FlowConfig = {
  table: 'credit_sales',
  pageKey: 'credit_sales',
  entity: 'credit_sale',
  label: 'Credit sale',
  customerLinked: true,
};

function selectSql(cfg: FlowConfig): string {
  const extras = cfg.customerLinked
    ? ', t.customer_id, c.name AS customer_name, c.code AS customer_code'
    : '';
  const join = cfg.customerLinked ? 'LEFT JOIN customers c ON c.id = t.customer_id' : '';
  return `SELECT t.id, t.depot_id, d.code AS depot_code, d.name AS depot_name,
                 t.transaction_date, t.amount, t.reference, t.notes, t.status,
                 t.entry_date, t.entry_time, t.entered_by_name${extras}
            FROM ${cfg.table} t
            JOIN depots d ON d.id = t.depot_id
            ${join}`;
}

/** Shared WHERE builder honouring depot access + date filters (SRS §4.2). */
function accessFilters(
  user: UserContext,
  url: URL,
  alias = 't',
): { whereSql: string; params: unknown[] } {
  const params: unknown[] = [];
  const where: string[] = [];

  const depotParam = url.searchParams.get('depotId');
  if (depotParam) {
    const depotId = assertDepotAccess(user, depotParam);
    params.push(depotId);
    where.push(`${alias}.depot_id = $${params.length}`);
  } else if (!user.isSuperAdmin && !user.allDepots) {
    const ids = user.depots.map((d) => d.id);
    if (ids.length === 0) {
      where.push('1 = 0');
    } else {
      params.push(ids);
      where.push(`${alias}.depot_id = ANY($${params.length}::int[])`);
    }
  }

  const from = optionalDate(url.searchParams.get('from'), 'from');
  if (from) {
    params.push(from);
    where.push(`${alias}.transaction_date >= $${params.length}`);
  }
  const to = optionalDate(url.searchParams.get('to'), 'to');
  if (to) {
    params.push(to);
    where.push(`${alias}.transaction_date <= $${params.length}`);
  }

  return { whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

// ---------------------------------------------------------------- auth

async function login(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!username || !password) throw new HttpError(400, 'Username and password are required');

  const user = await queryOne<{
    id: number;
    full_name: string;
    password_hash: string;
    is_active: boolean;
  }>('SELECT id, full_name, password_hash, is_active FROM users WHERE username = $1', [username]);

  const passwordOk = user ? await bcrypt.compare(password, user.password_hash) : false;
  if (!user || !passwordOk) {
    await logAudit({
      actor: user ? { id: user.id, fullName: user.full_name, roleName: null } : null,
      req,
      action: 'LOGIN_FAILED',
      entityType: 'user',
      entityId: user?.id ?? null,
      description: `Failed sign-in attempt for "${username}"`,
    });
    throw new HttpError(401, 'Invalid username or password');
  }
  if (!user.is_active) {
    await logAudit({
      actor: { id: user.id, fullName: user.full_name, roleName: null },
      req,
      action: 'LOGIN_BLOCKED',
      entityType: 'user',
      entityId: user.id,
      description: 'Sign-in blocked: account deactivated',
    });
    throw new HttpError(401, 'This account has been deactivated. Contact the Super Admin.');
  }

  const context = await loadUserContext(user.id);
  const token = await signToken(user.id);
  await query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
  await logAudit({
    actor: context,
    req,
    action: 'LOGIN',
    entityType: 'user',
    entityId: user.id,
    description: `${context.fullName} signed in`,
  });
  return json({ user: context, token });
}

// ------------------------------------------------------------ dashboard

async function depotDashboard(req: Request, url: URL): Promise<Response> {
  const user = await requireUser(req);
  assertPermission(user, 'dashboard_depot', 'view');
  const depotId = assertDepotAccess(user, url.searchParams.get('depotId'));
  const { from, to } = resolveRange(url.searchParams);

  const [depot, metrics, daily, bank] = await Promise.all([
    queryOne('SELECT id, code, name, location FROM depots WHERE id = $1', [depotId]),
    depotMetrics(depotId, from, to),
    query(
      `SELECT transaction_date, cash_sales, pos_sales, credit_sales, total_sales,
              supplier_purchases, expenses, operating_balance
         FROM depot_daily_balances
        WHERE depot_id = $1 AND transaction_date BETWEEN $2 AND $3
        ORDER BY transaction_date`,
      [depotId, from, to],
    ),
    cashAtBank(),
  ]);

  // Same envelope as the Express route: cash_at_bank rides inside metrics.
  return json({ depot, range: { from, to }, metrics: { ...metrics, cash_at_bank: bank }, daily });
}

// ---------------------------------------------------------------- flows

async function listSales(req: Request, url: URL, cfg: FlowConfig): Promise<Response> {
  const user = await requireUser(req);
  assertPermission(user, cfg.pageKey, 'view');
  const { whereSql, params } = accessFilters(user, url);

  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(url.searchParams.get('pageSize')) || 50));

  const totals = await queryOne<{ total: number; posted_total: string }>(
    `SELECT COUNT(*)::int AS total,
            COALESCE(SUM(t.amount) FILTER (WHERE t.status = 'posted'), 0) AS posted_total
       FROM ${cfg.table} t
       ${whereSql}`,
    params,
  );

  const items = await query(
    `${selectSql(cfg)}
     ${whereSql}
     ORDER BY t.transaction_date DESC, t.id DESC
     LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
    params,
  );

  return json({
    items,
    total: totals?.total ?? 0,
    postedTotal: totals?.posted_total ?? '0',
    page,
    pageSize,
  });
}

async function createSale(req: Request, cfg: FlowConfig): Promise<Response> {
  const user = await requireUser(req);
  assertPermission(user, cfg.pageKey, 'input');

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const depotId = assertDepotAccess(user, body.depotId);
  const transactionDate = requireDate(body.transactionDate, 'transactionDate');
  const amount = requireAmount(body.amount);
  const reference = optionalString(body.reference, 120);
  const notes = optionalString(body.notes, 2000);

  // Ordering guard: the depot must be configured and the date must not
  // precede its opening balance date (SRS §11).
  const settings = await queryOne<{ opening_balance_date: string | null }>(
    'SELECT opening_balance_date FROM depot_settings WHERE depot_id = $1',
    [depotId],
  );
  if (!settings) throw new HttpError(400, 'Depot is not configured (missing depot settings)');
  if (settings.opening_balance_date && transactionDate < settings.opening_balance_date) {
    throw new HttpError(
      400,
      `Transaction date is before this depot's opening balance date (${settings.opening_balance_date}).`,
    );
  }

  let customerId: number | null = null;
  if (cfg.customerLinked) {
    customerId = Number(body.customerId);
    if (!Number.isInteger(customerId) || customerId <= 0) {
      throw new HttpError(400, 'customerId is required — every credit sale must be linked to a customer');
    }
    const customer = await queryOne<{ id: number; name: string; depot_id: number; is_active: boolean }>(
      'SELECT id, name, depot_id, is_active FROM customers WHERE id = $1',
      [customerId],
    );
    if (!customer) throw new HttpError(400, 'Customer does not exist');
    if (customer.depot_id !== depotId) {
      throw new HttpError(400, `Customer "${customer.name}" belongs to another depot`);
    }
    if (!customer.is_active) throw new HttpError(400, `Customer "${customer.name}" is inactive`);
  }

  const stamps = serverStamps();
  const columns = [
    'company_id', 'depot_id', 'transaction_date', 'amount', 'reference', 'notes',
    'entry_date', 'entry_time', 'entered_by', 'entered_by_name', 'entered_by_role',
  ];
  const values: unknown[] = [
    1, depotId, transactionDate, amount, reference, notes,
    stamps.entryDate, stamps.entryTime, user.id, user.fullName ?? user.username, user.roleName,
  ];
  if (cfg.customerLinked) {
    columns.push('customer_id');
    values.push(customerId);
  }

  const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
  const inserted = await queryOne<{ id: number }>(
    `INSERT INTO ${cfg.table} (${columns.join(', ')}) VALUES (${placeholders}) RETURNING id`,
    values,
  );
  const id = Number(inserted?.id);

  await logAudit({
    actor: user,
    req,
    action: 'CREATE',
    entityType: cfg.entity,
    entityId: id,
    description: `Recorded ${cfg.label.toLowerCase()} of ${amount} for ${transactionDate}`,
    newValue: { depotId, transactionDate, amount, reference, notes, customerId },
  });

  // Threshold notifications, best effort after the row is committed.
  if (cfg.customerLinked && customerId) {
    try {
      await notifyCustomerDebt(customerId);
    } catch (err) {
      console.error('[notify] failed', err);
    }
  }

  const item = await queryOne(`${selectSql(cfg)} WHERE t.id = $1`, [id]);
  return json({ item }, 201);
}

// ------------------------------------------------------------ customers

const BALANCE_SQL = (alias: string) => `
  COALESCE((SELECT SUM(amount) FROM credit_sales     WHERE customer_id = ${alias}.id AND status = 'posted'), 0)
- COALESCE((SELECT SUM(amount) FROM customer_payments WHERE customer_id = ${alias}.id AND status = 'posted'), 0)`;

async function listCustomers(req: Request, url: URL): Promise<Response> {
  const user = await requireUser(req);
  assertPermission(user, 'customers', 'view');

  const { whereSql, params } = accessFilters(user, url, 'c');
  const search = url.searchParams.get('search');
  const withBalance = url.searchParams.get('withBalance') === 'true';
  const activeOnly = url.searchParams.get('isActive');
  const extra: string[] = [];
  if (!whereSql && !user.isSuperAdmin && !user.allDepots && user.depots.length === 0) {
    extra.push('1 = 0');
  }
  if (search) {
    params.push(`%${search.trim()}%`);
    extra.push(`(c.name ILIKE $${params.length} OR c.code ILIKE $${params.length} OR c.phone ILIKE $${params.length})`);
  }
  if (withBalance) extra.push(`${BALANCE_SQL('c')} <> 0`);
  if (activeOnly === 'true' || activeOnly === 'false') {
    params.push(activeOnly === 'true');
    extra.push(`c.is_active = $${params.length}`);
  }

  const combined = (() => {
    if (!whereSql && extra.length === 0) return '';
    if (!whereSql) return `WHERE ${extra.join(' AND ')}`;
    if (extra.length === 0) return whereSql;
    return `${whereSql} AND ${extra.join(' AND ')}`;
  })();

  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(url.searchParams.get('pageSize')) || 50));

  const totals = await queryOne<{ total: number; total_balance: string }>(
    `SELECT COUNT(*)::int AS total, COALESCE(SUM(balance), 0) AS total_balance
       FROM (SELECT ${BALANCE_SQL('c')} AS balance
               FROM customers c
               JOIN depots d ON d.id = c.depot_id
               ${combined}) t`,
    params,
  );

  const items = await query(
    `SELECT c.id, c.code, c.name, c.phone, c.is_active, c.depot_id, d.code AS depot_code,
            ${BALANCE_SQL('c')} AS balance
       FROM customers c
       JOIN depots d ON d.id = c.depot_id
       ${combined}
      ORDER BY c.name
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
    params,
  );

  return json({
    items,
    total: totals?.total ?? 0,
    totalBalance: money(totals?.total_balance),
    page,
    pageSize,
  });
}

async function customerLedger(req: Request, customerId: number, url: URL): Promise<Response> {
  const user = await requireUser(req);
  assertPermission(user, 'customers', 'view_history');

  const asOf = optionalDate(url.searchParams.get('to'), 'to') ?? todayIso();
  const account = await queryOne<{ id: number; depot_id: number }>(
    `SELECT c.id, c.code, c.name, c.phone, c.is_active, c.depot_id, d.code AS depot_code,
            COALESCE((SELECT SUM(amount) FROM credit_sales     WHERE customer_id = c.id AND status = 'posted' AND transaction_date <= $2), 0)
          - COALESCE((SELECT SUM(amount) FROM customer_payments WHERE customer_id = c.id AND status = 'posted' AND transaction_date <= $2), 0) AS balance
       FROM customers c JOIN depots d ON d.id = c.depot_id
      WHERE c.id = $1`,
    [customerId, asOf],
  );
  if (!account) throw new HttpError(404, 'Customer not found');
  assertDepotAccess(user, account.depot_id);

  // Same source view and column contract as the Express route.
  const ledger = await query(
    `SELECT source_id, entry_type, direction, amount, signed_amount, running_balance,
            transaction_date, entry_date, entry_time, reference, entered_by, entered_by_name
       FROM customer_account_ledger
      WHERE customer_id = $1 AND transaction_date <= $2
      ORDER BY transaction_date, created_at, source_id`,
    [customerId, asOf],
  );

  return json({ account, ledger, asOf });
}

// -------------------------------------------------------- notifications

async function listNotifications(req: Request): Promise<Response> {
  const user = await requireUser(req);
  assertPermission(user, 'notifications', 'view');

  const notifications = await query(
    `SELECT id, type, severity, title, message, entity_type, entity_id, is_read, created_at
       FROM notifications
      WHERE user_id = $1 OR user_id IS NULL
      ORDER BY created_at DESC
      LIMIT 200`,
    [user.id],
  );
  const unread = await queryOne<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM notifications
      WHERE (user_id = $1 OR user_id IS NULL) AND is_read = false`,
    [user.id],
  );
  return json({ notifications, unread: unread?.n ?? 0 });
}

// ---------------------------------------------------------------- router

Deno.serve(async (req: Request): Promise<Response> => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  const url = new URL(req.url);
  const path = routePath(url.pathname, FUNCTION);
  const method = req.method.toUpperCase();

  try {
    if (method === 'GET' && (path === '/' || path === '/health')) {
      return json({ ok: true, service: FUNCTION, time: new Date().toISOString() });
    }
    if (method === 'POST' && path === '/auth/login') return await login(req);
    if (method === 'GET' && path === '/auth/me') return json({ user: await requireUser(req) });
    if (method === 'GET' && path === '/depots') {
      const user = await requireUser(req);
      return json({ depots: user.depots });
    }
    if (method === 'GET' && path === '/dashboard/depot') return await depotDashboard(req, url);
    if (method === 'GET' && path === '/cash-sales') return await listSales(req, url, CASH_SALES);
    if (method === 'POST' && path === '/cash-sales') return await createSale(req, CASH_SALES);
    if (method === 'GET' && path === '/credit-sales') return await listSales(req, url, CREDIT_SALES);
    if (method === 'POST' && path === '/credit-sales') return await createSale(req, CREDIT_SALES);
    if (method === 'GET' && path === '/customers') return await listCustomers(req, url);
    const ledgerMatch = /^\/customers\/(\d+)\/ledger$/.exec(path);
    if (method === 'GET' && ledgerMatch) {
      return await customerLedger(req, Number(ledgerMatch[1]), url);
    }
    if (method === 'GET' && path === '/notifications') return await listNotifications(req);

    return fail(`No route for ${method} ${path}`, 404);
  } catch (err) {
    if (err instanceof HttpError) return fail(err.message, err.status);
    console.error(`[${FUNCTION}] unhandled error`, err);
    return fail('Unexpected server error', 500);
  }
});
