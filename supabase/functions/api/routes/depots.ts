/**
 * /depots — port of server/src/routes/depots.routes.js. Depot dropdowns,
 * creation with opening settings, and updates (info + opening balances).
 */
import { json } from '../../_shared/http.ts';
import { query, queryOne, withTransaction } from '../../_shared/db.ts';
import { assertPermission } from '../../_shared/auth.ts';
import { diffFields, logAdjustments, logAudit } from '../../_shared/audit.ts';
import { optionalString, requireAmount, requireDate, requireString } from '../../_shared/stamps.ts';
import { badRequest, bodyOf, notFound, under, type Ctx, type ModuleHandler } from '../_ctx.ts';

export const handleDepots: ModuleHandler = async (c: Ctx): Promise<Response | null> => {
  const rest = under(c.path, '/depots');
  if (!rest) return null;
  const { method, req, user } = c;

  // GET /depots — depots the signed-in user may access (for dropdowns)
  if (method === 'GET' && rest === '/') {
    // user.depots already respects all_depots / Super Admin.
    return json({ depots: user.depots });
  }

  // GET /depots/all — every depot in the company (user administration)
  if (method === 'GET' && rest === '/all') {
    assertPermission(user, 'users', 'view');
    const rows = await query(
      `SELECT d.id, d.code, d.name, d.location, d.phone, d.is_active,
              s.opening_balance_date, s.opening_operating_balance, s.opening_cash_at_hand
         FROM depots d
         LEFT JOIN depot_settings s ON s.depot_id = d.id
        ORDER BY d.code`,
    );
    return json({ depots: rows });
  }

  // POST /depots — create a depot with its opening settings
  if (method === 'POST' && rest === '/') {
    assertPermission(user, 'settings', 'input');
    const body = await bodyOf(req);
    const code = requireString(body.code, 'code', 20).toUpperCase();
    const name = requireString(body.name, 'name', 120);
    const location = optionalString(body.location, 200);
    const phone = optionalString(body.phone, 40);
    const openingDate = requireDate(body.openingBalanceDate, 'openingBalanceDate');
    const openingBalance = requireAmount(body.openingOperatingBalance ?? 0, 'openingOperatingBalance', true);
    const openingCash = requireAmount(body.openingCashAtHand ?? 0, 'openingCashAtHand', true);

    const depotId = await withTransaction(async (tx) => {
      const exists = await tx.queryOne('SELECT 1 AS present FROM depots WHERE code = $1', [code]);
      if (exists) throw badRequest('A depot with that code already exists');
      const d = await tx.queryOne<{ id: number }>(
        `INSERT INTO depots (code, name, location, phone, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $5) RETURNING id`,
        [code, name, location, phone, user.id],
      );
      const id = Number(d!.id);
      await tx.query(
        `INSERT INTO depot_settings (depot_id, opening_balance_date, opening_operating_balance, opening_cash_at_hand, updated_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, openingDate, openingBalance, openingCash, user.id],
      );
      await logAudit({
        tx, actor: user, req,
        action: 'CREATE', entityType: 'depot', entityId: id,
        description: `Created depot ${code} — ${name}`,
        newValue: { code, name, location, phone, openingDate, openingBalance, openingCash },
      });
      return id;
    });

    return json({ id: depotId }, 201);
  }

  // PUT /depots/:id — update depot info and opening settings
  const idMatch = /^\/(\d+)$/.exec(rest);
  if (method === 'PUT' && idMatch) {
    assertPermission(user, 'settings', 'edit');
    const id = Number(idMatch[1]);
    const b = await queryOne<Record<string, any>>(
      `SELECT d.id, d.code, d.name, d.location, d.phone, d.is_active,
              s.opening_balance_date, s.opening_operating_balance, s.opening_cash_at_hand
         FROM depots d LEFT JOIN depot_settings s ON s.depot_id = d.id
        WHERE d.id = $1`,
      [id],
    );
    if (!b) throw notFound('Depot not found');

    const body = await bodyOf(req);
    const updates: Record<string, unknown> = {};
    if (body.name !== undefined) updates.name = requireString(body.name, 'name', 120);
    if (body.location !== undefined) updates.location = optionalString(body.location, 200);
    if (body.phone !== undefined) updates.phone = optionalString(body.phone, 40);
    if (body.isActive !== undefined) updates.is_active = body.isActive === true;

    const settings: Record<string, unknown> = {};
    if (body.openingBalanceDate !== undefined) {
      settings.opening_balance_date = requireDate(body.openingBalanceDate, 'openingBalanceDate');
    }
    if (body.openingOperatingBalance !== undefined) {
      settings.opening_operating_balance = requireAmount(body.openingOperatingBalance, 'openingOperatingBalance', true);
    }
    if (body.openingCashAtHand !== undefined) {
      settings.opening_cash_at_hand = requireAmount(body.openingCashAtHand, 'openingCashAtHand', true);
    }

    if (Object.keys(updates).length === 0 && Object.keys(settings).length === 0) {
      throw badRequest('Nothing to update');
    }

    await withTransaction(async (tx) => {
      if (Object.keys(updates).length > 0) {
        const cols = Object.keys(updates);
        const setSql = cols.map((col, i) => `${col} = $${i + 2}`).join(', ');
        await tx.query(
          `UPDATE depots SET ${setSql}, updated_at = now(), updated_by = $${cols.length + 2} WHERE id = $1`,
          [id, ...cols.map((col) => updates[col]), user.id],
        );
      }
      if (Object.keys(settings).length > 0) {
        const cols = Object.keys(settings);
        const setSql = cols.map((col, i) => `${col} = $${i + 2}`).join(', ');
        await tx.query(
          `UPDATE depot_settings SET ${setSql}, updated_at = now(), updated_by = $${cols.length + 2} WHERE depot_id = $1`,
          [id, ...cols.map((col) => settings[col]), user.id],
        );
      }
      const beforeFlat: Record<string, unknown> = {
        name: b.name, location: b.location, phone: b.phone, is_active: b.is_active,
        opening_balance_date: b.opening_balance_date,
        opening_operating_balance: b.opening_operating_balance,
        opening_cash_at_hand: b.opening_cash_at_hand,
      };
      const afterFlat = { ...beforeFlat, ...updates, ...settings };
      await logAdjustments({
        tx, actor: user, entityType: 'depot', entityId: id,
        changes: diffFields(beforeFlat, afterFlat, Object.keys(afterFlat)),
        reason: 'Depot settings update',
      });
      await logAudit({
        tx, actor: user, req,
        action: 'UPDATE', entityType: 'depot', entityId: id,
        description: `Updated depot ${b.code}`,
        previousValue: beforeFlat, newValue: { ...updates, ...settings },
      });
    });

    return json({ ok: true });
  }

  return null;
};
