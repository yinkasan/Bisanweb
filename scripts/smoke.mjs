/* Quick end-to-end smoke test against the deployed `api` edge function. Not
 * the acceptance suite — this proves login, permissions, and the write/read
 * paths work over bearer auth.
 * Run with: npm run smoke  (or: node scripts/smoke.mjs)
 * Env overrides: API_URL, SMOKE_USERNAME, SMOKE_PASSWORD.
 */
const BASE = process.env.API_URL ?? 'https://cayshvamuqdlhmkspjwq.supabase.co/functions/v1/api';
const USERNAME = process.env.SMOKE_USERNAME ?? 'superadmin';
const PASSWORD = process.env.SMOKE_PASSWORD ?? 'Admin@2026';
// Unique per run so the customer create never collides with a prior run's row
// (account names are unique per depot), keeping the whole script idempotent.
const RUN = Date.now().toString().slice(-6);

let token = '';

async function call(method, path, body, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token && !opts.noAuth) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty or non-JSON body */ }
  return { status: res.status, json, res };
}

function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
}

const health = await call('GET', '/health', null, { noAuth: true });
check('health', health.status === 200 && health.json?.ok === true);

const noToken = await call('GET', '/auth/me', null, { noAuth: true });
check('401 without a bearer token', noToken.status === 401 && noToken.json?.error?.message);

const badLogin = await call('POST', '/auth/login', { username: USERNAME, password: 'wrong' }, { noAuth: true });
check('login with wrong password rejected', badLogin.status === 401, `msg: ${badLogin.json?.error?.message}`);

const login = await call('POST', '/auth/login', { username: USERNAME, password: PASSWORD }, { noAuth: true });
token = login.json?.token ?? '';
check('login as superadmin', login.status === 200 && !!token, `status ${login.status}`);
check('superadmin has all depots', login.json?.user?.allDepots === true);
check('token is a 3-part JWT (interchangeable with mobile)', typeof token === 'string' && token.split('.').length === 3);
check('login delivers the session policy', typeof login.json?.policy?.sessionIdleMinutes === 'number');

const me = await call('GET', '/auth/me');
check('GET /auth/me via Bearer token', me.status === 200 && me.json?.user?.username === USERNAME);

const depots = await call('GET', '/depots');
check('GET /depots', depots.status === 200 && Array.isArray(depots.json?.depots), `${depots.json?.depots?.length} depots`);
const depotId = depots.json?.depots?.[0]?.id;

const roles = await call('GET', '/roles');
check('GET /roles', roles.status === 200 && roles.json?.roles?.length === 4);

const perms = await call('GET', '/roles/permissions');
check('GET /roles/permissions catalog', perms.status === 200 && perms.json?.permissions?.length >= 18);

const global = await call('GET', '/dashboard/global');
check('GET /dashboard/global', global.status === 200 && !!global.json?.totals);

const depotDash = await call('GET', `/dashboard/depot?depotId=${depotId}`);
check('GET /dashboard/depot', depotDash.status === 200 && !!depotDash.json?.metrics,
  `total_sales=${depotDash.json?.metrics?.total_sales}`);

// Create a customer, then a cash sale and a credit sale.
const cust = await call('POST', '/customers', {
  depotId, name: `Smoke Customer ${RUN}`, phone: '08000000000',
});
check('POST /customers', cust.status === 201 && !!cust.json?.account?.id, `code ${cust.json?.account?.code}`);

const today = new Date().toISOString().slice(0, 10);
const sale = await call('POST', '/cash-sales', {
  depotId, transactionDate: today, amount: 1234.5, reference: `SMOKE-${RUN}`,
});
check('POST /cash-sales', sale.status === 201 && !!sale.json?.item?.id,
  `entry ${sale.json?.item?.entry_date} ${sale.json?.item?.entry_time}`);

const correct = await call('PUT', `/cash-sales/${sale.json?.item?.id}`, {
  amount: 2222.22, reason: 'Smoke test correction',
});
check('PUT /cash-sales/:id (correction)', correct.status === 200 && Number(correct.json?.item?.amount) === 2222.22);

const credit = await call('POST', '/credit-sales', {
  depotId, transactionDate: today, amount: 5000, customerId: cust.json?.account?.id,
});
check('POST /credit-sales', credit.status === 201);

const ledger = await call('GET', `/customers/${cust.json?.account?.id}/ledger`);
check('GET customer ledger', ledger.status === 200 && Number(ledger.json?.account?.balance) === 5000,
  `balance=${ledger.json?.account?.balance}`);

const reports = await call('GET', '/reports');
check('GET /reports catalog', reports.status === 200 && reports.json?.reports?.length === 13);

const salesReport = await call('GET', `/reports/sales-by-depot?from=${today}&to=${today}`);
check('GET /reports/sales-by-depot', salesReport.status === 200 && Array.isArray(salesReport.json?.rows));

const csvRes = await fetch(`${BASE}/reports/sales-by-depot?from=${today}&to=${today}&format=csv`, {
  headers: { Authorization: `Bearer ${token}` },
});
const csvText = await csvRes.text();
check('CSV export downloads with bearer auth',
  csvRes.status === 200 && csvRes.headers.get('content-type')?.includes('text/csv') && csvText.includes('Depot'),
  `${csvText.split('\n')[0]}`);

const audit = await call('GET', '/audit-logs?search=CASH_SALE');
check('GET /audit-logs', audit.status === 200 && audit.json?.total >= 1, `${audit.json?.total} entries`);

const settings = await call('GET', '/settings');
check('GET /settings', settings.status === 200 && Array.isArray(settings.json?.settings));

const users = await call('GET', '/users');
check('GET /users', users.status === 200 && Array.isArray(users.json?.users));

// Reversal must keep the original row and flip its status.
const reverse = await call('POST', `/cash-sales/${sale.json?.item?.id}/reverse`, { reason: 'Smoke test reversal' });
check('POST cash-sale reverse', reverse.status === 200 && reverse.json?.item?.status === 'reversed');

const after = await call('GET', `/cash-sales/${sale.json?.item?.id}`);
check('reversed sale still readable', after.status === 200 && after.json?.item?.status === 'reversed');

// Reversed rows reject further edits — 409 with the shared error envelope.
const editReversed = await call('PUT', `/cash-sales/${sale.json?.item?.id}`, { amount: 1, reason: 'nope' });
check('reversed sale cannot be corrected', editReversed.status === 409 && editReversed.json?.error?.message);

console.log(process.exitCode ? '\nSMOKE TEST FAILED' : '\nSMOKE TEST PASSED');
