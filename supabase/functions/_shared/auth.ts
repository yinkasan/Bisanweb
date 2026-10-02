/**
 * Authentication + authorization for edge functions. Mirrors
 * server/src/middleware/auth.js and server/src/services/accessService.js:
 *
 *  - HS256 JWTs signed with the same JWT_SECRET as the Express API, so a token
 *    issued by either backend works against both (web cookie, mobile bearer).
 *  - The full access context is reloaded from the database on every request,
 *    so deactivations and permission changes take effect immediately.
 */
import { query, queryOne } from './db.ts';
import { HttpError } from './http.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface PagePermission {
  view: boolean;
  input: boolean;
  edit: boolean;
  view_history: boolean;
  export: boolean;
  approve: boolean;
}

export interface DepotRef {
  id: number;
  code: string;
  name: string;
}

export interface UserContext {
  id: number;
  username: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  roleKey: string;
  roleName: string;
  roleLevel: number;
  isSuperAdmin: boolean;
  allDepots: boolean;
  lastLoginAt: string | null;
  permissions: Record<string, PagePermission>;
  components: Record<string, Record<string, ComponentAccess>>;
  depots: DepotRef[];
}

export interface ComponentAccess {
  visible: boolean;
  input: boolean;
}

function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// No return annotation: keeps the concrete Uint8Array<ArrayBuffer> type so it
// satisfies WebCrypto's BufferSource on every TypeScript version.
function base64urlDecode(input: string) {
  const normalised = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalised.length % 4 === 0 ? '' : '='.repeat(4 - (normalised.length % 4));
  const bin = atob(normalised + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function jwtSecret(): string {
  return Deno.env.get('JWT_SECRET') ?? 'dev_secret_replace_in_production';
}

function tokenTtlSeconds(): number {
  const raw = Deno.env.get('JWT_EXPIRES_IN') ?? '12h';
  const match = /^(\d+)([smh])$/.exec(raw.trim());
  if (!match) return 60 * 60 * 12;
  const n = Number(match[1]);
  const unit = match[2];
  return unit === 's' ? n : unit === 'm' ? n * 60 : n * 3600;
}

async function hmacKey(): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    'raw',
    encoder.encode(jwtSecret()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/** Issues an HS256 JWT that is interchangeable with the Express API's tokens. */
export async function signToken(userId: number, ttlSeconds = tokenTtlSeconds()): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payload = base64url(
    encoder.encode(JSON.stringify({ uid: userId, iat: now, exp: now + ttlSeconds })),
  );
  const body = `${header}.${payload}`;
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(), encoder.encode(body));
  return `${body}.${base64url(new Uint8Array(signature))}`;
}

async function verifyToken(token: string): Promise<{ uid: number } | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const body = `${parts[0]}.${parts[1]}`;
  let valid = false;
  try {
    valid = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(),
      base64urlDecode(parts[2]),
      encoder.encode(body),
    );
  } catch {
    return null;
  }
  if (!valid) return null;
  try {
    const payload = JSON.parse(decoder.decode(base64urlDecode(parts[1])));
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.uid !== 'number') return null;
    if (typeof payload.exp === 'number' && payload.exp < now) return null;
    return payload as { uid: number };
  } catch {
    return null;
  }
}

