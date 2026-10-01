/**
 * Audit trail for edge-created records (SRS §26/§38). Mirrors
 * server/src/middleware/audit.js — entry date/time and actor identity are
 * always stamped by the server, never accepted from the client.
 */
import { query } from './db.ts';
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
  actor = null,
  req = null,
  action,
  entityType = null,
  entityId = null,
  description = null,
  previousValue = null,
  newValue = null,
}: {
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
  await query(
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
