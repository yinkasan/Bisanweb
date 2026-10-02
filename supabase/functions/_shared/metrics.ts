/**
 * Dashboard metrics for edge functions — a direct port of
 * server/src/services/dashboardService.js so the numbers are identical no
 * matter which backend computes them:
 *
 *   Total Sales        = Cash + POS + Credit          (§15, §33)
 *   Customer Credit    = Credit Sales − Payments      (§16, §22)
 *   Supplier Debt      = Purchases − Payments         (§23)
 *   Operating Balance  = Σ (Purchases − Total Sales)  (§17) on opening balance
 *   Cash at Hand       = Cash Sales − Expenses        (as of date)
 *   Residual Balance   = Total Sales + Present Stock − Previous Stock − Purchases
 *   Total Cash (global)= Σ Cash at Hand of the depots
 */
import { query, queryOne } from './db.ts';
import { addDays } from './stamps.ts';

/** Money values are kept as strings end-to-end; this normalises to 2dp. */
export function money(value: unknown): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return '0.00';
  return n.toFixed(2);
}

interface DepotSettings {
  opening_balance_date: string | null;
  opening_operating_balance: string;
  opening_cash_at_hand: string;
}

export async function depotSettings(depotId: number): Promise<DepotSettings> {
  const row = await queryOne<DepotSettings>(
    `SELECT opening_balance_date, opening_operating_balance, opening_cash_at_hand
       FROM depot_settings WHERE depot_id = $1`,
    [depotId],
  );
  return row ?? { opening_balance_date: null, opening_operating_balance: '0', opening_cash_at_hand: '0' };
}

/** Operating balance as of a date (or the opening balance when earlier). */
export async function operatingBalanceAsOf(depotId: number, date: string): Promise<string> {
  const row = await queryOne<{ operating_balance: string }>(
    `SELECT operating_balance FROM depot_daily_balances
      WHERE depot_id = $1 AND transaction_date <= $2
      ORDER BY transaction_date DESC LIMIT 1`,
    [depotId, date],
  );
  if (row) return row.operating_balance;
  const settings = await depotSettings(depotId);
  return settings.opening_operating_balance;
}

export interface DepotMetrics {
  cash_sales: string;
  pos_sales: string;
  credit_sales: string;
  total_sales: string;
  supplier_purchases: string;
  supplier_payments: string;
  customer_payments: string;
  expenses: string;
  customer_credit: string;
  supplier_debt: string;
  stock_value: string | null;
  stock_value_date: string | null;
  previous_stock_value: string;
  residual_balance: string;
  cash_at_hand: string;
  previous_operating_balance: string;
  operating_balance: string;
  opening_operating_balance: string;
}

