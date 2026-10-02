/**
 * `api` edge function — the Express server's replacement. Serves every
 * /api endpoint for the web client with identical paths, payloads and error
 * envelopes; only the transport changed (bearer JWT instead of httpOnly
 * cookie). CORS preflight, central auth and error mapping live here; route
 * modules sit in ./routes/* and share ../_shared/*.
 */
import { fail, handleOptions, HttpError, json, routePath } from '../_shared/http.ts';
import { optionalUser, requireUser } from '../_shared/auth.ts';
import type { UserContext } from '../_shared/auth.ts';
import type { Ctx, ModuleHandler } from './_ctx.ts';
import { handleAuth } from './routes/auth.ts';
import { handleUsers } from './routes/users.ts';
import { handleRoles } from './routes/roles.ts';
import { handleDepots } from './routes/depots.ts';
import { handleSettings } from './routes/settings.ts';
import { handleNotifications } from './routes/notifications.ts';
import { handleAuditLogs } from './routes/auditLogs.ts';
import { handleReports } from './routes/reports.ts';
import { handleDashboard } from './routes/dashboard.ts';
import { handleMeta } from './routes/meta.ts';
import { handleCustomers, handleSuppliers } from './routes/accounts.ts';
import { handleFlows } from './routes/flows.ts';
import { handleStockValue } from './routes/stockValue.ts';

/** Mount order mirrors server/src/routes/index.js (buildApiRouter). */
const MODULES: ModuleHandler[] = [
  handleAuth,
  handleUsers,
  handleRoles,
  handleDepots,
  handleSettings,
  handleNotifications,
  handleAuditLogs,
  handleReports,
  handleDashboard,
  handleMeta,
  handleCustomers,
  handleSuppliers,
  handleFlows,
  handleStockValue,
];

async function serve(req: Request): Promise<Response> {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  const url = new URL(req.url);
  const path = routePath(url.pathname, 'api');
  const method = req.method.toUpperCase();

  // GET /health — mirrors the Express liveness endpoint (public).
  if (method === 'GET' && path === '/health') {
    return json({ ok: true, env: 'edge', time: new Date().toISOString() });
  }

  // Central authentication: every route but login/logout/health presents a
  // bearer token (the same app JWT the mobile app already uses). Logout is
  // best-effort so signing out never fails on an expired token.
  const isLogin = method === 'POST' && path === '/auth/login';
  const isLogout = method === 'POST' && path === '/auth/logout';
  const user: UserContext | null = isLogin
    ? null
    : isLogout
      ? await optionalUser(req)
      : await requireUser(req);

  const ctx: Ctx = { req, url, method, path, user: user as UserContext };
  for (const mod of MODULES) {
    const res = await mod(ctx);
    if (res) return res;
  }
  return fail(`Not found: ${method} ${path}`, 404);
}

/** Maps failures to the Express envelope: { error: { message } }. */
function toErrorResponse(err: unknown): Response {
  if (err instanceof HttpError) return fail(err.message, err.status);

  const e = err as { code?: string; message?: string } | null;
  const code = e?.code;
  const message = e?.message ?? '';
  if (code === '23505') return fail('A record with these details already exists', 409);
  if (code === '23514') return fail('Value violates a database constraint', 400);
  // Connection/pool exhaustion. Postgres class 08 (connection exception),
  // 53300 (too_many_connections), and the Supavisor session-mode cap surfaced
  // as XX000 with "(EMAXCONNSESSION)" are all transient — tell the client to
  // retry rather than reporting a hard 500.
  const poolFull = /EMAXCONNSESSION|max clients reached|too many clients/i.test(message);
  if (code === '53300' || poolFull || (code && code.startsWith('08'))) {
    return fail('The database is busy right now, please try again in a moment.', 503);
  }

  console.error('[api] unhandled error:', err);
  return fail('Internal server error', 500);
}

Deno.serve((req) => serve(req).catch((err) => toErrorResponse(err)));
