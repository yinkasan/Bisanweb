-- ============================================================================
-- 0001_core.sql — company, users, roles, permissions, depots
-- ============================================================================

CREATE TABLE companies (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  address         TEXT,
  phone           TEXT,
  email           TEXT,
  currency_code   TEXT NOT NULL DEFAULT 'NGN',
  currency_symbol TEXT NOT NULL DEFAULT '₦',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Roles: exactly the four levels required by the SRS.
-- ---------------------------------------------------------------------------
CREATE TABLE roles (
  id          SERIAL PRIMARY KEY,
  key         TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  level       INT  NOT NULL,          -- 1 = highest (Super Admin)
  description TEXT
);

CREATE TABLE users (
  id            SERIAL PRIMARY KEY,
  company_id    INT NOT NULL DEFAULT 1 REFERENCES companies(id),
  username      TEXT NOT NULL UNIQUE,
  full_name     TEXT NOT NULL,
  email         TEXT,
  phone         TEXT,
  password_hash TEXT NOT NULL,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  all_depots    BOOLEAN NOT NULL DEFAULT false,   -- depot-level: "all depots"
  last_login_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    INT REFERENCES users(id),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    INT REFERENCES users(id)
);

-- One active role per user; role history is preserved in this table and in
-- role_change_logs. (SRS: user_roles table.)
CREATE TABLE user_roles (
  id          SERIAL PRIMARY KEY,
  user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id     INT NOT NULL REFERENCES roles(id),
  is_active   BOOLEAN NOT NULL DEFAULT true,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  assigned_by INT REFERENCES users(id)
);
CREATE UNIQUE INDEX user_roles_one_active_idx ON user_roles(user_id) WHERE is_active;

CREATE TABLE role_change_logs (
  id          SERIAL PRIMARY KEY,
  user_id     INT NOT NULL REFERENCES users(id),
  old_role_id INT REFERENCES roles(id),
  new_role_id INT REFERENCES roles(id),
  changed_by  INT REFERENCES users(id),
  reason      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Permissions: catalogue of pages + per-user page-level grants.
-- ---------------------------------------------------------------------------
CREATE TABLE permissions (
  id          SERIAL PRIMARY KEY,
  page_key    TEXT NOT NULL UNIQUE,
  page_name   TEXT NOT NULL,
  section     TEXT,
  description TEXT,
  sort_order  INT NOT NULL DEFAULT 0
);

CREATE TABLE user_permissions (
  id               SERIAL PRIMARY KEY,
  user_id          INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  page_key         TEXT NOT NULL REFERENCES permissions(page_key),
  can_view         BOOLEAN NOT NULL DEFAULT false,
  can_input        BOOLEAN NOT NULL DEFAULT false,
  can_edit         BOOLEAN NOT NULL DEFAULT false,
  can_view_history BOOLEAN NOT NULL DEFAULT false,
  can_export       BOOLEAN NOT NULL DEFAULT false,
  can_approve      BOOLEAN NOT NULL DEFAULT false,
  granted_by       INT REFERENCES users(id),
  granted_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, page_key)
);

-- ---------------------------------------------------------------------------
-- Depots
-- ---------------------------------------------------------------------------
CREATE TABLE depots (
  id           SERIAL PRIMARY KEY,
  company_id   INT NOT NULL DEFAULT 1 REFERENCES companies(id),
  code         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  location     TEXT,
  phone        TEXT,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   INT REFERENCES users(id),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by   INT REFERENCES users(id)
);

CREATE TABLE user_depot_assignments (
  id          SERIAL PRIMARY KEY,
  user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  depot_id    INT NOT NULL REFERENCES depots(id) ON DELETE CASCADE,
  assigned_by INT REFERENCES users(id),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, depot_id)
);

-- Per-depot opening configuration. The operating-balance chain starts at
-- opening_balance_date with opening_operating_balance (see depot_daily_balances).
CREATE TABLE depot_settings (
  depot_id                   INT PRIMARY KEY REFERENCES depots(id) ON DELETE CASCADE,
  opening_balance_date       DATE NOT NULL DEFAULT CURRENT_DATE,
  opening_operating_balance  NUMERIC(18,2) NOT NULL DEFAULT 0,
  opening_cash_at_hand       NUMERIC(18,2) NOT NULL DEFAULT 0,
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by                 INT REFERENCES users(id)
);
