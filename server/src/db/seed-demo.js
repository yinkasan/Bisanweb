/**
 * Demo seed — three demo users with different roles/depots/permissions, plus
 * two weeks of realistic transaction history so every dashboard, report and
 * audit page has something meaningful to show.
 *
 * Idempotent guard: does nothing if demo users already exist.
 * Fresh start: npm run db:reset -w server && npm run seed -w server && npm run seed:demo -w server
 *
 * All transactions go through the real financial service so audit stamps,
 * validations and notifications behave exactly like manual entry.
 */
import { pathToFileURL } from 'node:url';
import bcrypt from 'bcryptjs';
import { query, withTransaction, pool } from './pool.js';
import { loadUserContext } from '../services/accessService.js';
import { createFlow, FLOW_CONFIGS } from '../services/financialService.js';
import { logAudit } from '../middleware/audit.js';
import { serverStamps } from '../utils/stamps.js';

const PASSWORD = 'Demo@2026';
const DAYS_BACK = 12;

// ---------------------------------------------------------------------------
// Deterministic PRNG so repeated seeds look the same (mulberry32).
// ---------------------------------------------------------------------------
function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = makeRng(20260101);

const between = (min, max) => min + rng() * (max - min);
const amt = (n) => Number(n.toFixed(2));
const pick = (arr) => arr[Math.floor(rng() * arr.length)];
const dayISO = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() - offset);
  return d.toISOString().slice(0, 10);
};

// ---------------------------------------------------------------------------
// Permission grants per demo user (page -> actions).
// ---------------------------------------------------------------------------
const ADMIN_GRANTS = {
  dashboard_global: ['view'],
  dashboard_depot: ['view'],
  cash_sales: ['view', 'input', 'edit', 'view_history', 'export'],
  pos_sales: ['view', 'input', 'edit', 'view_history', 'export'],
  credit_sales: ['view', 'input', 'edit', 'view_history', 'export'],
  customer_payments: ['view', 'input', 'edit', 'view_history', 'export'],
  customers: ['view', 'input', 'edit', 'view_history', 'export'],
  supplier_purchases: ['view', 'input', 'edit', 'view_history', 'export'],
  supplier_payments: ['view', 'input', 'edit', 'view_history', 'export'],
  suppliers: ['view', 'input', 'edit', 'view_history', 'export'],
  stock_balance: ['view', 'input', 'edit', 'view_history', 'export'],
  depot_expenses: ['view', 'input', 'edit', 'view_history', 'export'],
  reports: ['view', 'export'],
  audit_trail: ['view'],
  notifications: ['view'],
  settings: ['view'],
};

const SALES_GRANTS = {
  dashboard_depot: ['view'],
  cash_sales: ['view', 'input'],
  pos_sales: ['view', 'input'],
  credit_sales: ['view', 'input'],
  customer_payments: ['view', 'input'],
  customers: ['view', 'input', 'view_history'],
  notifications: ['view'],
};

const STAFF_GRANTS = {
  dashboard_depot: ['view'],
  cash_sales: ['view', 'input'],
  pos_sales: ['view', 'input'],
  stock_balance: ['view', 'input'],
  depot_expenses: ['view', 'input'],
  notifications: ['view'],
};

const DEMO_USERS = [
  { username: 'admin', fullName: 'Amina Bello', roleKey: 'admin', depotCodes: ['ABU', 'BIS'], grants: ADMIN_GRANTS },
  { username: 'sales1', fullName: 'Tunde Okafor', roleKey: 'sales_rep', depotCodes: ['ABU'], grants: SALES_GRANTS },
  { username: 'staff1', fullName: 'Grace Peters', roleKey: 'staff', depotCodes: ['ABU'], grants: STAFF_GRANTS },
];

const DEPOT_OPENINGS = {
  ABU: { operating: 5000000, cash: 500000 },
  BIS: { operating: 3000000, cash: 300000 },
};

const CUSTOMERS = {
  ABU: ['Alhaji Musa Ventures', 'Chidinma Stores', 'Emeka & Sons Ltd', 'Fatima General Merchandise', 'Golden Crown Supermarket'],
  BIS: ['Bello Traders', 'Ngozi Provisions', 'Sunshine Kiosks', 'Uche Distributors', 'Zenith Retail Hub'],
};

