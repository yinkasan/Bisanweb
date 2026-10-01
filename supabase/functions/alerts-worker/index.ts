/**
 * alerts-worker — Supabase Edge Function
 *
 * Scheduled threshold sweep (SRS §25): checks every active customer and
 * supplier against the debt-alert thresholds in system_settings and creates
 * or resolves notifications. Idempotent — safe to run every few minutes.
 *
 * It complements the per-transaction checks in the Express API: even if the
 * app server was down or nobody entered data, alerts stay correct.
 *
 * Security: if CRON_SECRET is set, callers must send x-cron-secret.
 * Schedule it with pg_cron + pg_net (see supabase/functions/README.md).
 */
import { fail, handleOptions, json } from '../_shared/http.ts';
import { getSetting, notificationsEnabled, sweepDebtAlerts } from '../_shared/notify.ts';

Deno.serve(async (req: Request): Promise<Response> => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  const cronSecret = Deno.env.get('CRON_SECRET');
  if (cronSecret && req.headers.get('x-cron-secret') !== cronSecret) {
    return fail('Forbidden', 403);
  }

  try {
    if (!(await notificationsEnabled())) {
      return json({ ok: true, skipped: 'notifications_disabled' });
    }

    const result = await sweepDebtAlerts();
    const customerThreshold = (await getSetting('customer_debt_alert_threshold')) ?? '1000000';
    const supplierThreshold = (await getSetting('supplier_debt_alert_threshold')) ?? '1000000';

    return json({
      ok: true,
      ran_at: new Date().toISOString(),
      thresholds: {
        customer_debt: customerThreshold,
        supplier_debt: supplierThreshold,
      },
      ...result,
    });
  } catch (err) {
    console.error('[alerts-worker] sweep failed', err);
    return fail('Sweep failed', 500);
  }
});
