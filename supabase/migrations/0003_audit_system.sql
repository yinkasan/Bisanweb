-- ============================================================================
-- 0003_audit_system.sql — audit trail, adjustments, notifications, settings
-- ============================================================================

CREATE TABLE audit_logs (
  id             BIGSERIAL PRIMARY KEY,
  user_id        INT REFERENCES users(id),
  user_name      TEXT,
  user_role      TEXT,
  action         TEXT NOT NULL,        -- LOGIN, LOGOUT, CREATE, UPDATE, REVERSE, ...
  entity_type    TEXT,                 -- user, customer, cash_sale, ...
  entity_id      TEXT,
  description    TEXT,
  previous_value JSONB,
  new_value      JSONB,
  ip_address     TEXT,
  user_agent     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_created_at_idx  ON audit_logs(created_at DESC);
CREATE INDEX audit_logs_entity_idx      ON audit_logs(entity_type, entity_id);
CREATE INDEX audit_logs_user_idx        ON audit_logs(user_id);

-- Field-level old -> new values for edits to master data and corrections.
CREATE TABLE adjustment_logs (
  id               BIGSERIAL PRIMARY KEY,
  entity_type      TEXT NOT NULL,
  entity_id        TEXT NOT NULL,
  field            TEXT,
  old_value        TEXT,
  new_value        TEXT,
  reason           TEXT,
  adjusted_by      INT NOT NULL REFERENCES users(id),
  adjusted_by_name TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX adjustment_logs_entity_idx ON adjustment_logs(entity_type, entity_id);

CREATE TABLE notifications (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INT REFERENCES users(id),   -- NULL = broadcast to all permitted users
  type        TEXT NOT NULL,              -- customer_debt, supplier_debt, approval, permission_change, system, transaction
  severity    TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warning','critical')),
  title       TEXT NOT NULL,
  message     TEXT,
  entity_type TEXT,
  entity_id   TEXT,
  is_read     BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx    ON notifications(user_id, is_read);
CREATE INDEX notifications_created_idx ON notifications(created_at DESC);

CREATE TABLE system_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  label      TEXT,
  type       TEXT NOT NULL DEFAULT 'string',  -- string | number | boolean
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by INT REFERENCES users(id)
);
