/**
 * Threshold notifications for edge functions, mirroring
 * server/src/services/notifyService.js. Used by mobile-api (right after a
 * credit sale) and by alerts-worker (the scheduled sweep).
 */
import { query, queryOne } from './db.ts';

/** Reads one system setting value (string) or null. */
export async function getSetting(key: string): Promise<string | null> {
  const row = await queryOne<{ value: string }>(
    'SELECT value FROM system_settings WHERE key = $1',
    [key],
  );
  return row ? row.value : null;
}

export async function notificationsEnabled(): Promise<boolean> {
  const v = await getSetting('notifications_enabled');
  return v === null ? true : v === 'true';
}

function naira(value: unknown): string {
  return Number(value ?? 0).toFixed(2);
}

/** Creates a notification for a specific user, or a broadcast when userId is null. */
export async function createNotification({
  userId = null,
  type,
  severity = 'info',
  title,
  message = null,
  entityType = null,
  entityId = null,
}: {
  userId?: number | null;
  type: string;
  severity?: string;
  title: string;
  message?: string | null;
  entityType?: string | null;
  entityId?: number | null;
}): Promise<void> {
  await query(
    `INSERT INTO notifications (user_id, type, severity, title, message, entity_type, entity_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [userId, type, severity, title, message, entityType, entityId === null ? null : String(entityId)],
  );
}

async function hasUnread(type: string, entityId: number): Promise<boolean> {
  const row = await queryOne(
    `SELECT 1 AS present FROM notifications
      WHERE type = $1 AND entity_type IS NOT NULL AND entity_id = $2 AND is_read = false
      LIMIT 1`,
    [type, String(entityId)],
  );
  return row !== null;
}

async function resolveUnread(type: string, entityId: number): Promise<void> {
  await query(
    `UPDATE notifications SET is_read = true
      WHERE type = $1 AND entity_id = $2 AND is_read = false`,
    [type, String(entityId)],
  );
}

/** Notifies when a customer's outstanding credit crosses the alert threshold. */
export async function notifyCustomerDebt(customerId: number): Promise<void> {
  if (!(await notificationsEnabled())) return;
  if (!Number.isInteger(customerId) || customerId <= 0) return;

  const threshold = Number((await getSetting('customer_debt_alert_threshold')) ?? '1000000');
  const row = await queryOne<{ name: string; code: string; balance: string }>(
    `SELECT c.name, c.code,
            COALESCE((SELECT SUM(amount) FROM credit_sales     WHERE customer_id = c.id AND status = 'posted'), 0)
          - COALESCE((SELECT SUM(amount) FROM customer_payments WHERE customer_id = c.id AND status = 'posted'), 0) AS balance
       FROM customers c WHERE c.id = $1`,
    [customerId],
  );
  if (!row) return;

  if (Number(row.balance) > threshold) {
    if (!(await hasUnread('customer_debt', customerId))) {
      await createNotification({
        type: 'customer_debt',
        severity: 'warning',
        title: `Customer debt above threshold: ${row.name}`,
        message: `${row.code} — ${row.name} now owes ₦${naira(row.balance)} (threshold ₦${naira(threshold)}).`,
        entityType: 'customer',
        entityId: customerId,
      });
    }
  } else {
    await resolveUnread('customer_debt', customerId);
  }
}

/** Notifies when a supplier's outstanding debt crosses the alert threshold. */
export async function notifySupplierDebt(supplierId: number): Promise<void> {
  if (!(await notificationsEnabled())) return;
  if (!Number.isInteger(supplierId) || supplierId <= 0) return;

  const threshold = Number((await getSetting('supplier_debt_alert_threshold')) ?? '1000000');
  const row = await queryOne<{ name: string; code: string; debt: string }>(
    `SELECT s.name, s.code,
            COALESCE((SELECT SUM(amount) FROM supplier_purchases WHERE supplier_id = s.id AND status = 'posted'), 0)
          - COALESCE((SELECT SUM(amount) FROM supplier_payments  WHERE supplier_id = s.id AND status = 'posted'), 0) AS debt
       FROM suppliers s WHERE s.id = $1`,
    [supplierId],
  );
  if (!row) return;

  if (Number(row.debt) > threshold) {
    if (!(await hasUnread('supplier_debt', supplierId))) {
      await createNotification({
        type: 'supplier_debt',
        severity: 'warning',
        title: `Supplier debt above threshold: ${row.name}`,
        message: `${row.code} — ${row.name} is owed ₦${naira(row.debt)} (threshold ₦${naira(threshold)}).`,
        entityType: 'supplier',
        entityId: supplierId,
      });
    }
  } else {
    await resolveUnread('supplier_debt', supplierId);
  }
}

export interface SweepResult {
  customersChecked: number;
  customersAlerting: number;
  suppliersChecked: number;
  suppliersAlerting: number;
  notificationsCreated: number;
}

/**
 * Full sweep over every active customer and supplier. Idempotent: existing
 * unread alerts are left untouched, alerts below the threshold are resolved.
 */
export async function sweepDebtAlerts(): Promise<SweepResult> {
  const customerThreshold = Number((await getSetting('customer_debt_alert_threshold')) ?? '1000000');
  const supplierThreshold = Number((await getSetting('supplier_debt_alert_threshold')) ?? '1000000');

  const customers = await query<{ id: number; name: string; code: string; balance: string }>(
    `SELECT c.id, c.name, c.code,
            COALESCE((SELECT SUM(amount) FROM credit_sales     WHERE customer_id = c.id AND status = 'posted'), 0)
          - COALESCE((SELECT SUM(amount) FROM customer_payments WHERE customer_id = c.id AND status = 'posted'), 0) AS balance
       FROM customers c
      WHERE c.is_active
      ORDER BY balance DESC`,
  );
  const suppliers = await query<{ id: number; name: string; code: string; debt: string }>(
    `SELECT s.id, s.name, s.code,
            COALESCE((SELECT SUM(amount) FROM supplier_purchases WHERE supplier_id = s.id AND status = 'posted'), 0)
          - COALESCE((SELECT SUM(amount) FROM supplier_payments  WHERE supplier_id = s.id AND status = 'posted'), 0) AS debt
       FROM suppliers s
      WHERE s.is_active
      ORDER BY debt DESC`,
  );

  const result: SweepResult = {
    customersChecked: customers.length,
    customersAlerting: 0,
    suppliersChecked: suppliers.length,
    suppliersAlerting: 0,
    notificationsCreated: 0,
  };

  for (const c of customers) {
    const over = Number(c.balance) > customerThreshold;
    const unread = over && await hasUnread('customer_debt', c.id);
    if (over) {
      result.customersAlerting += 1;
      if (!unread) {
        await createNotification({
          type: 'customer_debt',
          severity: 'warning',
          title: `Customer debt above threshold: ${c.name}`,
          message: `${c.code} — ${c.name} now owes ₦${naira(c.balance)} (threshold ₦${naira(customerThreshold)}).`,
          entityType: 'customer',
          entityId: c.id,
        });
        result.notificationsCreated += 1;
      }
    } else {
      await resolveUnread('customer_debt', c.id);
    }
  }

  for (const s of suppliers) {
    const over = Number(s.debt) > supplierThreshold;
    const unread = over && await hasUnread('supplier_debt', s.id);
    if (over) {
      result.suppliersAlerting += 1;
      if (!unread) {
        await createNotification({
          type: 'supplier_debt',
          severity: 'warning',
          title: `Supplier debt above threshold: ${s.name}`,
          message: `${s.code} — ${s.name} is owed ₦${naira(s.debt)} (threshold ₦${naira(supplierThreshold)}).`,
          entityType: 'supplier',
          entityId: s.id,
        });
        result.notificationsCreated += 1;
      }
    } else {
      await resolveUnread('supplier_debt', s.id);
    }
  }

  return result;
}
