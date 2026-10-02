/**
 * Audit trail for edge-created records (SRS §26/§38). Mirrors
 * server/src/middleware/audit.js — entry date/time and actor identity are
 * always stamped by the server, never accepted from the client. Pass `tx` to
 * write inside an open transaction so audit rows commit with the data change.
 */
import { query, type Tx } from './db.ts';
import type { UserContext } from './auth.ts';

function requestMeta(req: Request | null): { ip: string | null; agent: string | null } {
  if (!req) return { ip: null, agent: null };
  const forwarded = req.headers.get('x-forwarded-for');
  const ip = (forwarded ? forwarded.split(',')[0].trim() : null)
    || req.headers.get('cf-connecting-ip')
    || req.headers.get('x-real-ip')
    || null;
  return { ip, agent: req.headers.get('user-agent') ?? null };
}

export async function logAudit({
  tx = null,
  actor = null,
  req = null,
  action,
  entityType = null,
  entityId = null,
  description = null,
  previousValue = null,
  newValue = null,
}: {
  tx?: Tx | null;
  actor?: Partial<UserContext> | null;
  req?: Request | null;
  action: string;
  entityType?: string | null;
  entityId?: number | string | null;
  description?: string | null;
  previousValue?: unknown;
  newValue?: unknown;
}): Promise<void> {
  const { ip, agent } = requestMeta(req);
  const run = tx ?? { query };
  await run.query(
    `INSERT INTO audit_logs
       (user_id, user_name, user_role, action, entity_type, entity_id,
        description, previous_value, new_value, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      actor?.id ?? null,
      actor?.fullName ?? actor?.username ?? 'system',
      actor?.roleName ?? null,
      action,
      entityType,
      entityId === null || entityId === undefined ? null : String(entityId),
      description,
      previousValue ? JSON.stringify(previousValue) : null,
      newValue ? JSON.stringify(newValue) : null,
      ip,
      agent,
    ],
  );
}

/** Compares two objects over the given fields; returns [{field, old, new}]. */
export function diffFields(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
  fields: string[],
): { field: string; oldValue: unknown; newValue: unknown }[] {
  const changes: { field: string; oldValue: unknown; newValue: unknown }[] = [];
  for (const field of fields) {
    const oldVal = before?.[field];
    const newVal = after?.[field];
    const oldNorm = oldVal === undefined ? null : oldVal;
    const newNorm = newVal === undefined ? null : newVal;
    if (String(oldNorm ?? '') !== String(newNorm ?? '')) {
      changes.push({ field, oldValue: oldNorm, newValue: newNorm });
    }
  }
  return changes;
}

/**
 * Records field-level old -> new values (SRS §27 Record History, §38 Audit).
 * Used for corrections and edits to master data.
 */
export async function logAdjustments({
  tx = null,
  actor,
  entityType,
  entityId,
  changes,
  reason = null,
}: {
  tx?: Tx | null;
  actor: Partial<UserContext>;
  entityType: string;
  entityId: number | string;
  changes: { field: string; oldValue: unknown; newValue: unknown }[];
  reason?: string | null;
}): Promise<void> {
  if (!changes?.length) return;
  const run = tx ?? { query };
  for (const c of changes) {
    await run.query(
      `INSERT INTO adjustment_logs
         (entity_type, entity_id, field, old_value, new_value, reason, adjusted_by, adjusted_by_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        entityType,
        String(entityId),
        c.field,
        c.oldValue === null || c.oldValue === undefined ? null : String(c.oldValue),
        c.newValue === null || c.newValue === undefined ? null : String(c.newValue),
        reason,
        actor.id ?? null,
        actor.fullName ?? actor.username ?? 'system',
      ],
    );
  }
}
