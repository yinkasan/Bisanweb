/**
 * SRS §41 acceptance tests — run the API in-process on an ephemeral port and
 * verify each numbered scenario from the specification exactly.
 *
 * Requires the database to be up (npm run db:start -w server).
 * Run with: npm run test:acceptance -w server
 *
 * The suite creates isolated depots (codes ACC*) plus one scoped user, then
 * removes all of its own data on exit — demo data is never touched.
 */
import { createApp } from '../src/index.js';
import { query, pool } from '../src/db/pool.js';

const ADMIN_USER = process.env.BOOTSTRAP_ADMIN_USERNAME || 'superadmin';
const ADMIN_PASS = process.env.BOOTSTRAP_ADMIN_PASSWORD || 'Admin@2026';
const RUNNER_USER = 'acceptance_runner';
const RUNNER_PASS = 'Runner@2026';

const D = {
  t1: '2026-09-21', t2: '2026-09-21', t34: '2026-09-22', t5: '2026-09-23',
  t6: '2026-09-22', t7: '2026-09-23', inside: '2026-09-10', outside: '2026-09-20',
  opening: '2026-09-01',
};

let server = null;
let BASE = '';
let cookie = '';
let failures = 0;
const cleanupIds = { depotCodes: ['ACC1', 'ACC2', 'ACCX', 'ACCY', 'ACCZ'] };

async function api(method, path, body, opts = {}) {
  const useCookie = opts.cookie ?? cookie;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(useCookie ? { Cookie: useCookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie && opts.captureCookie !== false) cookie = setCookie.split(';')[0];
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, json };
}

function pass(label) {
  console.log(`  PASS  ${label}`);
}
function fail(label, detail) {
  failures += 1;
  console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
}
const num = (v) => Number(v);

// ---------------------------------------------------------------------------
// Setup / cleanup (direct SQL, restricted to this suite's own artifacts)
// ---------------------------------------------------------------------------
async function cleanup() {
  const { rows: depots } = await query(
    `SELECT id FROM depots WHERE code = ANY($1::text[])`, [cleanupIds.depotCodes]
  );
  const depotIds = depots.map((d) => d.id);
  if (depotIds.length > 0) {
    const { rows: accounts } = await query(
      `SELECT id FROM customers WHERE depot_id = ANY($1::int[])
       UNION ALL SELECT id FROM suppliers WHERE depot_id = ANY($1::int[])`,
      [depotIds]
    );
    const accountIds = accounts.map((a) => String(a.id));
    const { rows: stockRows } = await query(
      `SELECT id FROM stock_value_records WHERE depot_id = ANY($1::int[])`, [depotIds]
    );
    const stockIds = stockRows.map((s) => s.id);

    if (stockIds.length) {
      await query(`DELETE FROM stock_value_history WHERE stock_value_record_id = ANY($1::int[])`, [stockIds]);
    }
    await query(`DELETE FROM transaction_reversals WHERE depot_id = ANY($1::int[])`, [depotIds]);
    for (const table of ['cash_sales', 'pos_sales', 'credit_sales', 'customer_payments',
      'supplier_purchases', 'supplier_payments', 'depot_expenses', 'stock_value_records']) {
      // eslint-disable-next-line no-await-in-loop
      await query(`DELETE FROM ${table} WHERE depot_id = ANY($1::int[])`, [depotIds]);
    }
    if (accountIds.length) {
      await query(`DELETE FROM notifications WHERE entity_id = ANY($1::text[])`, [accountIds]);
    }
    await query(`DELETE FROM customers WHERE depot_id = ANY($1::int[])`, [depotIds]);
    await query(`DELETE FROM suppliers WHERE depot_id = ANY($1::int[])`, [depotIds]);
    await query(`DELETE FROM depot_settings WHERE depot_id = ANY($1::int[])`, [depotIds]);
    await query(`DELETE FROM depots WHERE id = ANY($1::int[])`, [depotIds]);
  }

  const { rows: runner } = await query(`SELECT id FROM users WHERE username = $1`, [RUNNER_USER]);
  if (runner.length) {
    const rid = runner[0].id;
    await query(`DELETE FROM role_change_logs WHERE user_id = $1`, [rid]);
    await query(`DELETE FROM audit_logs WHERE user_id = $1 OR (entity_type = 'user' AND entity_id = $2)`,
      [rid, String(rid)]);
    await query(`DELETE FROM users WHERE id = $1`, [rid]);
  }
}

