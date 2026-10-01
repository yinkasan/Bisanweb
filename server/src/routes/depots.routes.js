import { Router } from 'express';
import { query, withTransaction } from '../db/pool.js';
import { asyncHandler, badRequest, notFound } from '../middleware/errors.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { logAudit, diffFields, logAdjustments } from '../middleware/audit.js';
import { optionalString, requireString, requireAmount, requireDate } from '../utils/stamps.js';

const router = Router();
router.use(requireAuth);

// GET /api/depots — depots the signed-in user may access (for dropdowns)
router.get(
  '/',
  asyncHandler(async (req, res) => {
    // req.user.depots already respects all_depots / Super Admin.
    res.json({ depots: req.user.depots });
  })
);

// GET /api/depots/all — every depot in the company (user administration)
router.get(
  '/all',
  requirePermission('users', 'view'),
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT d.id, d.code, d.name, d.location, d.phone, d.is_active,
              s.opening_balance_date, s.opening_operating_balance, s.opening_cash_at_hand
         FROM depots d
         LEFT JOIN depot_settings s ON s.depot_id = d.id
        ORDER BY d.code`
    );
    res.json({ depots: rows });
  })
);

// POST /api/depots — create a depot with its opening settings
router.post(
  '/',
  requirePermission('settings', 'input'),
  asyncHandler(async (req, res) => {
    const body = req.body ?? {};
    const code = requireString(body.code, 'code', { max: 20 }).toUpperCase();
    const name = requireString(body.name, 'name', { max: 120 });
    const location = optionalString(body.location, { max: 200 });
    const phone = optionalString(body.phone, { max: 40 });
    const openingDate = requireDate(body.openingBalanceDate, 'openingBalanceDate');
    const openingBalance = requireAmount(body.openingOperatingBalance ?? 0, { fieldName: 'openingOperatingBalance', allowZero: true });
    const openingCash = requireAmount(body.openingCashAtHand ?? 0, { fieldName: 'openingCashAtHand', allowZero: true });

    const depotId = await withTransaction(async (client) => {
      const exists = await client.query('SELECT 1 FROM depots WHERE code = $1', [code]);
      if (exists.rowCount > 0) throw badRequest('A depot with that code already exists');
      const d = await client.query(
        `INSERT INTO depots (code, name, location, phone, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $5) RETURNING id`,
        [code, name, location, phone, req.user.id]
      );
      await client.query(
        `INSERT INTO depot_settings (depot_id, opening_balance_date, opening_operating_balance, opening_cash_at_hand, updated_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [d.rows[0].id, openingDate, openingBalance, openingCash, req.user.id]
      );
      await logAudit({
        executor: client, actor: req.user, req,
        action: 'CREATE', entityType: 'depot', entityId: d.rows[0].id,
        description: `Created depot ${code} — ${name}`,
        newValue: { code, name, location, phone, openingDate, openingBalance, openingCash },
      });
      return d.rows[0].id;
    });

    res.status(201).json({ id: depotId });
  })
);

// PUT /api/depots/:id — update depot info and opening settings
router.put(
  '/:id',
  requirePermission('settings', 'edit'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const before = await query(
      `SELECT d.id, d.code, d.name, d.location, d.phone, d.is_active,
              s.opening_balance_date, s.opening_operating_balance, s.opening_cash_at_hand
         FROM depots d LEFT JOIN depot_settings s ON s.depot_id = d.id
        WHERE d.id = $1`,
      [id]
    );
    if (before.rowCount === 0) throw notFound('Depot not found');
    const b = before.rows[0];

    const body = req.body ?? {};
    const updates = {};
    if (body.name !== undefined) updates.name = requireString(body.name, 'name', { max: 120 });
    if (body.location !== undefined) updates.location = optionalString(body.location, { max: 200 });
    if (body.phone !== undefined) updates.phone = optionalString(body.phone, { max: 40 });
    if (body.isActive !== undefined) updates.is_active = body.isActive === true;

    const settings = {};
    if (body.openingBalanceDate !== undefined) {
      settings.opening_balance_date = requireDate(body.openingBalanceDate, 'openingBalanceDate');
    }
    if (body.openingOperatingBalance !== undefined) {
      settings.opening_operating_balance = requireAmount(body.openingOperatingBalance, {
        fieldName: 'openingOperatingBalance', allowZero: true,
      });
    }
    if (body.openingCashAtHand !== undefined) {
      settings.opening_cash_at_hand = requireAmount(body.openingCashAtHand, {
        fieldName: 'openingCashAtHand', allowZero: true,
      });
    }

    if (Object.keys(updates).length === 0 && Object.keys(settings).length === 0) {
      throw badRequest('Nothing to update');
    }

    await withTransaction(async (client) => {
      if (Object.keys(updates).length > 0) {
        const cols = Object.keys(updates);
        const setSql = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
        await client.query(
          `UPDATE depots SET ${setSql}, updated_at = now(), updated_by = $${cols.length + 2} WHERE id = $1`,
          [id, ...cols.map((c) => updates[c]), req.user.id]
        );
      }
      if (Object.keys(settings).length > 0) {
        const cols = Object.keys(settings);
        const setSql = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
        await client.query(
          `UPDATE depot_settings SET ${setSql}, updated_at = now(), updated_by = $${cols.length + 2} WHERE depot_id = $1`,
          [id, ...cols.map((c) => settings[c]), req.user.id]
        );
      }
      const beforeFlat = {
        name: b.name, location: b.location, phone: b.phone, is_active: b.is_active,
        opening_balance_date: b.opening_balance_date,
        opening_operating_balance: b.opening_operating_balance,
        opening_cash_at_hand: b.opening_cash_at_hand,
      };
      const afterFlat = { ...beforeFlat, ...updates, ...settings };
      await logAdjustments({
        executor: client, actor: req.user, entityType: 'depot', entityId: id,
        changes: diffFields(beforeFlat, afterFlat, Object.keys(afterFlat)),
        reason: 'Depot settings update',
      });
      await logAudit({
        executor: client, actor: req.user, req,
        action: 'UPDATE', entityType: 'depot', entityId: id,
        description: `Updated depot ${b.code}`,
        previousValue: beforeFlat, newValue: { ...updates, ...settings },
      });
    });

    res.json({ ok: true });
  })
);

export default router;
