/**
 * Server-generated stamps + input validation, mirroring
 * server/src/utils/stamps.js so edge-created rows are indistinguishable from
 * Express-created ones. Entry date/time are always produced here — never
 * typed by the user (SRS §26).
 */
import { HttpError } from './http.ts';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function timeZone(): string {
  return Deno.env.get('APP_TIMEZONE') ?? 'Africa/Lagos';
}

function isoDate(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone(),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function serverStamps(now = new Date()): { entryDate: string; entryTime: string } {
  return {
    entryDate: isoDate(now),
    entryTime: new Intl.DateTimeFormat('en-GB', {
      timeZone: timeZone(),
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(now),
  };
}

export function todayIso(): string {
  return isoDate(new Date());
}

/** Validates an ISO date string (YYYY-MM-DD). */
export function requireDate(value: unknown, fieldName = 'transactionDate'): string {
  if (typeof value !== 'string' || !DATE_RE.test(value)) {
    throw new HttpError(400, `${fieldName} is required and must be a valid date (YYYY-MM-DD)`);
  }
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new HttpError(400, `${fieldName} is not a valid date`);
  return value;
}

export function optionalDate(value: unknown, fieldName = 'date'): string | null {
  if (value === undefined || value === null || value === '') return null;
  return requireDate(value, fieldName);
}

/** Parses a monetary amount: numeric, non-negative, greater than zero. */
export function requireAmount(value: unknown, fieldName = 'amount'): string {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isFinite(n)) throw new HttpError(400, `${fieldName} must be a number`);
  if (n < 0) throw new HttpError(400, `${fieldName} must not be negative`);
  if (n === 0) throw new HttpError(400, `${fieldName} must be greater than zero`);
  return n.toFixed(2);
}

export function optionalString(value: unknown, max = 2000): string | null {
  if (value === undefined || value === null) return null;
  const v = String(value).trim();
  if (v === '') return null;
  if (v.length > max) throw new HttpError(400, `Value must be at most ${max} characters`);
  return v;
}

export function addDays(isoDateString: string, days: number): string {
  const d = new Date(`${isoDateString}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Inclusive range helper for dashboards: defaults to today..today. */
export function resolveRange(searchParams: URLSearchParams): { from: string; to: string; today: string } {
  const today = todayIso();
  const from = optionalDate(searchParams.get('from'), 'from') ?? today;
  const to = optionalDate(searchParams.get('to'), 'to') ?? from;
  if (from > to) throw new HttpError(400, '"from" date must not be after "to" date');
  return { from, to, today };
}