async function createDepot(code, name, openingOperating, openingCash) {
  const res = await api('POST', '/depots', {
    code, name,
    openingBalanceDate: D.opening,
    openingOperatingBalance: openingOperating,
    openingCashAtHand: openingCash ?? 0,
  });
  if (res.status !== 201) throw new Error(`depot ${code} setup failed: ${JSON.stringify(res.json)}`);
  return res.json.id;
}

async function createCustomer(depotId, name) {
  const res = await api('POST', '/customers', { depotId, name });
  if (res.status !== 201) throw new Error(`customer setup failed: ${JSON.stringify(res.json)}`);
  return res.json.account;
}

async function createSupplier(depotId, name) {
  const res = await api('POST', '/suppliers', { depotId, name });
  if (res.status !== 201) throw new Error(`supplier setup failed: ${JSON.stringify(res.json)}`);
  return res.json.account;
}

async function postFlow(path, body) {
  const res = await api('POST', path, body);
  if (res.status !== 201) throw new Error(`${path} failed: ${JSON.stringify(res.json)}`);
  return res.json.item;
}

// ---------------------------------------------------------------------------
// The ten SRS acceptance tests
// ---------------------------------------------------------------------------
async function main() {
  // Boot the API in-process (migrations/seeding were already done by the server).
  const app = createApp();
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  BASE = `http://127.0.0.1:${server.address().port}/api`;

  const health = await api('GET', '/health');
  if (health.status !== 200) throw new Error('API health check failed — is the database running?');

  await cleanup();

  // ---- Fixtures -----------------------------------------------------------
  await api('POST', '/auth/login', { username: ADMIN_USER, password: ADMIN_PASS });
  const acc1 = await createDepot('ACC1', 'Acceptance Depot 1', 0);
  const acc2 = await createDepot('ACC2', 'Acceptance Depot 2', 5000000);
  const accX = await createDepot('ACCX', 'Acceptance Depot X', 5000000);
  const accY = await createDepot('ACCY', 'Acceptance Depot Y', 7000000);
  const accZ = await createDepot('ACCZ', 'Acceptance Depot Z', 8000000);
  const abc = await createCustomer(acc1, 'ABC Traders');
  const acc2Customer = await createCustomer(acc2, 'ACC2 Customer');
  const xyz = await createSupplier(acc1, 'XYZ Supplies');

  // ---- Test 1 — Customer credit ------------------------------------------
  console.log('\nSRS Test 1 — Customer Credit');
  const credit = await postFlow('/credit-sales', {
    depotId: acc1, transactionDate: D.t1, amount: 500000,
    customerId: abc.id, reference: 'ACC-T1',
  });
  if (credit.entered_by_name && credit.entry_date && credit.entry_time) {
    pass(`stamped user "${credit.entered_by_name}" date ${credit.entry_date} time ${credit.entry_time}`);
  } else {
    fail('audit stamps missing', JSON.stringify({ by: credit.entered_by_name, d: credit.entry_date, t: credit.entry_time }));
  }
  const c1 = await api('GET', `/customers/${abc.id}`);
  num(c1.json?.account?.balance) === 500000
    ? pass('ABC Traders outstanding credit is ₦500,000')
    : fail('balance wrong', `got ${c1.json?.account?.balance}`);

  // ---- Test 2 — Customer payment -----------------------------------------
  console.log('\nSRS Test 2 — Customer Payment');
  await postFlow('/customer-payments', {
    depotId: acc1, transactionDate: D.t2, amount: 200000,
    customerId: abc.id, paymentMethod: 'Cash', reference: 'ACC-T2',
  });
  const c2 = await api('GET', `/customers/${abc.id}`);
  num(c2.json?.account?.balance) === 300000
    ? pass('outstanding credit = 500,000 − 200,000 = ₦300,000 (computed, never typed)')
    : fail('balance wrong', `got ${c2.json?.account?.balance}`);

  // ---- Test 3 — Supplier purchase ----------------------------------------
  console.log('\nSRS Test 3 — Supplier Purchase');
  await postFlow('/supplier-purchases', {
    depotId: acc1, transactionDate: D.t34, amount: 1000000,
    supplierId: xyz.id, purchaseType: 'credit', reference: 'ACC-T3',
  });
  const s3 = await api('GET', `/suppliers/${xyz.id}`);
  num(s3.json?.account?.balance) === 1000000
    ? pass('supplier account increased by ₦1,000,000')
    : fail('supplier balance wrong', `got ${s3.json?.account?.balance}`);

  // ---- Test 4 — Supplier payment -----------------------------------------
  console.log('\nSRS Test 4 — Supplier Payment');
  await postFlow('/supplier-payments', {
    depotId: acc1, transactionDate: D.t34, amount: 400000,
    supplierId: xyz.id, paymentMethod: 'Bank Transfer', reference: 'ACC-T4',
  });
  const s4 = await api('GET', `/suppliers/${xyz.id}`);
  num(s4.json?.account?.balance) === 600000
    ? pass('outstanding supplier debt = 1,000,000 − 400,000 = ₦600,000')
    : fail('supplier debt wrong', `got ${s4.json?.account?.balance}`);

  // ---- Test 5 — Depot sales ----------------------------------------------
  console.log('\nSRS Test 5 — Depot Sales');
  await postFlow('/cash-sales', { depotId: acc1, transactionDate: D.t5, amount: 500000, reference: 'ACC-T5-CASH' });
  await postFlow('/pos-sales', { depotId: acc1, transactionDate: D.t5, amount: 300000, reference: 'ACC-T5-POS' });
  await postFlow('/credit-sales', {
    depotId: acc1, transactionDate: D.t5, amount: 200000, customerId: abc.id, reference: 'ACC-T5-CREDIT',
  });
  const d5 = await api('GET', `/dashboard/depot?depotId=${acc1}&from=${D.t5}&to=${D.t5}`);
  num(d5.json?.metrics?.total_sales) === 1000000
    ? pass('Total Depot Sales = 500,000 + 300,000 + 200,000 = ₦1,000,000')
    : fail('total sales wrong', `got ${d5.json?.metrics?.total_sales}`);

  // ---- Test 6 — Depot operating balance ----------------------------------
  console.log('\nSRS Test 6 — Depot Operating Balance');
  await postFlow('/supplier-purchases', {
    depotId: acc2, transactionDate: D.t6, amount: 1500000,
    supplierId: (await createSupplier(acc2, 'ACC2 Supplier')).id, purchaseType: 'credit', reference: 'ACC-T6-PUR',
  });
  await postFlow('/cash-sales', { depotId: acc2, transactionDate: D.t6, amount: 500000, reference: 'ACC-T6-CASH' });
  await postFlow('/pos-sales', { depotId: acc2, transactionDate: D.t6, amount: 300000, reference: 'ACC-T6-POS' });
  await postFlow('/credit-sales', {
    depotId: acc2, transactionDate: D.t6, amount: 200000, customerId: acc2Customer.id, reference: 'ACC-T6-CREDIT',
  });
  const d6 = await api('GET', `/dashboard/depot?depotId=${acc2}&from=${D.t6}&to=${D.t6}`);
  num(d6.json?.metrics?.operating_balance) === 5500000
    ? pass('Operating Balance = 5,000,000 + 1,500,000 − 1,000,000 = ₦5,500,000')
    : fail('operating balance wrong', `got ${d6.json?.metrics?.operating_balance}`);
  num(d6.json?.metrics?.previous_operating_balance) === 5000000
    ? pass('previous balance shown correctly as ₦5,000,000')
    : fail('previous balance wrong', `got ${d6.json?.metrics?.previous_operating_balance}`);

  // ---- Test 7 — Stock value ----------------------------------------------
  console.log('\nSRS Test 7 — Stock Value');
  const stock = await postFlow('/stock-value', {
    depotId: acc1, transactionDate: D.t7, stockValue: 10000000, reference: 'ACC-T7',
  });
  const stampsOk = stock.stock_value !== undefined && stock.depot_code && stock.transaction_date
    && stock.entry_date && stock.entry_time && stock.entered_by_name;
  stampsOk
    ? pass('saved value, depot, transaction date, entry date, entry time and user')
    : fail('stock record incomplete', JSON.stringify(stock));
  num(stock.stock_value) === 10000000
    ? pass('stock value ₦10,000,000 recorded')
    : fail('stock value wrong', `got ${stock.stock_value}`);

  // ---- Test 8 — Stock correction -----------------------------------------
  console.log('\nSRS Test 8 — Stock Correction');
  const corr = await api('PUT', `/stock-value/${stock.id}`, {
    stockValue: 10500000, reason: 'Recount after stock take',
  });
  num(corr.json?.item?.stock_value) === 10500000
    ? pass('corrected value ₦10,500,000 in effect')
    : fail('correction not applied', `got ${corr.json?.item?.stock_value}`);
  const hist = await api('GET', `/stock-value/${stock.id}/history`);
  const creationRow = (hist.json?.history ?? []).find((h) => h.action === 'creation');
  const correctionRow = (hist.json?.history ?? []).find((h) => h.action === 'correction');
  creationRow && num(creationRow.new_value) === 10000000 && correctionRow && num(correctionRow.original_value) === 10000000
    ? pass('original ₦10,000,000 remains available in history')
    : fail('history incomplete', JSON.stringify(hist.json?.history));

  // ---- Test 9 — Date filter ----------------------------------------------
  console.log('\nSRS Test 9 — Date Filter');
  await postFlow('/cash-sales', { depotId: acc1, transactionDate: D.inside, amount: 150000, reference: 'ACC-T9-INSIDE' });
  await postFlow('/cash-sales', { depotId: acc1, transactionDate: D.outside, amount: 150000, reference: 'ACC-T9-OUTSIDE' });
  const filtered = await api('GET', `/cash-sales?depotId=${acc1}&from=2026-09-01&to=2026-09-15&pageSize=200`);
  const items = filtered.json?.items ?? [];
  const refs = items.map((i) => i.reference);
  const allInside = items.every((i) => i.transaction_date >= '2026-09-01' && i.transaction_date <= '2026-09-15');
  allInside && refs.includes('ACC-T9-INSIDE') && !refs.includes('ACC-T9-OUTSIDE')
    ? pass('only transactions within 01/09/2026–15/09/2026 are returned')
    : fail('date filter wrong', `refs=${JSON.stringify(refs)}`);

  // ---- Test 10 — Global dashboard ----------------------------------------
  console.log('\nSRS Test 10 — Global Dashboard');
  const runner = await api('POST', '/users', {
    username: RUNNER_USER, fullName: 'Acceptance Runner', password: RUNNER_PASS,
    roleKey: 'admin', depotIds: [accX, accY, accZ],
  });
  if (runner.status !== 201) throw new Error(`runner setup failed: ${JSON.stringify(runner.json)}`);
  const grant = await api('PUT', `/users/${runner.json.user.id}/permissions`, {
    grants: [{ pageKey: 'dashboard_global', view: true }],
  });
  if (grant.status !== 200) throw new Error(`runner grants failed: ${JSON.stringify(grant.json)}`);

  const runnerLogin = await api('POST', '/auth/login',
    { username: RUNNER_USER, password: RUNNER_PASS }, { cookie: '' });
  if (runnerLogin.status !== 200) throw new Error('runner login failed');
  // The api() helper captured the runner's cookie — the next call uses it.
  const g10 = await api('GET', '/dashboard/global');
  const totals = g10.json?.totals;
  num(totals?.total_operating_balance) === 20000000
    ? pass('Total Operating Balance = 5m + 7m + 8m = ₦20,000,000')
    : fail('total operating balance wrong', `got ${totals?.total_operating_balance}`);
  (g10.json?.depots ?? []).length === 3
    ? pass('runner sees only the three assigned depots')
    : fail('depot scoping wrong', `sees ${g10.json?.depots?.length} depots`);

  console.log(`\n${failures === 0 ? 'ALL ACCEPTANCE TESTS PASSED' : `${failures} ACCEPTANCE CHECK(S) FAILED`}`);
  return failures;
}

let exitCode = 1;
try {
  const failed = await main();
  exitCode = failed === 0 ? 0 : 1;
} catch (err) {
  console.error('\nACCEPTANCE SUITE ERROR:', err.message);
  exitCode = 1;
} finally {
  try { await cleanup(); } catch (err) { console.error('[cleanup] failed:', err.message); }
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.end().catch(() => {});
  process.exit(exitCode);
}
