-- ---------------------------------------------------------------------------
-- 0005 — Role-level access control
--
-- The Super Admin configures, per role (each "category" of user):
--   * role_permissions     — which pages the category is activated for and
--                            which actions (view/input/edit/…) it may use;
--   * role_page_components — which components (cards, tables, buttons) of a
--                            page are visible and which ones accept input.
--
-- Per-user grants (user_permissions) continue to work as extra overrides on
-- top of the role defaults; the two sources are merged permissively.
-- Absence of a role_page_components row means "visible and input allowed".
-- ---------------------------------------------------------------------------

CREATE TABLE role_permissions (
  id               SERIAL PRIMARY KEY,
  role_id          INT  NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  page_key         TEXT NOT NULL REFERENCES permissions(page_key) ON DELETE CASCADE,
  can_view         BOOLEAN NOT NULL DEFAULT false,
  can_input        BOOLEAN NOT NULL DEFAULT false,
  can_edit         BOOLEAN NOT NULL DEFAULT false,
  can_view_history BOOLEAN NOT NULL DEFAULT false,
  can_export       BOOLEAN NOT NULL DEFAULT false,
  can_approve      BOOLEAN NOT NULL DEFAULT false,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (role_id, page_key)
);

CREATE TABLE role_page_components (
  id            SERIAL PRIMARY KEY,
  role_id       INT  NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  page_key      TEXT NOT NULL REFERENCES permissions(page_key) ON DELETE CASCADE,
  component_key TEXT NOT NULL,
  is_visible    BOOLEAN NOT NULL DEFAULT true,
  can_input     BOOLEAN NOT NULL DEFAULT true,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (role_id, page_key, component_key)
);