const SUPPLIERS = {
  ABU: ['Mainland Cement Ltd', 'Northgate Beverages Plc', 'Pacific Packaging Co'],
  BIS: ['Delta Foods Ltd', 'Eastern Textiles Ltd', 'Rockfield Chemicals Ltd', 'Summit Hardware Ltd'],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function ensureDemoUsers(adminId) {
  const userIds = {};
  for (const u of DEMO_USERS) {
    const hash = await bcrypt.hash(PASSWORD, 10);
    const res = await withTransaction(async (client) => {
      const ins = await client.query(
        `INSERT INTO users (username, full_name, email, password_hash, all_depots, created_by, updated_by)
         VALUES ($1, $2, $3, $4, false, $5, $5) RETURNING id`,
        [u.username, u.fullName, `${u.username}@demo.local`, hash, adminId]
      );
      const id = ins.rows[0].id;
      await client.query(
        `INSERT INTO user_roles (user_id, role_id, assigned_by)
         SELECT $1, r.id, $2 FROM roles r WHERE r.key = $3`,
        [id, adminId, u.roleKey]
      );
      for (const code of u.depotCodes) {
        await client.query(
          `INSERT INTO user_depot_assignments (user_id, depot_id, assigned_by)
           SELECT $1, d.id, $2 FROM depots d WHERE d.code = $3`,
          [id, adminId, code]
        );
      }
      for (const [pageKey, actions] of Object.entries(u.grants)) {
        await client.query(
          `INSERT INTO user_permissions
             (user_id, page_key, can_view, can_input, can_edit, can_view_history, can_export, can_approve, granted_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, false, $8)`,
          [
            id, pageKey,
            actions.includes('view'), actions.includes('input'), actions.includes('edit'),
            actions.includes('view_history'), actions.includes('export'), adminId,
          ]
        );
      }
      await logAudit({
        executor: client, actor: { id: adminId, fullName: 'System Administrator', roleName: 'Super Admin' },
        action: 'CREATE', entityType: 'user', entityId: id,
        description: `Created demo user ${u.username} (${u.roleKey})`,
        newValue: { username: u.username, role: u.roleKey, depots: u.depotCodes },
      });
      return id;
    });
    userIds[u.username] = res;
    console.log(`[seed:demo] user ${u.username} (${u.roleKey}) ready`);
  }
  return userIds;
}

async function ensureAccounts(kind) {
  const isCustomer = kind === 'customers';
  const table = isCustomer ? 'customers' : 'suppliers';
  const map = isCustomer ? CUSTOMERS : SUPPLIERS;
  const byDepot = {};
  for (const [code, names] of Object.entries(map)) {
    byDepot[code] = [];
    for (const name of names) {
      const { rows } = await query(
        `INSERT INTO ${table} (depot_id, name, phone, address, created_by_name, updated_by)
         SELECT d.id, $1, $2, $3, 'System Administrator', NULL FROM depots d WHERE d.code = $4
         RETURNING id, code`,
        [name, `080${Math.floor(between(10000000, 99999999))}`, `${code} Market Road`, code]
      );
      byDepot[code].push(rows[0]);
    }
  }
  console.log(`[seed:demo] ${Object.values(byDepot).flat().length} ${table} ready`);
  return byDepot;
}

async function updateOpeningSettings() {
  for (const [code, o] of Object.entries(DEPOT_OPENINGS)) {
    await query(
      `UPDATE depot_settings SET opening_balance_date = make_date(2026,1,1),
              opening_operating_balance = $1, opening_cash_at_hand = $2
        WHERE depot_id = (SELECT id FROM depots WHERE code = $3)`,
      [o.operating, o.cash, code]
    );
  }
  await query(`UPDATE system_settings SET value = '2500000' WHERE key = 'cash_at_bank'`);
  console.log('[seed:demo] opening balances + cash at bank set');
}

async function createStockRecord(ctx, depotId, date, stockValue) {
  const stamps = serverStamps();
  await withTransaction(async (client) => {
    const ins = await client.query(
      `INSERT INTO stock_value_records
         (company_id, depot_id, transaction_date, stock_value, entry_date, entry_time,
          entered_by, entered_by_name, entered_by_role)
       VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [depotId, date, stockValue, stamps.entryDate, stamps.entryTime,
        ctx.id, ctx.fullName, ctx.roleName]
    );
    await client.query(
      `INSERT INTO stock_value_history (stock_value_record_id, action, new_value, changed_by, changed_by_name)
       VALUES ($1, 'creation', $2, $3, $4)`,
      [ins.rows[0].id, stockValue, ctx.id, ctx.fullName]
    );
    await logAudit({
      executor: client, actor: ctx,
      action: 'CREATE', entityType: 'stock_value', entityId: ins.rows[0].id,
      description: `Recorded stock value of ${stockValue} for ${date}`,
      newValue: { depotId, transactionDate: date, stockValue },
    });
  });
}

// ---------------------------------------------------------------------------
// Transaction history generation
// ---------------------------------------------------------------------------
async function generateHistory(contexts, customers, suppliers) {
  const depotIds = {};
  for (const code of ['ABU', 'BIS']) {
    const { rows } = await query('SELECT id FROM depots WHERE code = $1', [code]);
    depotIds[code] = rows[0].id;
  }

  // Who enters what, per depot.
  const operatorFor = (code, kind) => {
    if (code === 'ABU' && ['cash_sale', 'pos_sale', 'credit_sale', 'customer_payment'].includes(kind)) return contexts.sales1;
    if (code === 'ABU' && ['expense', 'stock'].includes(kind)) return contexts.staff1;
    return contexts.admin;
  };

  let counts = { cash: 0, pos: 0, credit: 0, payments: 0, purchases: 0, supPay: 0, expenses: 0, stock: 0 };

  for (const code of ['ABU', 'BIS']) {
    const depotId = depotIds[code];
    const scale = code === 'ABU' ? 1 : 0.8;
    const depotCustomers = customers[code];
    const depotSuppliers = suppliers[code];
    const trailingSales = []; // most recent 2 daily sales totals
    let lastPurchase = 0;

    for (let back = DAYS_BACK - 1; back >= 0; back -= 1) {
      const date = dayISO(back);

      // Daily cash + POS sales
      const salesCtx = operatorFor(code, 'cash_sale');
      const cashAmount = amt(between(700000, 1500000) * scale);
      await createFlow(FLOW_CONFIGS.cash_sales, salesCtx, {
        depotId, transactionDate: date, amount: cashAmount,
        reference: `CS-${code}-${date}`,
      }, null);
      counts.cash += 1;
      const posAmount = amt(between(300000, 900000) * scale);
      await createFlow(FLOW_CONFIGS.pos_sales, salesCtx, {
        depotId, transactionDate: date, amount: posAmount,
        reference: `POS-${code}-${date}`,
      }, null);
      counts.pos += 1;

      // 1–2 credit sales to random customers
      let creditTotal = 0;
      const creditCount = rng() < 0.45 ? 2 : 1;
      for (let i = 0; i < creditCount; i += 1) {
        const customer = pick(depotCustomers);
        const creditAmount = amt(between(200000, 800000) * scale);
        await createFlow(FLOW_CONFIGS.credit_sales, operatorFor(code, 'credit_sale'), {
          depotId, transactionDate: date, amount: creditAmount,
          customerId: customer.id, reference: `CR-${code}-${date}-${i + 1}`,
        }, null);
        creditTotal += creditAmount;
        counts.credit += 1;
      }

      // Rolling 2-day sales window drives purchase/payment sizing below.
      trailingSales.unshift(cashAmount + posAmount + creditTotal);
      if (trailingSales.length > 2) trailingSales.pop();

      // Customer payments most days — keeps debts meaningful but settled.
      if (rng() < 0.75) {
        const customer = pick(depotCustomers);
        await createFlow(FLOW_CONFIGS.customer_payments, operatorFor(code, 'customer_payment'), {
          depotId, transactionDate: date, amount: amt(between(300000, 750000) * scale),
          customerId: customer.id, paymentMethod: pick(['Cash', 'Bank Transfer', 'POS']),
          reference: `CP-${code}-${date}`,
        }, null);
        counts.payments += 1;
      }

      // Supplier purchases every ~2 days — sized from the trailing two-day
      // turnover so the operating balance stays realistic instead of drifting.
      if (back % 2 === 0) {
        const supplier = pick(depotSuppliers);
        const basis = trailingSales.reduce((a, b) => a + b, 0);
        lastPurchase = amt(basis * between(0.92, 1.04));
        await createFlow(FLOW_CONFIGS.supplier_purchases, operatorFor(code, 'purchase'), {
          depotId, transactionDate: date, amount: lastPurchase,
          supplierId: supplier.id, purchaseType: rng() < 0.8 ? 'credit' : 'cash',
          reference: `SP-${code}-${date}`,
        }, null);
        counts.purchases += 1;
      }

      // Supplier payments the day after each purchase cycle, paying most of it.
      if (back % 2 === 1 && lastPurchase > 0) {
        const supplier = pick(depotSuppliers);
        await createFlow(FLOW_CONFIGS.supplier_payments, operatorFor(code, 'supplier_payment'), {
          depotId, transactionDate: date, amount: amt(lastPurchase * between(0.55, 0.8)),
          supplierId: supplier.id, paymentMethod: pick(['Bank Transfer', 'Cash', 'Cheque']),
          reference: `PY-${code}-${date}`,
        }, null);
        counts.supPay += 1;
      }

      // Expenses most days
      if (rng() < 0.8) {
        const desc = pick(['Generator diesel', 'Delivery van fuel', 'Office supplies', 'Repairs', 'Security patrol']);
        await createFlow(FLOW_CONFIGS.depot_expenses, operatorFor(code, 'expense'), {
          depotId, transactionDate: date, amount: amt(between(10000, 80000) * scale),
          paymentMethod: pick(['Cash', 'Bank Transfer']),
          description: desc, reference: `EX-${code}-${date}`,
        }, null);
        counts.expenses += 1;
      }

      // Stock value snapshot every day
      await createStockRecord(operatorFor(code, 'stock'), depotId, date, amt(between(8000000, 15000000) * scale));
      counts.stock += 1;
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
export async function seedDemo() {
  const guard = await query(`SELECT id FROM users WHERE username = 'admin'`);
  if (guard.rowCount > 0) {
    console.log('[seed:demo] demo data already present — nothing to do.');
    console.log('[seed:demo] for a fresh demo: npm run db:reset -w server && npm run seed -w server && npm run seed:demo -w server');
    return;
  }

  const { rows: su } = await query(`SELECT id FROM users WHERE username = $1`, [
    process.env.BOOTSTRAP_ADMIN_USERNAME || 'superadmin',
  ]);
  const superAdminId = su[0]?.id;
  if (!superAdminId) throw new Error('Run the base seed first (npm run seed) — no Super Admin found');

  const userIds = await ensureDemoUsers(superAdminId);
  const customers = await ensureAccounts('customers');
  const suppliers = await ensureAccounts('suppliers');
  await updateOpeningSettings();

  const contexts = {
    admin: await loadUserContext(userIds.admin),
    sales1: await loadUserContext(userIds.sales1),
    staff1: await loadUserContext(userIds.staff1),
  };

  const counts = await generateHistory(contexts, customers, suppliers);

  console.log('[seed:demo] history created:');
  console.log(`  cash sales ${counts.cash}, pos sales ${counts.pos}, credit sales ${counts.credit}`);
  console.log(`  customer payments ${counts.payments}, purchases ${counts.purchases}, supplier payments ${counts.supPay}`);
  console.log(`  expenses ${counts.expenses}, stock records ${counts.stock}`);
  console.log('[seed:demo] done — demo logins (password Demo@2026):');
  console.log('  admin  (Admin, both depots) / sales1 (Sales Rep, ABU Depot) / staff1 (Staff, ABU Depot)');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  seedDemo()
    .then(() => pool.end())
    .catch((err) => {
      console.error('[seed:demo] failed:', err);
      process.exit(1);
    });
}
