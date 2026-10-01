import { query, money } from '../db/pool.js';
import { addDays } from '../utils/stamps.js';

/**
 * All dashboard numbers are derived from transactions using the SRS formulas:
 *
 *   Total Sales            = Cash + POS + Credit          (§15, §33)
 *   Customer Credit        = Credit Sales − Payments      (§16, §22)
 *   Supplier Debt          = Purchases − Payments         (§23)
 *   Operating Balance      = Σ (Purchases − Total Sales)  (§17)
 *                            applied on top of the depot's opening balance
 *   Cash at Hand           = Cash Sales − Expenses        (as of date)
 *   Residual Balance       = Total Sales + Present Stock − Previous Stock − Purchases
 *   Total Cash (global)    = Σ Cash at Hand of the depots
 *
 * Range filters apply to flows (sales, purchases, expenses) while outstanding
 * balances are cumulative "to date" (the end of the selected range).
 */

async function depotSettings(depotId) {
  const res = await query(
    `SELECT opening_balance_date, opening_operating_balance, opening_cash_at_hand
       FROM depot_settings WHERE depot_id = $1`,
    [depotId]
  );
  if (res.rowCount === 0) {
    return { opening_balance_date: null, opening_operating_balance: '0', opening_cash_at_hand: '0' };
  }
  return res.rows[0];
}

/** Operating balance as of a date (or the opening balance when earlier). */
export async function operatingBalanceAsOf(depotId, date) {
  const row = await query(
    `SELECT operating_balance FROM depot_daily_balances
      WHERE depot_id = $1 AND transaction_date <= $2
      ORDER BY transaction_date DESC LIMIT 1`,
    [depotId, date]
  );
  if (row.rowCount > 0) return row.rows[0].operating_balance;
  const settings = await depotSettings(depotId);
  return settings.opening_operating_balance;
}