/** Everything the depot dashboard needs. */
export async function depotMetrics(depotId: number, from: string, to: string): Promise<DepotMetrics> {
  const r = await queryOne<Record<string, string | null>>(
    `SELECT
       (SELECT COALESCE(SUM(amount),0) FROM cash_sales      WHERE depot_id=$1 AND status='posted' AND transaction_date BETWEEN $2 AND $3) AS cash_sales,
       (SELECT COALESCE(SUM(amount),0) FROM pos_sales       WHERE depot_id=$1 AND status='posted' AND transaction_date BETWEEN $2 AND $3) AS pos_sales,
       (SELECT COALESCE(SUM(amount),0) FROM credit_sales    WHERE depot_id=$1 AND status='posted' AND transaction_date BETWEEN $2 AND $3) AS credit_sales,
       (SELECT COALESCE(SUM(amount),0) FROM supplier_purchases WHERE depot_id=$1 AND status='posted' AND transaction_date BETWEEN $2 AND $3) AS supplier_purchases,
       (SELECT COALESCE(SUM(amount),0) FROM supplier_payments  WHERE depot_id=$1 AND status='posted' AND transaction_date BETWEEN $2 AND $3) AS supplier_payments,
       (SELECT COALESCE(SUM(amount),0) FROM customer_payments  WHERE depot_id=$1 AND status='posted' AND transaction_date BETWEEN $2 AND $3) AS customer_payments,
       (SELECT COALESCE(SUM(amount),0) FROM depot_expenses     WHERE depot_id=$1 AND status='posted' AND transaction_date BETWEEN $2 AND $3) AS expenses,
       (SELECT COALESCE(SUM(amount),0) FROM credit_sales      WHERE depot_id=$1 AND status='posted' AND transaction_date <= $3) AS credit_to_date,
       (SELECT COALESCE(SUM(amount),0) FROM customer_payments WHERE depot_id=$1 AND status='posted' AND transaction_date <= $3) AS customer_payments_to_date,
       (SELECT COALESCE(SUM(amount),0) FROM supplier_purchases WHERE depot_id=$1 AND status='posted' AND transaction_date <= $3) AS purchases_to_date,
       (SELECT COALESCE(SUM(amount),0) FROM supplier_payments  WHERE depot_id=$1 AND status='posted' AND transaction_date <= $3) AS supplier_payments_to_date,
       (SELECT COALESCE(SUM(amount),0) FROM cash_sales        WHERE depot_id=$1 AND status='posted' AND transaction_date <= $3) AS cash_sales_to_date,
       (SELECT COALESCE(SUM(amount),0) FROM depot_expenses    WHERE depot_id=$1 AND status='posted' AND transaction_date <= $3) AS expenses_to_date,
       (SELECT stock_value FROM stock_value_records WHERE depot_id=$1 AND status='posted' AND transaction_date <= $3
         ORDER BY transaction_date DESC LIMIT 1) AS stock_value,
       (SELECT transaction_date::text FROM stock_value_records WHERE depot_id=$1 AND status='posted' AND transaction_date <= $3
         ORDER BY transaction_date DESC LIMIT 1) AS stock_value_date,
       (SELECT stock_value FROM stock_value_records WHERE depot_id=$1 AND status='posted' AND transaction_date < $2
         ORDER BY transaction_date DESC LIMIT 1) AS previous_stock_value`,
    [depotId, from, to],
  );

  const settings = await depotSettings(depotId);
  const previousBalance = await operatingBalanceAsOf(depotId, addDays(from, -1));
  const operatingBalance = await operatingBalanceAsOf(depotId, to);

  const n = (v: unknown) => Number(v ?? 0);
  const data = r ?? {};
  const cashSales = n(data.cash_sales);
  const posSales = n(data.pos_sales);
  const creditSales = n(data.credit_sales);
  const totalSales = cashSales + posSales + creditSales;
  const supplierPurchases = n(data.supplier_purchases);
  const customerCredit = n(data.credit_to_date) - n(data.customer_payments_to_date);
  const supplierDebt = n(data.purchases_to_date) - n(data.supplier_payments_to_date);
  // Business rule: cash at hand = depot cash sales − depot expenses (to date).
  const cashAtHand = n(data.cash_sales_to_date) - n(data.expenses_to_date);
  // Business rule: residual balance = total sales + present stock value
  // − previous stock value − purchases (period). Present = latest stock
  // snapshot up to `to`; previous = latest snapshot before `from`.
  const presentStock = n(data.stock_value);
  const previousStock = n(data.previous_stock_value);
  const residualBalance = totalSales + presentStock - previousStock - supplierPurchases;

  return {
    cash_sales: money(cashSales),
    pos_sales: money(posSales),
    credit_sales: money(creditSales),
    total_sales: money(totalSales),
    supplier_purchases: money(supplierPurchases),
    supplier_payments: money(n(data.supplier_payments)),
    customer_payments: money(n(data.customer_payments)),
    expenses: money(n(data.expenses)),
    customer_credit: money(customerCredit),
    supplier_debt: money(supplierDebt),
    stock_value: data.stock_value === null || data.stock_value === undefined ? null : money(data.stock_value),
    stock_value_date: (data.stock_value_date as string | null) ?? null,
    previous_stock_value: money(previousStock),
    residual_balance: money(residualBalance),
    cash_at_hand: money(cashAtHand),
    previous_operating_balance: money(previousBalance),
    operating_balance: money(operatingBalance),
    opening_operating_balance: money(settings.opening_operating_balance),
  };
}

/** Cash at bank is a company-level setting (SRS §20). */
export async function cashAtBank(): Promise<string> {
  const row = await queryOne<{ value: string }>(
    `SELECT value FROM system_settings WHERE key = 'cash_at_bank'`,
  );
  return row ? money(row.value) : '0.00';
}

