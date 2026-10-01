import { pathToFileURL } from 'node:url';
import bcrypt from 'bcryptjs';
import { pool, withTransaction } from './pool.js';
import { config } from '../config.js';

// ---------------------------------------------------------------------------
// Static catalogues
// ---------------------------------------------------------------------------

export const ROLE_SEED = [
  { key: 'super_admin', name: 'Super Admin', level: 1, description: 'Full control: users, roles, permissions, all depots, all data.' },
  { key: 'admin', name: 'Admin', level: 2, description: 'Performs the functions granted by the Super Admin.' },
  { key: 'sales_rep', name: 'Sales Representative', level: 3, description: 'Sales entry and customer functions as granted.' },
  { key: 'staff', name: 'Staff', level: 4, description: 'Selected pages and inputs as granted.' },
];

export const PERMISSION_SEED = [
  { page_key: 'dashboard_global',   page_name: 'Global Dashboard',      section: 'Dashboards',     sort_order: 1 },
  { page_key: 'dashboard_depot',    page_name: 'Depot Dashboard',       section: 'Dashboards',     sort_order: 2 },
  { page_key: 'cash_sales',         page_name: 'Cash Sales',            section: 'Sales',          sort_order: 10 },
  { page_key: 'pos_sales',          page_name: 'POS Sales',             section: 'Sales',          sort_order: 11 },
  { page_key: 'credit_sales',       page_name: 'Credit Sales',          section: 'Sales',          sort_order: 12 },
  { page_key: 'customer_payments',  page_name: 'Customer Payments',     section: 'Customers',      sort_order: 20 },
  { page_key: 'customers',          page_name: 'Customers / Debtors',   section: 'Customers',      sort_order: 21 },
  { page_key: 'supplier_purchases', page_name: 'Supplier Purchases',    section: 'Suppliers',      sort_order: 30 },
  { page_key: 'supplier_payments',  page_name: 'Supplier Payments',     section: 'Suppliers',      sort_order: 31 },
  { page_key: 'suppliers',          page_name: 'Suppliers / Creditors', section: 'Suppliers',      sort_order: 32 },
  { page_key: 'stock_balance',      page_name: 'Stock Balance',         section: 'Operations',     sort_order: 40 },
  { page_key: 'depot_expenses',     page_name: 'Depot Expenses',        section: 'Operations',     sort_order: 41 },
  { page_key: 'reports',            page_name: 'Reports',               section: 'Insight',        sort_order: 60 },
  { page_key: 'audit_trail',        page_name: 'Audit Trail',           section: 'Insight',        sort_order: 61 },
  { page_key: 'notifications',      page_name: 'Notifications',         section: 'Insight',        sort_order: 62 },
  { page_key: 'users',              page_name: 'Users',                 section: 'Administration', sort_order: 70 },
  { page_key: 'roles_permissions',  page_name: 'Roles & Permissions',   section: 'Administration', sort_order: 71 },
  { page_key: 'settings',           page_name: 'System Settings',       section: 'Administration', sort_order: 72 },
];

const EXPENSE_CATEGORY_SEED = [
  'Transport', 'Electricity', 'Rent', 'Salaries & Wages', 'Maintenance & Repairs',
  'Fuel & Diesel', 'Security', 'Water', 'Communication', 'Bank Charges', 'Miscellaneous',
];

const SETTINGS_SEED = [
  { key: 'cash_at_bank', label: 'Cash at Bank (company)', type: 'number', value: '0' },
  { key: 'customer_debt_alert_threshold', label: 'Customer debt alert threshold', type: 'number', value: '1000000' },
  { key: 'supplier_debt_alert_threshold', label: 'Supplier debt alert threshold', type: 'number', value: '1000000' },
  { key: 'notifications_enabled', label: 'Enable notifications', type: 'boolean', value: 'true' },
  // Session safety window read by the mobile app: how long an unattended,
  // signed-in device stays logged in. Only a settings:editor (Super Admin by
  // default) may change it, and ON CONFLICT DO NOTHING guarantees a value they
  // chose is never reset by a later boot/seed.
  { key: 'session_idle_minutes', label: 'Auto sign-out after inactivity (minutes)', type: 'minutes', value: '2' },
];

