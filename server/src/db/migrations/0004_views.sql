-- ============================================================================
-- 0004_views.sql — derived data: ledgers, daily balances, aliases
--
-- These are views (not tables) on purpose: every balance is calculated from
-- the underlying transactions, so nothing can drift out of sync and no
-- balance can be manually edited.
-- ============================================================================

-- SRS database list mentions customer_credit_sales; credit_sales itself is the
-- canonical table and this view keeps the name available.
CREATE VIEW customer_credit_sales AS
SELECT * FROM credit_sales;

-- ---------------------------------------------------------------------------
-- Customer ledger: credit sales increase the balance, payments reduce it.
-- ---------------------------------------------------------------------------
CREATE VIEW customer_account_ledger AS
WITH entries AS (
  SELECT
    cs.id            AS source_id,
    cs.customer_id,
    cs.depot_id,
    cs.transaction_date,
    cs.entry_date,
    cs.entry_time,
    'credit_sale'::text AS entry_type,
    'debit'::text       AS direction,
    cs.amount,
    cs.amount           AS signed_amount,
    cs.reference,
    cs.entered_by,
    cs.entered_by_name,
    cs.created_at
  FROM credit_sales cs
  WHERE cs.status = 'posted'
  UNION ALL
  SELECT
    cp.id,
    cp.customer_id,
    cp.depot_id,
    cp.transaction_date,
    cp.entry_date,
    cp.entry_time,
    'payment',
    'credit',
    cp.amount,
    -cp.amount,
    cp.reference,
    cp.entered_by,
    cp.entered_by_name,
    cp.created_at
  FROM customer_payments cp
  WHERE cp.status = 'posted'
)
SELECT
  e.*,
  SUM(e.signed_amount) OVER (
    PARTITION BY e.customer_id
    ORDER BY e.transaction_date, e.created_at, e.source_id
    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
  ) AS running_balance
FROM entries e;

-- ---------------------------------------------------------------------------
-- Supplier ledger: purchases increase the debt, payments reduce it.
-- ---------------------------------------------------------------------------
CREATE VIEW supplier_account_ledger AS
WITH entries AS (
  SELECT
    sp.id            AS source_id,
    sp.supplier_id,
    sp.depot_id,
    sp.transaction_date,
    sp.entry_date,
    sp.entry_time,
    'purchase'::text AS entry_type,
    'debit'::text    AS direction,
    sp.amount,
    sp.amount        AS signed_amount,
    sp.reference,
    sp.entered_by,
    sp.entered_by_name,
    sp.created_at
  FROM supplier_purchases sp
  WHERE sp.status = 'posted'
  UNION ALL
  SELECT
    spp.id,
    spp.supplier_id,
    spp.depot_id,
    spp.transaction_date,
    spp.entry_date,
    spp.entry_time,
    'payment',
    'credit',
    spp.amount,
    -spp.amount,
    spp.reference,
    spp.entered_by,
    spp.entered_by_name,
    spp.created_at
  FROM supplier_payments spp
  WHERE spp.status = 'posted'
)
SELECT
  e.*,
  SUM(e.signed_amount) OVER (
    PARTITION BY e.supplier_id
    ORDER BY e.transaction_date, e.created_at, e.source_id
    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
  ) AS running_balance
FROM entries e;

-- ---------------------------------------------------------------------------
-- Depot daily balances with the SRS operating-balance chain:
--
--   Operating Balance(day) = Opening Balance
--                          + Σ (Supplier Purchases − Total Sales) up to `day`
--
--   where Total Sales = Cash Sales + POS Sales + Credit Sales.
-- ---------------------------------------------------------------------------
CREATE VIEW depot_daily_balances AS
WITH entries AS (
  SELECT depot_id, transaction_date, 'cash_sales'::text AS kind, amount
    FROM cash_sales      WHERE status = 'posted'
  UNION ALL
  SELECT depot_id, transaction_date, 'pos_sales', amount
    FROM pos_sales       WHERE status = 'posted'
  UNION ALL
  SELECT depot_id, transaction_date, 'credit_sales', amount
    FROM credit_sales    WHERE status = 'posted'
  UNION ALL
  SELECT depot_id, transaction_date, 'supplier_purchases', amount
    FROM supplier_purchases WHERE status = 'posted'
  UNION ALL
  SELECT depot_id, transaction_date, 'supplier_payments', amount
    FROM supplier_payments  WHERE status = 'posted'
  UNION ALL
  SELECT depot_id, transaction_date, 'customer_payments', amount
    FROM customer_payments  WHERE status = 'posted'
  UNION ALL
  SELECT depot_id, transaction_date, 'expenses', amount
    FROM depot_expenses     WHERE status = 'posted'
),
pivoted AS (
  SELECT
    depot_id,
    transaction_date,
    COALESCE(SUM(amount) FILTER (WHERE kind = 'cash_sales'), 0)         AS cash_sales,
    COALESCE(SUM(amount) FILTER (WHERE kind = 'pos_sales'), 0)          AS pos_sales,
    COALESCE(SUM(amount) FILTER (WHERE kind = 'credit_sales'), 0)       AS credit_sales,
    COALESCE(SUM(amount) FILTER (WHERE kind = 'supplier_purchases'), 0) AS supplier_purchases,
    COALESCE(SUM(amount) FILTER (WHERE kind = 'supplier_payments'), 0)  AS supplier_payments,
    COALESCE(SUM(amount) FILTER (WHERE kind = 'customer_payments'), 0)  AS customer_payments,
    COALESCE(SUM(amount) FILTER (WHERE kind = 'expenses'), 0)           AS expenses
  FROM entries
  GROUP BY depot_id, transaction_date
)
SELECT
  p.depot_id,
  p.transaction_date,
  p.cash_sales,
  p.pos_sales,
  p.credit_sales,
  (p.cash_sales + p.pos_sales + p.credit_sales)     AS total_sales,
  p.supplier_purchases,
  p.supplier_payments,
  p.customer_payments,
  p.expenses,
  s.opening_operating_balance
    + SUM(p.supplier_purchases - (p.cash_sales + p.pos_sales + p.credit_sales)) OVER (
        PARTITION BY p.depot_id
        ORDER BY p.transaction_date
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
      ) AS operating_balance
FROM pivoted p
JOIN depot_settings s ON s.depot_id = p.depot_id
WHERE p.transaction_date >= s.opening_balance_date;
