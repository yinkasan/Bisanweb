/**
 * Clears all transactional data (sales, payments, purchases, expenses, stock,
 * reversals, audit/adjustment logs, notifications) and account records
 * (customers, suppliers). Also removes the demo users created by seed:demo.
 * Keeps real users, roles, permissions, depots, settings.
 *
 * Used by developers to get back to a clean slate before seeding demo data.
 * Run with: node scripts/reset-data.js
 */
import { pathToFileURL } from 'node:url';
import { query, pool } from '../src/db/pool.js';

const TABLES = [
  'cash_sales', 'pos_sales', 'credit_sales', 'customer_payments',
  'supplier_purchases', 'supplier_payments', 'depot_expenses',
  'stock_value_records', 'stock_value_history', 'transaction_reversals',
  'adjustment_logs', 'audit_logs', 'notifications',
  'customers', 'suppliers',
];

const DEMO_USERNAMES = ['admin', 'sales1', 'staff1'];

export async function resetData() {
  await query(`TRUNCATE TABLE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
  const removed = await query(
    `DELETE FROM users WHERE username = ANY($1::text[]) RETURNING username`,
    [DEMO_USERNAMES]
  );
  console.log(`[reset] cleared: ${TABLES.join(', ')}`);
  if (removed.rowCount > 0) {
    console.log(`[reset] removed demo users: ${removed.rows.map((r) => r.username).join(', ')}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  resetData()
    .then(() => pool.end())
    .catch((err) => {
      console.error('[reset] failed:', err);
      process.exit(1);
    });
}