/** Everything the depot dashboard needs, in one round trip + two small ones. */
export async function depotMetrics(depotId, from, to) {
  const res = await query(
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
       (SELECT transaction_date FROM stock_value_records WHERE depot_id=$1 AND status='posted' AND transaction_date <= $3
         ORDER BY transaction_date DESC LIMIT 1) AS stock_value_date,
       (SELECT stock_value FROM stock_value_records WHERE depot_id=$1 AND status='posted' AND transaction_date < $2
         ORDER BY transaction_date DESC LIMIT 1) AS previous_stock_value`,
    [depotId, from, to]
  );
  const r = res.rows[0];

  const settings = await depotSettings(depotId);
  const previousBalance = await operatingBalanceAsOf(depotId, addDays(from, -1));
  const operatingBalance = await operatingBalanceAsOf(depotId, to);

  const n = (v) => Number(v ?? 0);
  const cashSales = n(r.cash_sales);
  const posSales = n(r.pos_sales);
  const creditSales = n(r.credit_sales);
  const totalSales = cashSales + posSales + creditSales;
  const supplierPurchases = n(r.supplier_purchases);
  const customerCredit = n(r.credit_to_date) - n(r.customer_payments_to_date);
  const supplierDebt = n(r.purchases_to_date) - n(r.supplier_payments_to_date);
  // Business rule: cash at hand = depot cash sales − depot expenses (to date).
  const cashAtHand = n(r.cash_sales_to_date) - n(r.expenses_to_date);
  // Business rule: residual balance = total sales + present stock value
  // − previous stock value − purchases (period). Present = latest stock
  // snapshot up to `to`; previous = latest snapshot before `from`.
  const presentStock = n(r.stock_value);
  const previousStock = n(r.previous_stock_value);
  const residualBalance = totalSales + presentStock - previousStock - supplierPurchases;

  return {
    cash_sales: money(cashSales),
    pos_sales: money(posSales),
    credit_sales: money(creditSales),
    total_sales: money(totalSales),
    supplier_purchases: money(supplierPurchases),
    supplier_payments: money(n(r.supplier_payments)),
    customer_payments: money(n(r.customer_payments)),
    expenses: money(n(r.expenses)),
    customer_credit: money(customerCredit),
    supplier_debt: money(supplierDebt),
    stock_value: r.stock_value === null ? null : money(r.stock_value),
    stock_value_date: r.stock_value_date,
    previous_stock_value: money(previousStock),
    residual_balance: money(residualBalance),
    cash_at_hand: money(cashAtHand),
    previous_operating_balance: money(previousBalance),
    operating_balance: money(operatingBalance),
    opening_operating_balance: money(settings.opening_operating_balance),
  };
}

export async function depotDailySeries(depotId, from, to) {
  const { rows } = await query(
    `SELECT transaction_date, cash_sales, pos_sales, credit_sales, total_sales,
            supplier_purchases, expenses, operating_balance
       FROM depot_daily_balances
      WHERE depot_id = $1 AND transaction_date BETWEEN $2 AND $3
      ORDER BY transaction_date`,
    [depotId, from, to]
  );
  return rows;
}

/** Cash at bank is a company-level setting (SRS §20). */
export async function cashAtBank() {
  const res = await query(`SELECT value FROM system_settings WHERE key = 'cash_at_bank'`);
  return res.rowCount ? money(res.rows[0].value) : '0.00';
}

export async function depotInfo(depotId) {
  const res = await query(
    'SELECT id, code, name, location FROM depots WHERE id = $1',
    [depotId]
  );
  return res.rows[0] ?? null;
}

/** Customers with a non-zero balance as of `to` (dashboard drill-down). */
export async function customersWithBalances(depotIds, to) {
  const { rows } = await query(
    `SELECT c.id, c.code, c.name, c.depot_id, d.code AS depot_code,
            COALESCE((SELECT SUM(amount) FROM credit_sales WHERE customer_id=c.id AND status='posted' AND transaction_date <= $2),0)
          - COALESCE((SELECT SUM(amount) FROM customer_payments WHERE customer_id=c.id AND status='posted' AND transaction_date <= $2),0) AS balance
       FROM customers c JOIN depots d ON d.id = c.depot_id
      WHERE c.depot_id = ANY($1::int[])
      ORDER BY balance DESC, c.name`,
    [depotIds, to]
  );
  return rows.filter((r) => Number(r.balance) !== 0);
}

/** Suppliers with a non-zero debt as of `to` (dashboard drill-down). */
export async function suppliersWithDebts(depotIds, to) {
  const { rows } = await query(
    `SELECT s.id, s.code, s.name, s.depot_id, d.code AS depot_code,
            COALESCE((SELECT SUM(amount) FROM supplier_purchases WHERE supplier_id=s.id AND status='posted' AND transaction_date <= $2),0)
          - COALESCE((SELECT SUM(amount) FROM supplier_payments WHERE supplier_id=s.id AND status='posted' AND transaction_date <= $2),0) AS debt
       FROM suppliers s JOIN depots d ON d.id = s.depot_id
      WHERE s.depot_id = ANY($1::int[])
      ORDER BY debt DESC, s.name`,
    [depotIds, to]
  );
  return rows.filter((r) => Number(r.debt) !== 0);
}

/** Sales component entries for the "Total Depot Sales" drill-down (SRS §36). */
export async function salesBreakdown(depotId, from, to) {
  const cols = 'id, transaction_date, amount, reference, status, entry_date, entry_time, entered_by_name';
  const cash = await query(
    `SELECT ${cols} FROM cash_sales WHERE depot_id=$1 AND transaction_date BETWEEN $2 AND $3 ORDER BY transaction_date DESC, id DESC LIMIT 100`,
    [depotId, from, to]
  );
  const pos = await query(
    `SELECT ${cols} FROM pos_sales WHERE depot_id=$1 AND transaction_date BETWEEN $2 AND $3 ORDER BY transaction_date DESC, id DESC LIMIT 100`,
    [depotId, from, to]
  );
  const credit = await query(
    `SELECT cs.id, cs.transaction_date, cs.amount, cs.reference, cs.status,
            cs.entry_date, cs.entry_time, cs.entered_by_name, c.name AS customer_name, c.code AS customer_code
       FROM credit_sales cs JOIN customers c ON c.id = cs.customer_id
      WHERE cs.depot_id=$1 AND cs.transaction_date BETWEEN $2 AND $3
      ORDER BY cs.transaction_date DESC, cs.id DESC LIMIT 100`,
    [depotId, from, to]
  );
  const sum = (rows) => rows.filter((r) => r.status === 'posted').reduce((a, r) => a + Number(r.amount), 0);
  return {
    cash_sales: { total: money(sum(cash.rows)), entries: cash.rows },
    pos_sales: { total: money(sum(pos.rows)), entries: pos.rows },
    credit_sales: { total: money(sum(credit.rows)), entries: credit.rows },
  };
}