/** Reloads the user's full access context from the database. */
export async function loadUserContext(userId: number): Promise<UserContext> {
  const user = await queryOne<Record<string, unknown>>(
    `SELECT u.id, u.username, u.full_name, u.email, u.phone, u.is_active,
            u.all_depots, u.last_login_at,
            r.key AS role_key, r.name AS role_name, r.level AS role_level
       FROM users u
       JOIN user_roles ur ON ur.user_id = u.id AND ur.is_active
       JOIN roles r ON r.id = ur.role_id
      WHERE u.id = $1`,
    [userId],
  );
  if (!user) throw new HttpError(401, 'User not found');
  if (!user.is_active) throw new HttpError(403, 'This user account is deactivated');

  const isSuperAdmin = user.role_key === 'super_admin';

  const permissions: Record<string, PagePermission> = {};
  const grants = await query<Record<string, unknown>>(
    `SELECT page_key, can_view, can_input, can_edit, can_view_history, can_export, can_approve
       FROM user_permissions WHERE user_id = $1`,
    [userId],
  );
  for (const g of grants) {
    permissions[String(g.page_key)] = {
      view: Boolean(g.can_view),
      input: Boolean(g.can_input),
      edit: Boolean(g.can_edit),
      view_history: Boolean(g.can_view_history),
      export: Boolean(g.can_export),
      approve: Boolean(g.can_approve),
    };
  }

  // Role-level grants merge in permissively (same rule as the Express API).
  const roleGrants = await query<Record<string, unknown>>(
    `SELECT rp.page_key, rp.can_view, rp.can_input, rp.can_edit,
            rp.can_view_history, rp.can_export, rp.can_approve
       FROM role_permissions rp
       JOIN user_roles ur ON ur.role_id = rp.role_id AND ur.is_active
      WHERE ur.user_id = $1`,
    [userId],
  );
  for (const g of roleGrants) {
    const key = String(g.page_key);
    const cur = permissions[key] ?? {
      view: false, input: false, edit: false, view_history: false, export: false, approve: false,
    };
    permissions[key] = {
      view: cur.view || Boolean(g.can_view),
      input: cur.input || Boolean(g.can_input),
      edit: cur.edit || Boolean(g.can_edit),
      view_history: cur.view_history || Boolean(g.can_view_history),
      export: cur.export || Boolean(g.can_export),
      approve: cur.approve || Boolean(g.can_approve),
    };
  }

  // Component overrides for the role categories (explicit restrictions only).
  const components: Record<string, Record<string, ComponentAccess>> = {};
  const compRows = await query<Record<string, unknown>>(
    `SELECT rpc.page_key, rpc.component_key, rpc.is_visible, rpc.can_input
       FROM role_page_components rpc
       JOIN user_roles ur ON ur.role_id = rpc.role_id AND ur.is_active
      WHERE ur.user_id = $1`,
    [userId],
  );
  for (const c of compRows) {
    const page = (components[String(c.page_key)] ??= {});
    const key = String(c.component_key);
    const cur = page[key] ?? { visible: false, input: false };
    page[key] = {
      visible: cur.visible || Boolean(c.is_visible),
      input: cur.input || Boolean(c.can_input),
    };
  }
  if (isSuperAdmin) {
    const pages = await query<{ page_key: string }>('SELECT page_key FROM permissions');
    for (const p of pages) {
      permissions[p.page_key] = {
        view: true, input: true, edit: true, view_history: true, export: true, approve: true,
      };
    }
  }

  const depots = await query<DepotRef>(
    `SELECT d.id, d.code, d.name
       FROM depots d
      WHERE d.is_active
        AND ($2::boolean = true
             OR EXISTS (SELECT 1 FROM user_depot_assignments a
                         WHERE a.depot_id = d.id AND a.user_id = $1))
      ORDER BY d.code`,
    [userId, Boolean(user.all_depots)],
  );

  return {
    id: Number(user.id),
    username: String(user.username),
    fullName: String(user.full_name),
    email: (user.email as string | null) ?? null,
    phone: (user.phone as string | null) ?? null,
    roleKey: String(user.role_key),
    roleName: String(user.role_name),
    roleLevel: Number(user.role_level),
    isSuperAdmin,
    allDepots: Boolean(user.all_depots),
    lastLoginAt: (user.last_login_at as string | null) ?? null,
    permissions,
    components,
    depots,
  };
}

/** Authenticates the request from the Authorization: Bearer header. */
export async function requireUser(req: Request): Promise<UserContext> {
  const header = req.headers.get('authorization') ?? '';
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  if (!token) throw new HttpError(401, 'Please sign in');
  const payload = await verifyToken(token);
  if (!payload) throw new HttpError(401, 'Your session has expired — please sign in again');
  return await loadUserContext(payload.uid);
}

/**
 * Like requireUser but returns null instead of throwing — for best-effort
 * auditing on endpoints that work for anonymous/expired sessions (logout).
 */
export async function optionalUser(req: Request): Promise<UserContext | null> {
  try {
    return await requireUser(req);
  } catch {
    return null;
  }
}

export function hasPermission(
  ctx: UserContext,
  pageKey: string,
  action: keyof PagePermission = 'view',
): boolean {
  if (ctx.isSuperAdmin) return true;
  const page = ctx.permissions[pageKey];
  return Boolean(page && page[action]);
}

/** Page-level gate: requires the given action on the given page (SRS 4.1). */
export function assertPermission(
  ctx: UserContext,
  pageKey: string,
  action: keyof PagePermission = 'view',
): void {
  if (!hasPermission(ctx, pageKey, action)) {
    throw new HttpError(
      403,
      `You do not have "${action}" permission on ${pageKey.replace(/_/g, ' ')}`,
    );
  }
}

/** Throws unless the user may access the given depot (SRS 4.2). */
export function assertDepotAccess(ctx: UserContext, depotId: unknown): number {
  const id = Number(depotId);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(403, 'A valid depot is required');
  if (ctx.isSuperAdmin || ctx.allDepots) return id;
  if (!ctx.depots.some((d) => d.id === id)) {
    throw new HttpError(403, 'You do not have access to this depot');
  }
  return id;
}
