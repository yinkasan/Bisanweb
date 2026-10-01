-- ============================================================================
-- 0002_financial.sql — all monetary transaction tables
--
-- Every financial table carries the SRS "core transaction structure":
--   company_id, depot_id, transaction_date, entry_date, entry_time,
--   entered_by (+name/role snapshot), status, reference, audit timestamps.
-- History is never deleted: rows are flipped to status='reversed' and the
-- reversal is recorded in transaction_reversals + audit_logs.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Sales
-- ---------------------------------------------------------------------------
CREATE TABLE cash_sales (
  id               SERIAL PRIMARY KEY,
  company_id       INT  NOT NULL DEFAULT 1 REFERENCES companies(id),
  depot_id         INT  NOT NULL REFERENCES depots(id),
  transaction_date DATE NOT NULL,
  amount           NUMERIC(18,2) NOT NULL CHECK (amount >= 0),
  reference        TEXT,
  notes            TEXT,
  status           TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','reversed')),
  approval_status  TEXT NOT NULL DEFAULT 'auto_approved',
  approved_by      INT REFERENCES users(id),
  approved_at      TIMESTAMPTZ,
  reversal_id      INT,
  entry_date       DATE NOT NULL,
  entry_time       TIME NOT NULL,
  entered_by       INT NOT NULL REFERENCES users(id),
  entered_by_name  TEXT NOT NULL,
  entered_by_role  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX cash_sales_depot_date_idx ON cash_sales(depot_id, transaction_date);
CREATE INDEX cash_sales_status_idx     ON cash_sales(status);

CREATE TABLE pos_sales (
  id               SERIAL PRIMARY KEY,
  company_id       INT  NOT NULL DEFAULT 1 REFERENCES companies(id),
  depot_id         INT  NOT NULL REFERENCES depots(id),
  transaction_date DATE NOT NULL,
  amount           NUMERIC(18,2) NOT NULL CHECK (amount >= 0),
  reference        TEXT,
  notes            TEXT,
  status           TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','reversed')),
  approval_status  TEXT NOT NULL DEFAULT 'auto_approved',
  approved_by      INT REFERENCES users(id),
  approved_at      TIMESTAMPTZ,
  reversal_id      INT,
  entry_date       DATE NOT NULL,
  entry_time       TIME NOT NULL,
  entered_by       INT NOT NULL REFERENCES users(id),
  entered_by_name  TEXT NOT NULL,
  entered_by_role  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX pos_sales_depot_date_idx ON pos_sales(depot_id, transaction_date);
CREATE INDEX pos_sales_status_idx     ON pos_sales(status);

-- ---------------------------------------------------------------------------
-- Customers / debtors
-- ---------------------------------------------------------------------------
CREATE TABLE customers (
  id           SERIAL PRIMARY KEY,
  company_id   INT NOT NULL DEFAULT 1 REFERENCES companies(id),
  depot_id     INT NOT NULL REFERENCES depots(id),
  code         TEXT GENERATED ALWAYS AS ('CUS-' || LPAD(id::text, 4, '0')) STORED UNIQUE,
  reference    TEXT,
  name         TEXT NOT NULL,
  phone        TEXT,
  address      TEXT,
  notes        TEXT,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   INT REFERENCES users(id),
  created_by_name TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by   INT REFERENCES users(id)
);
CREATE INDEX customers_depot_idx ON customers(depot_id);

-- Credit sales are always linked to a customer (no anonymous credit sales).
CREATE TABLE credit_sales (
  id               SERIAL PRIMARY KEY,
  company_id       INT  NOT NULL DEFAULT 1 REFERENCES companies(id),
  depot_id         INT  NOT NULL REFERENCES depots(id),
  customer_id      INT  NOT NULL REFERENCES customers(id),
  transaction_date DATE NOT NULL,
  amount           NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  reference        TEXT,
  notes            TEXT,
  status           TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','reversed')),
  approval_status  TEXT NOT NULL DEFAULT 'auto_approved',
  approved_by      INT REFERENCES users(id),
  approved_at      TIMESTAMPTZ,
  reversal_id      INT,
  entry_date       DATE NOT NULL,
  entry_time       TIME NOT NULL,
  entered_by       INT NOT NULL REFERENCES users(id),
  entered_by_name  TEXT NOT NULL,
  entered_by_role  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX credit_sales_depot_date_idx    ON credit_sales(depot_id, transaction_date);
CREATE INDEX credit_sales_customer_date_idx ON credit_sales(customer_id, transaction_date);
CREATE INDEX credit_sales_status_idx        ON credit_sales(status);

CREATE TABLE customer_payments (
  id               SERIAL PRIMARY KEY,
  company_id       INT  NOT NULL DEFAULT 1 REFERENCES companies(id),
  depot_id         INT  NOT NULL REFERENCES depots(id),
  customer_id      INT  NOT NULL REFERENCES customers(id),
  transaction_date DATE NOT NULL,
  amount           NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  payment_method   TEXT NOT NULL DEFAULT 'Cash',
  reference        TEXT,
  notes            TEXT,
  status           TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','reversed')),
  approval_status  TEXT NOT NULL DEFAULT 'auto_approved',
  approved_by      INT REFERENCES users(id),
  approved_at      TIMESTAMPTZ,
  reversal_id      INT,
  entry_date       DATE NOT NULL,
  entry_time       TIME NOT NULL,
  entered_by       INT NOT NULL REFERENCES users(id),
  entered_by_name  TEXT NOT NULL,
  entered_by_role  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX customer_payments_depot_date_idx    ON customer_payments(depot_id, transaction_date);
CREATE INDEX customer_payments_customer_date_idx ON customer_payments(customer_id, transaction_date);
CREATE INDEX customer_payments_status_idx        ON customer_payments(status);

-- ---------------------------------------------------------------------------
-- Suppliers / creditors
-- ---------------------------------------------------------------------------
CREATE TABLE suppliers (
  id           SERIAL PRIMARY KEY,
  company_id   INT NOT NULL DEFAULT 1 REFERENCES companies(id),
  depot_id     INT NOT NULL REFERENCES depots(id),
  code         TEXT GENERATED ALWAYS AS ('SUP-' || LPAD(id::text, 4, '0')) STORED UNIQUE,
  reference    TEXT,
  name         TEXT NOT NULL,
  phone        TEXT,
  address      TEXT,
  notes        TEXT,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   INT REFERENCES users(id),
  created_by_name TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by   INT REFERENCES users(id)
);
CREATE INDEX suppliers_depot_idx ON suppliers(depot_id);

CREATE TABLE supplier_purchases (
  id               SERIAL PRIMARY KEY,
  company_id       INT  NOT NULL DEFAULT 1 REFERENCES companies(id),
  depot_id         INT  NOT NULL REFERENCES depots(id),
  supplier_id      INT  NOT NULL REFERENCES suppliers(id),
  transaction_date DATE NOT NULL,
  amount           NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  purchase_type    TEXT NOT NULL DEFAULT 'credit' CHECK (purchase_type IN ('credit','cash')),
  reference        TEXT,
  notes            TEXT,
  status           TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','reversed')),
  approval_status  TEXT NOT NULL DEFAULT 'auto_approved',
  approved_by      INT REFERENCES users(id),
  approved_at      TIMESTAMPTZ,
  reversal_id      INT,
  entry_date       DATE NOT NULL,
  entry_time       TIME NOT NULL,
  entered_by       INT NOT NULL REFERENCES users(id),
  entered_by_name  TEXT NOT NULL,
  entered_by_role  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX supplier_purchases_depot_date_idx    ON supplier_purchases(depot_id, transaction_date);
CREATE INDEX supplier_purchases_supplier_date_idx ON supplier_purchases(supplier_id, transaction_date);
CREATE INDEX supplier_purchases_status_idx        ON supplier_purchases(status);

CREATE TABLE supplier_payments (
  id               SERIAL PRIMARY KEY,
  company_id       INT  NOT NULL DEFAULT 1 REFERENCES companies(id),
  depot_id         INT  NOT NULL REFERENCES depots(id),
  supplier_id      INT  NOT NULL REFERENCES suppliers(id),
  transaction_date DATE NOT NULL,
  amount           NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  payment_method   TEXT NOT NULL DEFAULT 'Cash',
  reference        TEXT,
  notes            TEXT,
  status           TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','reversed')),
  approval_status  TEXT NOT NULL DEFAULT 'auto_approved',
  approved_by      INT REFERENCES users(id),
  approved_at      TIMESTAMPTZ,
  reversal_id      INT,
  entry_date       DATE NOT NULL,
  entry_time       TIME NOT NULL,
  entered_by       INT NOT NULL REFERENCES users(id),
  entered_by_name  TEXT NOT NULL,
  entered_by_role  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX supplier_payments_depot_date_idx    ON supplier_payments(depot_id, transaction_date);
CREATE INDEX supplier_payments_supplier_date_idx ON supplier_payments(supplier_id, transaction_date);
CREATE INDEX supplier_payments_status_idx        ON supplier_payments(status);

-- ---------------------------------------------------------------------------
-- Stock value (monetary only — no products, no quantities)
-- ---------------------------------------------------------------------------
CREATE TABLE stock_value_records (
  id               SERIAL PRIMARY KEY,
  company_id       INT  NOT NULL DEFAULT 1 REFERENCES companies(id),
  depot_id         INT  NOT NULL REFERENCES depots(id),
  transaction_date DATE NOT NULL,
  stock_value      NUMERIC(18,2) NOT NULL CHECK (stock_value >= 0),
  reference        TEXT,
  notes            TEXT,
  status           TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','reversed')),
  reversal_id      INT,
  entry_date       DATE NOT NULL,
  entry_time       TIME NOT NULL,
  entered_by       INT NOT NULL REFERENCES users(id),
  entered_by_name  TEXT NOT NULL,
  entered_by_role  TEXT,
  last_updated_by  INT REFERENCES users(id),
  last_updated_by_name TEXT,
  last_updated_at  TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One active stock value per depot per day; corrections update the record and
-- write to stock_value_history (originals are never deleted).
CREATE UNIQUE INDEX stock_value_one_per_day_idx
  ON stock_value_records(depot_id, transaction_date) WHERE status = 'posted';
CREATE INDEX stock_value_depot_date_idx ON stock_value_records(depot_id, transaction_date);

CREATE TABLE stock_value_history (
  id                    SERIAL PRIMARY KEY,
  stock_value_record_id INT NOT NULL REFERENCES stock_value_records(id),
  action                TEXT NOT NULL DEFAULT 'correction' CHECK (action IN ('creation','correction')),
  original_value        NUMERIC(18,2),
  new_value             NUMERIC(18,2) NOT NULL,
  reason                TEXT,
  changed_by            INT NOT NULL REFERENCES users(id),
  changed_by_name       TEXT NOT NULL,
  changed_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX stock_value_history_record_idx ON stock_value_history(stock_value_record_id);

-- ---------------------------------------------------------------------------
-- Depot expenses
-- ---------------------------------------------------------------------------
CREATE TABLE expense_categories (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  is_active  BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE depot_expenses (
  id               SERIAL PRIMARY KEY,
  company_id       INT  NOT NULL DEFAULT 1 REFERENCES companies(id),
  depot_id         INT  NOT NULL REFERENCES depots(id),
  category_id      INT REFERENCES expense_categories(id),
  description      TEXT NOT NULL,
  amount           NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  payment_method   TEXT NOT NULL DEFAULT 'Cash',
  transaction_date DATE NOT NULL,
  reference        TEXT,
  notes            TEXT,
  status           TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','reversed')),
  approval_status  TEXT NOT NULL DEFAULT 'auto_approved',
  approved_by      INT REFERENCES users(id),
  approved_at      TIMESTAMPTZ,
  reversal_id      INT,
  entry_date       DATE NOT NULL,
  entry_time       TIME NOT NULL,
  entered_by       INT NOT NULL REFERENCES users(id),
  entered_by_name  TEXT NOT NULL,
  entered_by_role  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX depot_expenses_depot_date_idx ON depot_expenses(depot_id, transaction_date);
CREATE INDEX depot_expenses_category_idx   ON depot_expenses(category_id);
CREATE INDEX depot_expenses_status_idx     ON depot_expenses(status);

-- ---------------------------------------------------------------------------
-- Reversals / adjustments — originals stay in place, marked 'reversed'.
-- ---------------------------------------------------------------------------
CREATE TABLE transaction_reversals (
  id                       SERIAL PRIMARY KEY,
  transaction_type         TEXT NOT NULL CHECK (transaction_type IN (
                             'cash_sale','pos_sale','credit_sale','customer_payment',
                             'supplier_purchase','supplier_payment','depot_expense','stock_value')),
  transaction_id           INT  NOT NULL,
  action                   TEXT NOT NULL CHECK (action IN ('reversal','adjustment')),
  amount                   NUMERIC(18,2),
  depot_id                 INT REFERENCES depots(id),
  reason                   TEXT NOT NULL,
  replacement_transaction_id INT,
  performed_by             INT NOT NULL REFERENCES users(id),
  performed_by_name        TEXT NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX transaction_reversals_type_idx ON transaction_reversals(transaction_type, transaction_id);

ALTER TABLE cash_sales         ADD CONSTRAINT cash_sales_reversal_fk         FOREIGN KEY (reversal_id) REFERENCES transaction_reversals(id);
ALTER TABLE pos_sales          ADD CONSTRAINT pos_sales_reversal_fk          FOREIGN KEY (reversal_id) REFERENCES transaction_reversals(id);
ALTER TABLE credit_sales       ADD CONSTRAINT credit_sales_reversal_fk       FOREIGN KEY (reversal_id) REFERENCES transaction_reversals(id);
ALTER TABLE customer_payments  ADD CONSTRAINT customer_payments_reversal_fk  FOREIGN KEY (reversal_id) REFERENCES transaction_reversals(id);
ALTER TABLE supplier_purchases ADD CONSTRAINT supplier_purchases_reversal_fk FOREIGN KEY (reversal_id) REFERENCES transaction_reversals(id);
ALTER TABLE supplier_payments  ADD CONSTRAINT supplier_payments_reversal_fk  FOREIGN KEY (reversal_id) REFERENCES transaction_reversals(id);
ALTER TABLE depot_expenses     ADD CONSTRAINT depot_expenses_reversal_fk     FOREIGN KEY (reversal_id) REFERENCES transaction_reversals(id);
ALTER TABLE stock_value_records ADD CONSTRAINT stock_value_reversal_fk       FOREIGN KEY (reversal_id) REFERENCES transaction_reversals(id);
