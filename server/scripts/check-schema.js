/**
 * Quick schema sanity check — run with: node scripts/check-schema.js
 */
import { pool } from '../src/db/pool.js';

const enc = await pool.query(
  "SELECT pg_encoding_to_char(encoding) AS enc FROM pg_database WHERE datname = current_database()"
);
console.log('database encoding:', enc.rows[0].enc);

for (const view of ['depot_daily_balances', 'customer_account_ledger', 'supplier_account_ledger', 'customer_credit_sales']) {
  const res = await pool.query(`SELECT * FROM ${view} LIMIT 1`);
  console.log(`view ${view}: ok (${res.rowCount} rows)`);
}

const company = await pool.query('SELECT name, currency_symbol FROM companies LIMIT 1');
console.log('company:', company.rows[0].name, '| symbol:', company.rows[0].currency_symbol);

const depots = await pool.query('SELECT code, name FROM depots ORDER BY id');
console.log('depots:', depots.rows.map((d) => `${d.code}=${d.name}`).join(', '));

const users = await pool.query(
  `SELECT u.username, r.name AS role FROM users u
   JOIN user_roles ur ON ur.user_id = u.id AND ur.is_active
   JOIN roles r ON r.id = ur.role_id`
);
console.log('users:', users.rows.map((u) => `${u.username}(${u.role})`).join(', '));

await pool.end();
