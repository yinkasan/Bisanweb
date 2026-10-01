import { Router } from 'express';
import { query, withTransaction } from '../db/pool.js';
import { asyncHandler, badRequest, notFound } from '../middleware/errors.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { logAudit, logAdjustments, diffFields } from '../middleware/audit.js';
import { optionalString, requireString } from '../utils/stamps.js';

const router = Router();
router.use(requireAuth);

const PAGE = 'settings';

// Bounds of the mobile session safety window (system_settings key
// 'session_idle_minutes'). Mirrors the clamp in the app's src/auth/idlePolicy.ts
// so neither side can create an instant or never-ending lockout.
const IDLE_MINUTES_MIN = 1;
const IDLE_MINUTES_MAX = 240;

// GET /api/settings — company profile + system settings
router.get(
  '/',
  requirePermission(PAGE, 'view'),
  asyncHandler(async (req, res) => {
    const company = await query(
      'SELECT id, name, address, phone, email, currency_code, currency_symbol FROM companies ORDER BY id LIMIT 1'
    );
    const settings = await query(
      `SELECT s.key, s.value, s.label, s.type, s.updated_at, u.full_name AS updated_by_name
         FROM system_settings s LEFT JOIN users u ON u.id = s.updated_by
        ORDER BY s.key`
    );
    res.json({ company: company.rows[0] ?? null, settings: settings.rows });
  })
);

// PUT /api/settings/company — update company profile
router.put(
  '/company',
  requirePermission(PAGE, 'edit'),
  asyncHandler(async (req, res) => {
    const before = await query('SELECT * FROM companies ORDER BY id LIMIT 1');
    if (before.rowCount === 0) throw notFound('Company not found');
    const b = before.rows[0];
    const body = req.body ?? {};

    const updates = {};
    if (body.name !== undefined) updates.name = requireString(body.name, 'name', { max: 150 });
    if (body.address !== undefined) updates.address = optionalString(body.address, { max: 300 });
    if (body.phone !== undefined) updates.phone = optionalString(body.phone, { max: 60 });
    if (body.email !== undefined) updates.email = optionalString(body.email, { max: 160 });
    if (body.currencySymbol !== undefined) updates.currency_symbol = requireString(body.currencySymbol, 'currencySymbol', { max: 8 });
    if (Object.keys(updates).length === 0) throw badRequest('Nothing to update');

    await withTransaction(async (client) => {
      const cols = Object.keys(updates);
      const setSql = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
      await client.query(
        `UPDATE companies SET ${setSql}, updated_at = now() WHERE id = $1`,
        [b.id, ...cols.map((c) => updates[c])]
      );
      await logAdjustments({
        executor: client, actor: req.user, entityType: 'company', entityId: b.id,
        changes: diffFields(b, { ...b, ...updates }, ['name', 'address', 'phone', 'email', 'currency_symbol']),
        reason: 'Company profile update',
      });
      await logAudit({
        executor: client, actor: req.user, req,
        action: 'UPDATE', entityType: 'company', entityId: b.id,
        description: 'Updated company profile',
        previousValue: { name: b.name, address: b.address, phone: b.phone, email: b.email, currency_symbol: b.currency_symbol },
        newValue: updates,
      });
    });

    res.json({ ok: true });
  })
);

// PUT /api/settings/:key — update one system setting (e.g. cash_at_bank)
router.put(
  '/:key',
  requirePermission(PAGE, 'edit'),
  asyncHandler(async (req, res) => {
    const key = String(req.params.key);
    const before = await query('SELECT * FROM system_settings WHERE key = $1', [key]);
    if (before.rowCount === 0) throw notFound('Unknown setting');
    const b = before.rows[0];

    let value = req.body?.value;
    if (value === undefined) throw badRequest('value is required');
    value = String(value);

    if (b.type === 'number') {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) throw badRequest(`${b.label} must be a non-negative number`);
      value = n.toFixed(2);
    }
    // Whole-minute settings (e.g. the auto sign-out window) must not be money:
    // no decimals, no currency rounding, bounded to a sane range.
    if (b.type === 'minutes') {
      const n = Number(value);
      if (!Number.isInteger(n) || n < IDLE_MINUTES_MIN || n > IDLE_MINUTES_MAX) {
        throw badRequest(
          `${b.label ?? key} must be a whole number of minutes between ${IDLE_MINUTES_MIN} and ${IDLE_MINUTES_MAX}`
        );
      }
      value = String(n);
    }
    if (b.type === 'boolean' && !['true', 'false'].includes(value)) {
      throw badRequest(`${b.label} must be true or false`);
    }

    await withTransaction(async (client) => {
      await client.query(
        'UPDATE system_settings SET value = $2, updated_at = now(), updated_by = $3 WHERE key = $1',
        [key, value, req.user.id]
      );
      await logAdjustments({
        executor: client, actor: req.user, entityType: 'system_setting', entityId: key,
        changes: diffFields(b, { ...b, value }, ['value']),
        reason: 'System setting update',
      });
      await logAudit({
        executor: client, actor: req.user, req,
        action: 'UPDATE', entityType: 'system_setting', entityId: key,
        description: `Updated setting "${b.label ?? key}"`,
        previousValue: { value: b.value }, newValue: { value },
      });
    });

    res.json({ ok: true });
  })
);

export default router;
