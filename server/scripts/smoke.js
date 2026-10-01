/* Quick end-to-end smoke test against the running API. Not the acceptance
 * suite — this just proves login, permissions, and the write/read paths work.
 * Run with: node scripts/smoke.js  (server must be running on :4000)
 */
import 'dotenv/config';

const BASE = `http://127.0.0.1:${process.env.PORT || 4000}/api`;
let cookie = '';

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  return { status: res.status, json };
}

function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
}

const health = await call('GET', '/health');
check('health', health.status === 200 && health.json?.ok === true);

const badLogin = await call('POST', '/auth/login', { username: 'superadmin', password: 'wrong' });
check('login with wrong password rejected', badLogin.status === 401);

const login = await call('POST', '/auth/login', {
  username: process.env.BOOTSTRAP_ADMIN_USERNAME || 'superadmin',
  password: process.env.BOOTSTRAP_ADMIN_PASSWORD || 'Admin@2026',
});
check('login as superadmin', login.status === 200 && !!cookie, `status ${login.status}`);
check('superadmin has all depots', login.json?.user?.allDepots === true);
check('login returns a bearer token for mobile clients', typeof login.json?.token === 'string' && login.json.token.split('.').length === 3);

// Mobile path: no cookies, just the Authorization header.
const bearerRes = await fetch(`${BASE}/auth/me`, {
  headers: { Authorization: `Bearer ${login.json.token}` },
});
const bearerMe = await bearerRes.json().catch(() => null);
check('GET /auth/me via Bearer token (mobile)', bearerRes.status === 200 && bearerMe?.user?.username === (process.env.BOOTSTRAP_ADMIN_USERNAME || 'superadmin'));

const me = await call('GET', '/auth/me');
check('GET /auth/me', me.status === 200 && me.json?.user?.username === (process.env.BOOTSTRAP_ADMIN_USERNAME || 'superadmin'));

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

// Create a customer, then a credit sale for them.
const cust = await call('POST', '/customers', {
  depotId, name: 'Smoke Test Customer', phone: '08000000000',
});
check('POST /customers', cust.status === 201 && !!cust.json?.account?.id, `code ${cust.json?.account?.code}`);

const today = new Date().toISOString().slice(0, 10);
const sale = await call('POST', '/cash-sales', {
  depotId, transactionDate: today, amount: 1234.5, reference: 'SMOKE-1',
});
check('POST /cash-sales', sale.status === 201 && !!sale.json?.item?.id,
  `entry ${sale.json?.item?.entry_date} ${sale.json?.item?.entry_time}`);

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

const audit = await call('GET', '/audit-logs?search=CASH_SALE');
check('GET /audit-logs', audit.status === 200 && audit.json?.total >= 1, `${audit.json?.total} entries`);

// Reversal must keep the original row and flip its status.
const reverse = await call('POST', `/cash-sales/${sale.json?.item?.id}/reverse`, { reason: 'Smoke test reversal' });
check('POST cash-sale reverse', reverse.status === 200 && reverse.json?.item?.status === 'reversed');

const after = await call('GET', `/cash-sales/${sale.json?.item?.id}`);
check('reversed sale still readable', after.status === 200 && after.json?.item?.status === 'reversed');

console.log(process.exitCode ? '\nSMOKE TEST FAILED' : '\nSMOKE TEST PASSED');
