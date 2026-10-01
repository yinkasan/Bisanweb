-- ---------------------------------------------------------------------------
-- 0006 — Customer and supplier names are unique
--
-- Every customer and supplier name must be unique across all depots,
-- compared case- and whitespace-insensitively (mirrors the API validation
-- in accounts.routes.js). The unique functional indexes are the last line
-- of defence against duplicates racing in through concurrent requests.
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS customers_name_unique
  ON customers (lower(btrim(name)));

CREATE UNIQUE INDEX IF NOT EXISTS suppliers_name_unique
  ON suppliers (lower(btrim(name)));