export async function depotDailySeries(depotId: number, from: string, to: string) {
  return await query(
    `SELECT transaction_date, cash_sales, pos_sales, credit_sales, total_sales,
            supplier_purchases, expenses, operating_balance
       FROM depot_daily_balances
      WHERE depot_id = $1 AND transaction_date BETWEEN $2 AND $3
      ORDER BY transaction_date`,
    [depotId, from, to],
  );
}

export async function depotInfo(depotId: number) {
  return await queryOne<Record<string, unknown>>(
    'SELECT id, code, name, location FROM depots WHERE id = $1',
    [depotId],
  );
}

/** Customers with a non-zero balance as of `to` (dashboard drill-down). */
export async function customersWithBalances(depotIds: number[], to: string) {
  const rows = await query<Record<string, unknown>>(
    `SELECT c.id, c.code, c.name, c.depot_id, d.code AS depot_code,
            COALESCE((SELECT SUM(amount) FROM credit_sales WHERE customer_id=c.id AND status='posted' AND transaction_date <= $2),0)
          - COALESCE((SELECT SUM(amount) FROM customer_payments WHERE customer_id=c.id AND status='posted' AND transaction_date <= $2),0) AS balance
       FROM customers c JOIN depots d ON d.id = c.depot_id
      WHERE c.depot_id = ANY($1::int[])
      ORDER BY balance DESC, c.name`,
    [depotIds, to],
  );
  return rows.filter((r) => Number(r.balance) !== 0);
}

/** Suppliers with a non-zero debt as of `to` (dashboard drill-down). */
export async function suppliersWithDebts(depotIds: number[], to: string) {
  const rows = await query<Record<string, unknown>>(
    `SELECT s.id, s.code, s.name, s.depot_id, d.code AS depot_code,
            COALESCE((SELECT SUM(amount) FROM supplier_purchases WHERE supplier_id=s.id AND status='posted' AND transaction_date <= $2),0)
          - COALESCE((SELECT SUM(amount) FROM supplier_payments WHERE supplier_id=s.id AND status='posted' AND transaction_date <= $2),0) AS debt
       FROM suppliers s JOIN depots d ON d.id = s.depot_id
      WHERE s.depot_id = ANY($1::int[])
      ORDER BY debt DESC, s.name`,
    [depotIds, to],
  );
  return rows.filter((r) => Number(r.debt) !== 0);
}

/** Sales component entries for the "Total Depot Sales" drill-down (SRS §36). */
export async function salesBreakdown(depotId: number, from: string, to: string) {
  const cols = 'id, transaction_date, amount, reference, status, entry_date, entry_time, entered_by_name';
  const cash = await query<Record<string, unknown>>(
    `SELECT ${cols} FROM cash_sales WHERE depot_id=$1 AND transaction_date BETWEEN $2 AND $3 ORDER BY transaction_date DESC, id DESC LIMIT 100`,
    [depotId, from, to],
  );
  const pos = await query<Record<string, unknown>>(
    `SELECT ${cols} FROM pos_sales WHERE depot_id=$1 AND transaction_date BETWEEN $2 AND $3 ORDER BY transaction_date DESC, id DESC LIMIT 100`,
    [depotId, from, to],
  );
  const credit = await query<Record<string, unknown>>(
    `SELECT cs.id, cs.transaction_date, cs.amount, cs.reference, cs.status,
            cs.entry_date, cs.entry_time, cs.entered_by_name, c.name AS customer_name, c.code AS customer_code
       FROM credit_sales cs JOIN customers c ON c.id = cs.customer_id
      WHERE cs.depot_id=$1 AND cs.transaction_date BETWEEN $2 AND $3
      ORDER BY cs.transaction_date DESC, cs.id DESC LIMIT 100`,
    [depotId, from, to],
  );
  const sum = (rows: Record<string, unknown>[]) =>
    rows.filter((r) => r.status === 'posted').reduce((a, r) => a + Number(r.amount), 0);
  return {
    cash_sales: { total: money(sum(cash)), entries: cash },
    pos_sales: { total: money(sum(pos)), entries: pos },
    credit_sales: { total: money(sum(credit)), entries: credit },
  };
}
