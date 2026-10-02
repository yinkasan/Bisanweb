/**
 * /meta — port of server/src/routes/meta.routes.js. Reference values for the
 * entry forms (expense categories, payment methods).
 */
import { json } from '../../_shared/http.ts';
import { query } from '../../_shared/db.ts';
import type { Ctx, ModuleHandler } from '../_ctx.ts';

// Values the expenses form offers — mirrors PAYMENT_METHODS in the flow engine.
const PAYMENT_METHODS = ['Cash', 'POS', 'Bank Transfer', 'Cheque', 'Bank Deposit'];

export const handleMeta: ModuleHandler = async (c: Ctx): Promise<Response | null> => {
  const { method, path } = c;

  if (method === 'GET' && path === '/meta/expense-categories') {
    const rows = await query(
      `SELECT id, name, is_active FROM expense_categories WHERE is_active ORDER BY name`,
    );
    return json({ categories: rows });
  }

  if (method === 'GET' && path === '/meta/payment-methods') {
    return json({ methods: PAYMENT_METHODS });
  }

  return null;
};