const DEPOT_SEED = [
  { code: 'ABU', name: 'ABU Depot', location: 'Main Branch' },
  { code: 'BIS', name: 'Bisan Depot', location: 'Second Branch' },
];

// ---------------------------------------------------------------------------
// Seeder — idempotent, safe to run on every boot.
// ---------------------------------------------------------------------------

export async function seed() {
  await withTransaction(async (client) => {
    // Company
    const company = await client.query('SELECT id FROM companies LIMIT 1');
    if (company.rowCount === 0) {
      await client.query(
        `INSERT INTO companies (name, address, currency_code, currency_symbol)
         VALUES ($1, $2, 'NGN', '₦')`,
        ['Bisan Ventures', 'Head Office']
      );
      console.log('[seed] created company');
    }

    // Roles
    for (const role of ROLE_SEED) {
      await client.query(
        `INSERT INTO roles (key, name, level, description)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, level = EXCLUDED.level,
           description = EXCLUDED.description`,
        [role.key, role.name, role.level, role.description]
      );
    }

    // Permission catalogue
    for (const p of PERMISSION_SEED) {
      await client.query(
        `INSERT INTO permissions (page_key, page_name, section, sort_order)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (page_key) DO UPDATE SET page_name = EXCLUDED.page_name,
           section = EXCLUDED.section, sort_order = EXCLUDED.sort_order`,
        [p.page_key, p.page_name, p.section, p.sort_order]
      );
    }

    // Expense categories
    for (const name of EXPENSE_CATEGORY_SEED) {
      await client.query(
        `INSERT INTO expense_categories (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`,
        [name]
      );
    }

    // System settings
    for (const s of SETTINGS_SEED) {
      await client.query(
        `INSERT INTO system_settings (key, value, label, type)
         VALUES ($1, $2, $3, $4) ON CONFLICT (key) DO NOTHING`,
        [s.key, s.value, s.label, s.type]
      );
    }

    // Depots
    for (const d of DEPOT_SEED) {
      const res = await client.query(
        `INSERT INTO depots (code, name, location) VALUES ($1, $2, $3)
         ON CONFLICT (code) DO NOTHING RETURNING id`,
        [d.code, d.name, d.location]
      );
      if (res.rowCount > 0) {
        await client.query(
          `INSERT INTO depot_settings (depot_id, opening_balance_date, opening_operating_balance, opening_cash_at_hand)
           VALUES ($1, make_date(2026, 1, 1), 0, 0)`,
          [res.rows[0].id]
        );
        console.log(`[seed] created depot ${d.code}`);
      }
    }

    // Bootstrap Super Admin — only when there is no user at all.
    const users = await client.query('SELECT COUNT(*)::int AS n FROM users');
    if (users.rows[0].n === 0) {
      const hash = await bcrypt.hash(config.bootstrapAdmin.password, 10);
      const u = await client.query(
        `INSERT INTO users (username, full_name, password_hash, all_depots)
         VALUES ($1, $2, $3, true) RETURNING id`,
        [config.bootstrapAdmin.username, config.bootstrapAdmin.fullName, hash]
      );
      const role = await client.query(`SELECT id FROM roles WHERE key = 'super_admin'`);
      await client.query(
        `INSERT INTO user_roles (user_id, role_id, assigned_by) VALUES ($1, $2, $1)`,
        [u.rows[0].id, role.rows[0].id]
      );
      console.log(
        `[seed] bootstrap Super Admin created — username: ${config.bootstrapAdmin.username}` +
        ` password: ${config.bootstrapAdmin.password}`
      );
      console.log('[seed] change this password after first login.');
    }
  });

  console.log('[seed] done');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  seed()
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
