import { Router } from 'express';
import { query } from '../db/pool.js';
import { asyncHandler, badRequest } from '../middleware/errors.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { assertDepotAccess, hasPermission } from '../services/accessService.js';
import { resolveRange, optionalDate } from '../utils/stamps.js';
import { logAudit } from '../middleware/audit.js';

const router = Router();
router.use(requireAuth);

const PAGE = 'reports';

/** Resolves the depot scope for a report: one depot, or every accessible depot. */
function depotScope(user, q) {
  if (q.depotId) return [assertDepotAccess(user, q.depotId)];
  return user.depots.map((d) => d.id);
}

async function ensureDepots(ids) {
  if (ids.length === 0) throw badRequest('No depots available for this report');
  return ids;
}

function asOf(q) {
  return optionalDate(q.to, 'to') ?? new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Report definitions. Each returns { columns, rows }.
// ---------------------------------------------------------------------------
const REPORTS = {
  // Sales -----------------------------------------------------------------
  'sales-by-depot': async (user, q) => {
    const ids = await ensureDepots(depotScope(user, q));
    const { from, to } = resolveRange(q);
    const { rows } = await query(
      `SELECT d.code AS depot_code, d.name AS depot_name,
              COALESCE(SUM(cs.amount), 0) AS cash_sales,
              COALESCE(SUM(ps.amount), 0) AS pos_sales,
              COALESCE(SUM(crs.amount), 0) AS credit_sales,
              COALESCE(SUM(cs.amount), 0) + COALESCE(SUM(ps.amount), 0) + COALESCE(SUM(crs.amount), 0) AS total_sales
         FROM depots d
         LEFT JOIN cash_sales   cs  ON cs.depot_id  = d.id AND cs.status  = 'posted' AND cs.transaction_date  BETWEEN $2 AND $3
         LEFT JOIN pos_sales    ps  ON ps.depot_id  = d.id AND ps.status  = 'posted' AND ps.transaction_date  BETWEEN $2 AND $3
         LEFT JOIN credit_sales crs ON crs.depot_id = d.id AND crs.status = 'posted' AND crs.transaction_date BETWEEN $2 AND $3
        WHERE d.id = ANY($1::int[])
        GROUP BY d.code, d.name
        ORDER BY d.code`,
      [ids, from, to]
    );
    return {
      columns: [
        { key: 'depot_code', label: 'Depot' },
        { key: 'depot_name', label: 'Depot Name' },
        { key: 'cash_sales', label: 'Cash Sales', money: true },
        { key: 'pos_sales', label: 'POS Sales', money: true },
        { key: 'credit_sales', label: 'Credit Sales', money: true },
        { key: 'total_sales', label: 'Total Sales', money: true },
      ],
      rows,
      range: { from, to },
    };
  },

  'sales-daily': async (user, q) => {
    const ids = await ensureDepots(depotScope(user, q));
    const { from, to } = resolveRange(q);
    const { rows } = await query(
      `SELECT transaction_date,
              SUM(cash_sales)    AS cash_sales,
              SUM(pos_sales)     AS pos_sales,
              SUM(credit_sales)  AS credit_sales,
              SUM(total_sales)   AS total_sales
         FROM depot_daily_balances
        WHERE depot_id = ANY($1::int[]) AND transaction_date BETWEEN $2 AND $3
        GROUP BY transaction_date
        ORDER BY transaction_date`,
      [ids, from, to]
    );
    return {
      columns: [
        { key: 'transaction_date', label: 'Date' },
        { key: 'cash_sales', label: 'Cash Sales', money: true },
        { key: 'pos_sales', label: 'POS Sales', money: true },
        { key: 'credit_sales', label: 'Credit Sales', money: true },
        { key: 'total_sales', label: 'Total Sales', money: true },
      ],
      rows,
      range: { from, to },
    };
  },

  // Customers --------------------------------------------------------------
  'customer-balances': async (user, q) => {
    const ids = await ensureDepots(depotScope(user, q));
    const to = asOf(q);
    const { rows } = await query(
      `SELECT c.code, c.name, d.code AS depot_code,
              COALESCE((SELECT SUM(amount) FROM credit_sales WHERE customer_id=c.id AND status='posted' AND transaction_date <= $2),0) AS credit_sales,
              COALESCE((SELECT SUM(amount) FROM customer_payments WHERE customer_id=c.id AND status='posted' AND transaction_date <= $2),0) AS payments,
              COALESCE((SELECT SUM(amount) FROM credit_sales WHERE customer_id=c.id AND status='posted' AND transaction_date <= $2),0)
            - COALESCE((SELECT SUM(amount) FROM customer_payments WHERE customer_id=c.id AND status='posted' AND transaction_date <= $2),0) AS balance
         FROM customers c JOIN depots d ON d.id = c.depot_id
        WHERE c.depot_id = ANY($1::int[])
        ORDER BY balance DESC, c.name`,
      [ids, to]
    );
    return {
      columns: [
        { key: 'code', label: 'Code' },
        { key: 'name', label: 'Customer' },
        { key: 'depot_code', label: 'Depot' },
        { key: 'credit_sales', label: 'Credit Sales', money: true },
        { key: 'payments', label: 'Payments', money: true },
        { key: 'balance', label: 'Outstanding', money: true },
      ],
      rows,
      asOf: to,
    };
  },

  'credit-sales-list': async (user, q) => {
    const ids = await ensureDepots(depotScope(user, q));
    const { from, to } = resolveRange(q);
    const { rows } = await query(
      `SELECT cs.transaction_date, d.code AS depot_code, c.code AS customer_code, c.name AS customer_name,
              cs.amount, cs.reference, cs.status, cs.entry_date, cs.entry_time, cs.entered_by_name
         FROM credit_sales cs
         JOIN customers c ON c.id = cs.customer_id
         JOIN depots d ON d.id = cs.depot_id
        WHERE cs.depot_id = ANY($1::int[]) AND cs.transaction_date BETWEEN $2 AND $3
        ORDER BY cs.transaction_date DESC, cs.id DESC`,
      [ids, from, to]
    );
    return {
      columns: [
        { key: 'transaction_date', label: 'Transaction Date' },
        { key: 'depot_code', label: 'Depot' },
        { key: 'customer_name', label: 'Customer' },
        { key: 'customer_code', label: 'Customer Code' },
        { key: 'amount', label: 'Amount', money: true },
        { key: 'reference', label: 'Reference' },
        { key: 'status', label: 'Status' },
        { key: 'entry_date', label: 'Entry Date' },
        { key: 'entry_time', label: 'Entry Time' },
        { key: 'entered_by_name', label: 'Entered By' },
      ],
      rows,
      range: { from, to },
    };
  },

  'customer-payments-list': async (user, q) => {
    const ids = await ensureDepots(depotScope(user, q));
    const { from, to } = resolveRange(q);
    const { rows } = await query(
      `SELECT cp.transaction_date, d.code AS depot_code, c.code AS customer_code, c.name AS customer_name,
              cp.amount, cp.payment_method, cp.reference, cp.status, cp.entry_date, cp.entry_time, cp.entered_by_name
         FROM customer_payments cp
         JOIN customers c ON c.id = cp.customer_id
         JOIN depots d ON d.id = cp.depot_id
        WHERE cp.depot_id = ANY($1::int[]) AND cp.transaction_date BETWEEN $2 AND $3
        ORDER BY cp.transaction_date DESC, cp.id DESC`,
      [ids, from, to]
    );
    return {
      columns: [
        { key: 'transaction_date', label: 'Payment Date' },
        { key: 'depot_code', label: 'Depot' },
        { key: 'customer_name', label: 'Customer' },
        { key: 'customer_code', label: 'Customer Code' },
        { key: 'amount', label: 'Amount', money: true },
        { key: 'payment_method', label: 'Method' },
        { key: 'reference', label: 'Reference' },
        { key: 'status', label: 'Status' },
        { key: 'entry_date', label: 'Entry Date' },
        { key: 'entry_time', label: 'Entry Time' },
        { key: 'entered_by_name', label: 'Entered By' },
      ],
      rows,
      range: { from, to },
    };
  },

  // Suppliers --------------------------------------------------------------
  'supplier-debts': async (user, q) => {
    const ids = await ensureDepots(depotScope(user, q));
    const to = asOf(q);
    const { rows } = await query(
      `SELECT s.code, s.name, d.code AS depot_code,
              COALESCE((SELECT SUM(amount) FROM supplier_purchases WHERE supplier_id=s.id AND status='posted' AND transaction_date <= $2),0) AS purchases,
              COALESCE((SELECT SUM(amount) FROM supplier_payments WHERE supplier_id=s.id AND status='posted' AND transaction_date <= $2),0) AS payments,
              COALESCE((SELECT SUM(amount) FROM supplier_purchases WHERE supplier_id=s.id AND status='posted' AND transaction_date <= $2),0)
            - COALESCE((SELECT SUM(amount) FROM supplier_payments WHERE supplier_id=s.id AND status='posted' AND transaction_date <= $2),0) AS debt
         FROM suppliers s JOIN depots d ON d.id = s.depot_id
        WHERE s.depot_id = ANY($1::int[])
        ORDER BY debt DESC, s.name`,
      [ids, to]
    );
    return {
      columns: [
        { key: 'code', label: 'Code' },
        { key: 'name', label: 'Supplier' },
        { key: 'depot_code', label: 'Depot' },
        { key: 'purchases', label: 'Purchases', money: true },
        { key: 'payments', label: 'Payments', money: true },
        { key: 'debt', label: 'Outstanding Debt', money: true },
      ],
      rows,
      asOf: to,
    };
  },

  'supplier-purchases-list': async (user, q) => {
    const ids = await ensureDepots(depotScope(user, q));
    const { from, to } = resolveRange(q);
    const { rows } = await query(
      `SELECT sp.transaction_date, d.code AS depot_code, s.code AS supplier_code, s.name AS supplier_name,
              sp.amount, sp.purchase_type, sp.reference, sp.status, sp.entry_date, sp.entry_time, sp.entered_by_name
         FROM supplier_purchases sp
         JOIN suppliers s ON s.id = sp.supplier_id
         JOIN depots d ON d.id = sp.depot_id
        WHERE sp.depot_id = ANY($1::int[]) AND sp.transaction_date BETWEEN $2 AND $3
        ORDER BY sp.transaction_date DESC, sp.id DESC`,
      [ids, from, to]
    );
    return {
      columns: [
        { key: 'transaction_date', label: 'Transaction Date' },
        { key: 'depot_code', label: 'Depot' },
        { key: 'supplier_name', label: 'Supplier' },
        { key: 'supplier_code', label: 'Supplier Code' },
        { key: 'amount', label: 'Amount', money: true },
        { key: 'purchase_type', label: 'Type' },
        { key: 'reference', label: 'Reference' },
        { key: 'status', label: 'Status' },
        { key: 'entry_date', label: 'Entry Date' },
        { key: 'entry_time', label: 'Entry Time' },
        { key: 'entered_by_name', label: 'Entered By' },
      ],
      rows,
      range: { from, to },
    };
  },

  'supplier-payments-list': async (user, q) => {
    const ids = await ensureDepots(depotScope(user, q));
    const { from, to } = resolveRange(q);
    const { rows } = await query(
      `SELECT sp.transaction_date, d.code AS depot_code, s.code AS supplier_code, s.name AS supplier_name,
              sp.amount, sp.payment_method, sp.reference, sp.status, sp.entry_date, sp.entry_time, sp.entered_by_name
         FROM supplier_payments sp
         JOIN suppliers s ON s.id = sp.supplier_id
         JOIN depots d ON d.id = sp.depot_id
        WHERE sp.depot_id = ANY($1::int[]) AND sp.transaction_date BETWEEN $2 AND $3
        ORDER BY sp.transaction_date DESC, sp.id DESC`,
      [ids, from, to]
    );
    return {
      columns: [
        { key: 'transaction_date', label: 'Payment Date' },
        { key: 'depot_code', label: 'Depot' },
        { key: 'supplier_name', label: 'Supplier' },
        { key: 'supplier_code', label: 'Supplier Code' },
        { key: 'amount', label: 'Amount', money: true },
        { key: 'payment_method', label: 'Method' },
        { key: 'reference', label: 'Reference' },
        { key: 'status', label: 'Status' },
        { key: 'entry_date', label: 'Entry Date' },
        { key: 'entry_time', label: 'Entry Time' },
        { key: 'entered_by_name', label: 'Entered By' },
      ],
      rows,
      range: { from, to },
    };
  },

  // Stock ------------------------------------------------------------------
  'stock-values': async (user, q) => {
    const ids = await ensureDepots(depotScope(user, q));
    const { from, to } = resolveRange(q);
    const { rows } = await query(
      `SELECT sv.transaction_date, d.code AS depot_code, d.name AS depot_name,
              sv.stock_value, sv.status, sv.entry_date, sv.entry_time, sv.entered_by_name,
              sv.last_updated_by_name, sv.last_updated_at
         FROM stock_value_records sv
         JOIN depots d ON d.id = sv.depot_id
        WHERE sv.depot_id = ANY($1::int[]) AND sv.transaction_date BETWEEN $2 AND $3
        ORDER BY sv.transaction_date DESC, d.code`,
      [ids, from, to]
    );
    return {
      columns: [
        { key: 'transaction_date', label: 'Date' },
        { key: 'depot_code', label: 'Depot' },
        { key: 'stock_value', label: 'Stock Value', money: true },
        { key: 'status', label: 'Status' },
        { key: 'entered_by_name', label: 'Entered By' },
        { key: 'entry_date', label: 'Entry Date' },
        { key: 'entry_time', label: 'Entry Time' },
        { key: 'last_updated_by_name', label: 'Last Updated By' },
        { key: 'last_updated_at', label: 'Last Updated' },
      ],
      rows,
      range: { from, to },
    };
  },

  // Expenses ---------------------------------------------------------------
  'expenses-by-category': async (user, q) => {
    const ids = await ensureDepots(depotScope(user, q));
    const { from, to } = resolveRange(q);
    const { rows } = await query(
      `SELECT COALESCE(ec.name, 'Uncategorised') AS category,
              COUNT(*)::int AS entries,
              SUM(e.amount) AS total
         FROM depot_expenses e
         LEFT JOIN expense_categories ec ON ec.id = e.category_id
        WHERE e.depot_id = ANY($1::int[]) AND e.status = 'posted' AND e.transaction_date BETWEEN $2 AND $3
        GROUP BY COALESCE(ec.name, 'Uncategorised')
        ORDER BY total DESC`,
      [ids, from, to]
    );
    return {
      columns: [
        { key: 'category', label: 'Category' },
        { key: 'entries', label: 'Entries' },
        { key: 'total', label: 'Total', money: true },
      ],
      rows,
      range: { from, to },
    };
  },

  'expenses-daily': async (user, q) => {
    const ids = await ensureDepots(depotScope(user, q));
    const { from, to } = resolveRange(q);
    const { rows } = await query(
      `SELECT e.transaction_date, d.code AS depot_code, SUM(e.amount) AS total
         FROM depot_expenses e
         JOIN depots d ON d.id = e.depot_id
        WHERE e.depot_id = ANY($1::int[]) AND e.status = 'posted' AND e.transaction_date BETWEEN $2 AND $3
        GROUP BY e.transaction_date, d.code
        ORDER BY e.transaction_date DESC, d.code`,
      [ids, from, to]
    );
    return {
      columns: [
        { key: 'transaction_date', label: 'Date' },
        { key: 'depot_code', label: 'Depot' },
        { key: 'total', label: 'Expenses', money: true },
      ],
      rows,
      range: { from, to },
    };
  },

  // Operating balance ------------------------------------------------------
  'operating-daily': async (user, q) => {
    const ids = await ensureDepots(depotScope(user, q));
    const { from, to } = resolveRange(q);
    const { rows } = await query(
      `SELECT b.transaction_date, d.code AS depot_code,
              b.total_sales, b.supplier_purchases, b.operating_balance
         FROM depot_daily_balances b
         JOIN depots d ON d.id = b.depot_id
        WHERE b.depot_id = ANY($1::int[]) AND b.transaction_date BETWEEN $2 AND $3
        ORDER BY b.transaction_date DESC, d.code`,
      [ids, from, to]
    );
    return {
      columns: [
        { key: 'transaction_date', label: 'Date' },
        { key: 'depot_code', label: 'Depot' },
        { key: 'total_sales', label: 'Total Sales', money: true },
        { key: 'supplier_purchases', label: 'Supplier Purchases', money: true },
        { key: 'operating_balance', label: 'Operating Balance', money: true },
      ],
      rows,
      range: { from, to },
    };
  },

  'operating-global': async (user, q) => {
    const ids = await ensureDepots(depotScope(user, q));
    const { from, to } = resolveRange(q);
    const { rows } = await query(
      `SELECT transaction_date,
              SUM(total_sales)   AS total_sales,
              SUM(operating_balance) AS operating_balance
         FROM depot_daily_balances
        WHERE depot_id = ANY($1::int[]) AND transaction_date BETWEEN $2 AND $3
        GROUP BY transaction_date
        ORDER BY transaction_date`,
      [ids, from, to]
    );
    return {
      columns: [
        { key: 'transaction_date', label: 'Date' },
        { key: 'total_sales', label: 'Total Sales (all depots)', money: true },
        { key: 'operating_balance', label: 'Total Operating Balance', money: true },
      ],
      rows,
      range: { from, to },
    };
  },
};

function toCsv(columns, rows) {
  const escape = (v) => {
    if (v === null || v === undefined) return '';
    let s = String(v);
    // Neutralise spreadsheet formula injection.
    if (/^[=+\-@]/.test(s)) s = `'${s}`;
    if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const header = columns.map((c) => escape(c.label)).join(',');
  const lines = rows.map((r) => columns.map((c) => escape(r[c.key])).join(','));
  return `${header}\n${lines.join('\n')}\n`;
}

// GET /api/reports/:kind?from&to&depotId&format=json|csv
router.get(
  '/:kind',
  requirePermission(PAGE, 'view'),
  asyncHandler(async (req, res) => {
    const kind = String(req.params.kind);
    const definition = REPORTS[kind];
    if (!definition) {
      throw badRequest(`Unknown report "${kind}". Available: ${Object.keys(REPORTS).join(', ')}`);
    }
    const result = await definition(req.user, req.query);

    if (req.query.format === 'csv') {
      if (!hasPermission(req.user, PAGE, 'export')) {
        throw badRequest('You do not have "export" permission on Reports');
      }
      await logAudit({
        actor: req.user, req, action: 'REPORT_EXPORT', entityType: 'report', entityId: kind,
        description: `Exported report "${kind}" as CSV (${result.rows.length} rows)`,
      });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${kind}.csv"`);
      return res.send(toCsv(result.columns, result.rows));
    }

    await logAudit({
      actor: req.user, req, action: 'REPORT_VIEW', entityType: 'report', entityId: kind,
      description: `Viewed report "${kind}"`,
    });
    return res.json({ kind, ...result });
  })
);

// GET /api/reports — list available reports (for the UI)
router.get(
  '/',
  requirePermission(PAGE, 'view'),
  asyncHandler(async (req, res) => {
    res.json({
      reports: [
        { kind: 'sales-by-depot', label: 'Sales by Depot', group: 'Sales' },
        { kind: 'sales-daily', label: 'Daily Sales', group: 'Sales' },
        { kind: 'customer-balances', label: 'Outstanding Customer Balances', group: 'Customers' },
        { kind: 'credit-sales-list', label: 'Credit Sales', group: 'Customers' },
        { kind: 'customer-payments-list', label: 'Customer Payments', group: 'Customers' },
        { kind: 'supplier-debts', label: 'Outstanding Supplier Debt', group: 'Suppliers' },
        { kind: 'supplier-purchases-list', label: 'Supplier Purchases', group: 'Suppliers' },
        { kind: 'supplier-payments-list', label: 'Supplier Payments', group: 'Suppliers' },
        { kind: 'stock-values', label: 'Stock Values', group: 'Stock' },
        { kind: 'expenses-by-category', label: 'Expenses by Category', group: 'Expenses' },
        { kind: 'expenses-daily', label: 'Daily Expenses', group: 'Expenses' },
        { kind: 'operating-daily', label: 'Daily Depot Operating Balance', group: 'Operating' },
        { kind: 'operating-global', label: 'Global Operating Balance', group: 'Operating' },
      ],
    });
  })
);

export default router;
