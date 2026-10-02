-- Baseline seed data for the Depot Manager database — the SQL translation of
-- the former server/src/db/seed.js. Idempotent: safe to run on every deploy
-- (`supabase db reset` applies it automatically; against a remote database run
-- it with `psql "$DATABASE_URL" -f supabase/seed.sql`).
--
-- The bootstrap Super Admin password is the bcrypt hash of Admin@2026 —
-- change it immediately after the first login.

BEGIN;

-- Company ---------------------------------------------------------------------
INSERT INTO companies (name, address, currency_code, currency_symbol)
SELECT 'Bisan Ventures', 'Head Office', 'NGN', '₦'
WHERE NOT EXISTS (SELECT 1 FROM companies);

-- Roles -----------------------------------------------------------------------
INSERT INTO roles (key, name, level, description) VALUES
  ('super_admin', 'Super Admin',          1, 'Full control: users, roles, permissions, all depots, all data.'),
  ('admin',       'Admin',                2, 'Performs the functions granted by the Super Admin.'),
  ('sales_rep',   'Sales Representative', 3, 'Sales entry and customer functions as granted.'),
  ('staff',       'Staff',                4, 'Selected pages and inputs as granted.')
ON CONFLICT (key) DO UPDATE
SET name = EXCLUDED.name, level = EXCLUDED.level, description = EXCLUDED.description;

-- Permission catalogue ----------------------------------------------------------
INSERT INTO permissions (page_key, page_name, section, sort_order) VALUES
  ('dashboard_global',   'Global Dashboard',      'Dashboards',     1),
  ('dashboard_depot',    'Depot Dashboard',       'Dashboards',     2),
  ('cash_sales',         'Cash Sales',            'Sales',          10),
  ('pos_sales',          'POS Sales',             'Sales',          11),
  ('credit_sales',       'Credit Sales',          'Sales',          12),
  ('customer_payments',  'Customer Payments',     'Customers',      20),
  ('customers',          'Customers / Debtors',   'Customers',      21),
  ('supplier_purchases', 'Supplier Purchases',    'Suppliers',      30),
  ('supplier_payments',  'Supplier Payments',     'Suppliers',      31),
  ('suppliers',          'Suppliers / Creditors', 'Suppliers',      32),
  ('stock_balance',      'Stock Balance',         'Operations',     40),
  ('depot_expenses',     'Depot Expenses',        'Operations',     41),
  ('reports',            'Reports',               'Insight',        60),
  ('audit_trail',        'Audit Trail',           'Insight',        61),
  ('notifications',      'Notifications',         'Insight',        62),
  ('users',              'Users',                 'Administration', 70),
  ('roles_permissions',  'Roles & Permissions',   'Administration', 71),
  ('settings',           'System Settings',       'Administration', 72)
ON CONFLICT (page_key) DO UPDATE
SET page_name = EXCLUDED.page_name, section = EXCLUDED.section, sort_order = EXCLUDED.sort_order;

-- Expense categories -------------------------------------------------------------
INSERT INTO expense_categories (name) VALUES
  ('Transport'), ('Electricity'), ('Rent'), ('Salaries & Wages'), ('Maintenance & Repairs'),
  ('Fuel & Diesel'), ('Security'), ('Water'), ('Communication'), ('Bank Charges'), ('Miscellaneous')
ON CONFLICT (name) DO NOTHING;

-- System settings ------------------------------------------------------------------
-- ON CONFLICT DO NOTHING guarantees values changed by the Super Admin (e.g. the
-- session idle window) are never reset by a later seed run.
INSERT INTO system_settings (key, value, label, type) VALUES
  ('cash_at_bank',                    '0',       'Cash at Bank (company)',                      'number'),
  ('customer_debt_alert_threshold',   '1000000', 'Customer debt alert threshold',               'number'),
  ('supplier_debt_alert_threshold',   '1000000', 'Supplier debt alert threshold',               'number'),
  ('notifications_enabled',           'true',    'Enable notifications',                        'boolean'),
  ('session_idle_minutes',            '2',       'Auto sign-out after inactivity (minutes)',    'minutes')
ON CONFLICT (key) DO NOTHING;

-- Depots (with opening settings) ------------------------------------------------------
INSERT INTO depots (code, name, location) VALUES
  ('ABU', 'ABU Depot', 'Main Branch'),
  ('BIS', 'Bisan Depot', 'Second Branch')
ON CONFLICT (code) DO NOTHING;

INSERT INTO depot_settings (depot_id, opening_balance_date, opening_operating_balance, opening_cash_at_hand)
SELECT d.id, make_date(2026, 1, 1), 0, 0
  FROM depots d
 WHERE d.code IN ('ABU', 'BIS')
   AND NOT EXISTS (SELECT 1 FROM depot_settings s WHERE s.depot_id = d.id);

-- Bootstrap Super Admin — only when there is no user at all. ---------------------------
INSERT INTO users (username, full_name, password_hash, all_depots)
SELECT 'superadmin', 'System Administrator',
       '$2a$10$by96ISD7blLU.0ywox8p7.mY7u2gjDOvNDCEjKH9DK7p4WKCZDDuq', true
WHERE NOT EXISTS (SELECT 1 FROM users);

INSERT INTO user_roles (user_id, role_id, assigned_by)
SELECT u.id, r.id, u.id
  FROM users u, roles r
 WHERE u.username = 'superadmin' AND r.key = 'super_admin'
   AND NOT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id);

COMMIT;
