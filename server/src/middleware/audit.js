import { query, withTransaction } from '../db/pool.js';

/** Extracts IP + user agent for the audit trail. */
function requestMeta(req) {
  if (!req) return { ip: null, agent: null };
  const forwarded = req.headers?.['x-forwarded-for'];
  const ip = (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : null)
    || req.ip
    || req.socket?.remoteAddress
    || null;
  const agent = req.headers?.['user-agent'] || null;
  return { ip, agent };
}

/**
 * Writes an audit trail entry (SRS §26/§38). Accepts either a raw executor
 * (a transaction client) or uses the pool. `actor` is the req.user context.
 */
export async function logAudit({
  executor = null,
  actor = null,
  req = null,
  action,
  entityType = null,
  entityId = null,
  description = null,
  previousValue = null,
  newValue = null,
}) {
  const { ip, agent } = requestMeta(req);
  const run = executor ? executor.query.bind(executor) : query;
  await run(
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
    ]
  );
}

/** Compares two objects over the given fields; returns [{field, old, new}]. */
export function diffFields(before, after, fields) {
  const changes = [];
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
export async function logAdjustments({ executor = null, actor, entityType, entityId, changes, reason = null }) {
  if (!changes?.length) return;
  const run = executor ? executor.query.bind(executor) : query;
  for (const c of changes) {
    await run(
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
        actor.id,
        actor.fullName ?? actor.username,
      ]
    );
  }
}

/** Convenience: audit + adjustments in one transaction. */
export async function recordChange({
  actor, req, action, entityType, entityId, description, before, after, fields, reason,
}) {
  return withTransaction(async (client) => {
    const changes = fields ? diffFields(before, after, fields) : [];
    await logAdjustments({ executor: client, actor, entityType, entityId, changes, reason });
    await logAudit({
      executor: client, actor, req, action, entityType, entityId, description,
      previousValue: before ?? null, newValue: after ?? null,
    });
    return changes;
  });
}
