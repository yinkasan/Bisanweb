import { query, money } from '../db/pool.js';

/** Reads one system setting value (string) or null. */
export async function getSetting(key) {
  const res = await query('SELECT value FROM system_settings WHERE key = $1', [key]);
  return res.rowCount ? res.rows[0].value : null;
}

async function notificationsEnabled() {
  const v = await getSetting('notifications_enabled');
  return v === null ? true : v === 'true';
}

/** Creates a notification for a specific user, or a broadcast when userId is null. */
export async function createNotification({
  userId = null, type, severity = 'info', title, message = null, entityType = null, entityId = null,
}) {
  await query(
    `INSERT INTO notifications (user_id, type, severity, title, message, entity_type, entity_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [userId, type, severity, title, message, entityType, entityId === null ? null : String(entityId)]
  );
}

async function hasUnread(type, entityId) {
  const res = await query(
    `SELECT 1 FROM notifications
      WHERE type = $1 AND entity_type IS NOT NULL AND entity_id = $2 AND is_read = false
      LIMIT 1`,
    [type, String(entityId)]
  );
  return res.rowCount > 0;
}

async function resolveUnread(type, entityId) {
  await query(
    `UPDATE notifications SET is_read = true
      WHERE type = $1 AND entity_id = $2 AND is_read = false`,
    [type, String(entityId)]
  );
}

/** Notifies when a customer's outstanding credit crosses the alert threshold. */
export async function notifyCustomerDebt(customerId) {
  if (!(await notificationsEnabled())) return;
  const id = Number(customerId);
  if (!Number.isInteger(id) || id <= 0) return;

  const threshold = Number((await getSetting('customer_debt_alert_threshold')) ?? '1000000');
  const res = await query(
    `SELECT c.name, c.code,
            COALESCE((SELECT SUM(amount) FROM credit_sales     WHERE customer_id = c.id AND status = 'posted'), 0)
          - COALESCE((SELECT SUM(amount) FROM customer_payments WHERE customer_id = c.id AND status = 'posted'), 0) AS balance
       FROM customers c WHERE c.id = $1`,
    [id]
  );
  if (res.rowCount === 0) return;
  const { name, code, balance } = res.rows[0];

  if (Number(balance) > threshold) {
    if (!(await hasUnread('customer_debt', id))) {
      await createNotification({
        type: 'customer_debt',
        severity: 'warning',
        title: `Customer debt above threshold: ${name}`,
        message: `${code} — ${name} now owes ₦${money(balance)} (threshold ₦${money(threshold)}).`,
        entityType: 'customer',
        entityId: id,
      });
    }
  } else {
    await resolveUnread('customer_debt', id);
  }
}

/** Notifies when a supplier's outstanding debt crosses the alert threshold. */
export async function notifySupplierDebt(supplierId) {
  if (!(await notificationsEnabled())) return;
  const id = Number(supplierId);
  if (!Number.isInteger(id) || id <= 0) return;

  const threshold = Number((await getSetting('supplier_debt_alert_threshold')) ?? '1000000');
  const res = await query(
    `SELECT s.name, s.code,
            COALESCE((SELECT SUM(amount) FROM supplier_purchases WHERE supplier_id = s.id AND status = 'posted'), 0)
          - COALESCE((SELECT SUM(amount) FROM supplier_payments  WHERE supplier_id = s.id AND status = 'posted'), 0) AS debt
       FROM suppliers s WHERE s.id = $1`,
    [id]
  );
  if (res.rowCount === 0) return;
  const { name, code, debt } = res.rows[0];

  if (Number(debt) > threshold) {
    if (!(await hasUnread('supplier_debt', id))) {
      await createNotification({
        type: 'supplier_debt',
        severity: 'warning',
        title: `Supplier debt above threshold: ${name}`,
        message: `${code} — ${name} is owed ₦${money(debt)} (threshold ₦${money(threshold)}).`,
        entityType: 'supplier',
        entityId: id,
      });
    }
  } else {
    await resolveUnread('supplier_debt', id);
  }
}
