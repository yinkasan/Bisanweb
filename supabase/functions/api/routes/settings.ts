/**
 * /settings — port of server/src/routes/settings.routes.js. Company profile
 * plus the key/value system settings the Super Admin edits.
 */
import { json } from '../../_shared/http.ts';
import { query, queryOne, withTransaction } from '../../_shared/db.ts';
import { assertPermission } from '../../_shared/auth.ts';
import { logAudit, logAdjustments, diffFields } from '../../_shared/audit.ts';
import { optionalString, requireString } from '../../_shared/stamps.ts';
import { badRequest, bodyOf, notFound, under, type Ctx, type ModuleHandler } from '../_ctx.ts';

const PAGE = 'settings';

// Bounds of the session safety window (system_settings key
// 'session_idle_minutes'). Mirrors the clamp in _shared/sessionPolicy.ts and
// the mobile app's idlePolicy so neither side can create an instant or
// never-ending lockout.
const IDLE_MINUTES_MIN = 1;
const IDLE_MINUTES_MAX = 240;

export const handleSettings: ModuleHandler = async (c: Ctx): Promise<Response | null> => {
  const rest = under(c.path, '/settings');
  if (!rest) return null;
  const { method, user, req } = c;

  // GET /settings — company profile + system settings
  if (method === 'GET' && rest === '/') {
    assertPermission(user, PAGE, 'view');
    const company = await queryOne<Record<string, unknown>>(
      'SELECT id, name, address, phone, email, currency_code, currency_symbol FROM companies ORDER BY id LIMIT 1',
    );
    const settings = await query(
      `SELECT s.key, s.value, s.label, s.type, s.updated_at, u.full_name AS updated_by_name
         FROM system_settings s LEFT JOIN users u ON u.id = s.updated_by
        ORDER BY s.key`,
    );
    return json({ company: company ?? null, settings });
  }

  // PUT /settings/company — update company profile
  if (method === 'PUT' && rest === '/company') {
    assertPermission(user, PAGE, 'edit');
    const b = await queryOne<Record<string, any>>(
      'SELECT * FROM companies ORDER BY id LIMIT 1',
    );
    if (!b) throw notFound('Company not found');
    const body = await bodyOf(req);

    const updates: Record<string, unknown> = {};
    if (body.name !== undefined) updates.name = requireString(body.name, 'name', 150);
    if (body.address !== undefined) updates.address = optionalString(body.address, 300);
    if (body.phone !== undefined) updates.phone = optionalString(body.phone, 60);
    if (body.email !== undefined) updates.email = optionalString(body.email, 160);
    if (body.currencySymbol !== undefined) {
      updates.currency_symbol = requireString(body.currencySymbol, 'currencySymbol', 8);
    }
    if (Object.keys(updates).length === 0) throw badRequest('Nothing to update');

    await withTransaction(async (tx) => {
      const cols = Object.keys(updates);
      const setSql = cols.map((col, i) => `${col} = $${i + 2}`).join(', ');
      await tx.query(
        `UPDATE companies SET ${setSql}, updated_at = now() WHERE id = $1`,
        [b.id, ...cols.map((col) => updates[col])],
      );
      await logAdjustments({
        tx, actor: user, entityType: 'company', entityId: b.id,
        changes: diffFields(b, { ...b, ...updates }, ['name', 'address', 'phone', 'email', 'currency_symbol']),
        reason: 'Company profile update',
      });
      await logAudit({
        tx, actor: user, req,
        action: 'UPDATE', entityType: 'company', entityId: b.id,
        description: 'Updated company profile',
        previousValue: { name: b.name, address: b.address, phone: b.phone, email: b.email, currency_symbol: b.currency_symbol },
        newValue: updates,
      });
    });

    return json({ ok: true });
  }

  // PUT /settings/:key — update one system setting (e.g. cash_at_bank)
  const keyMatch = /^\/([a-z0-9_]+)$/i.exec(rest);
  if (method === 'PUT' && keyMatch) {
    assertPermission(user, PAGE, 'edit');
    const key = keyMatch[1];
    const b = await queryOne<Record<string, any>>(
      'SELECT * FROM system_settings WHERE key = $1',
      [key],
    );
    if (!b) throw notFound('Unknown setting');

    let value = (await bodyOf(req)).value;
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
          `${b.label ?? key} must be a whole number of minutes between ${IDLE_MINUTES_MIN} and ${IDLE_MINUTES_MAX}`,
        );
      }
      value = String(n);
    }
    if (b.type === 'boolean' && !['true', 'false'].includes(value)) {
      throw badRequest(`${b.label} must be true or false`);
    }

    await withTransaction(async (tx) => {
      await tx.query(
        'UPDATE system_settings SET value = $2, updated_at = now(), updated_by = $3 WHERE key = $1',
        [key, value, user.id],
      );
      await logAdjustments({
        tx, actor: user, entityType: 'system_setting', entityId: key,
        changes: diffFields(b, { ...b, value }, ['value']),
        reason: 'System setting update',
      });
      await logAudit({
        tx, actor: user, req,
        action: 'UPDATE', entityType: 'system_setting', entityId: key,
        description: `Updated setting "${b.label ?? key}"`,
        previousValue: { value: b.value }, newValue: { value },
      });
    });

    return json({ ok: true });
  }

  return null;
};
