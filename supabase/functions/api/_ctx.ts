/**
 * Shared plumbing for the `api` edge function modules. Each route module
 * exports a handler that receives the request context and returns a Response
 * — or null when the path does not belong to it, letting index.ts continue to
 * the next module (mirroring Express router mounting order).
 */
import { HttpError } from '../_shared/http.ts';
import type { UserContext } from '../_shared/auth.ts';

export interface Ctx {
  req: Request;
  url: URL;
  method: string;
  /** Path below the function root, e.g. /users/4/role */
  path: string;
  /**
   * Authenticated user. index.ts rejects every non-public request without a
   * valid bearer token, so route modules can treat it as non-null; only the
   * best-effort logout path ever sees null here.
   */
  user: UserContext;
}

export type ModuleHandler = (c: Ctx) => Promise<Response | null>;

/** Parses the JSON body, tolerating empty bodies like Express' json({}). */
export async function bodyOf(req: Request): Promise<Record<string, any>> {
  return await req.json().catch(() => ({} as Record<string, any>));
}

/**
 * Returns the remainder path below `prefix` ('/' when the request hits the
 * prefix itself), or null if the path is outside the module's mount point.
 */
export function under(path: string, prefix: string): string | null {
  if (path === prefix) return '/';
  if (path.startsWith(`${prefix}/`)) return path.slice(prefix.length);
  return null;
}

/** Port of parsePagination() in server/src/utils/stamps.js. */
export function parsePagination(
  sp: URLSearchParams,
  defaultPageSize = 50,
  maxPageSize = 500,
): { page: number; pageSize: number; offset: number } {
  const page = Math.max(1, Number(sp.get('page')) || 1);
  const pageSize = Math.min(maxPageSize, Math.max(1, Number(sp.get('pageSize')) || defaultPageSize));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

/** 404 with the Express "Record not found" message. */
export function notFound(message = 'Record not found'): never {
  throw new HttpError(404, message);
}

export function badRequest(message: string): never {
  throw new HttpError(400, message);
}

export function conflict(message: string): never {
  throw new HttpError(409, message);
}

/**
 * Builds a CSV file, ported from reports.routes.js — including the
 * formula-injection neutralisation for spreadsheet safety.
 */
export function toCsv(
  columns: { key: string; label: string }[],
  rows: Record<string, unknown>[],
): string {
  const escape = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    let s = String(v);
    if (/^[=+\-@]/.test(s)) s = `'${s}`;
    if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const header = columns.map((c) => escape(c.label)).join(',');
  const lines = rows.map((r) => columns.map((c) => escape(r[c.key])).join(','));
  return `${header}\n${lines.join('\n')}\n`;
}

/** CSV download response (the client fetches it with the bearer header). */
export function csvResponse(filename: string, csv: string, corsHeaders: Record<string, string>): Response {
  return new Response(csv, {
    headers: {
      ...corsHeaders,
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}
