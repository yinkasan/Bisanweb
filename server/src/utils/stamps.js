import { badRequest } from '../middleware/errors.js';

/**
 * Server-generated audit stamps. The SRS requires that entry date/time are
 * produced by the server, never typed by the user.
 */
export function serverStamps(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return {
    entryDate: `${y}-${m}-${d}`,
    entryTime: `${hh}:${mm}:${ss}`,
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Validates and normalises an ISO date string (YYYY-MM-DD). */
export function requireDate(value, fieldName = 'transactionDate') {
  if (typeof value !== 'string' || !DATE_RE.test(value)) {
    throw badRequest(`${fieldName} is required and must be a valid date (YYYY-MM-DD)`);
  }
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw badRequest(`${fieldName} is not a valid date`);
  return value;
}

export function optionalDate(value, fieldName = 'date') {
  if (value === undefined || value === null || value === '') return null;
  return requireDate(value, fieldName);
}

/** Parses a monetary amount: must be numeric and non-negative. */
export function requireAmount(value, { fieldName = 'amount', allowZero = false } = {}) {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isFinite(n)) throw badRequest(`${fieldName} must be a number`);
  if (n < 0) throw badRequest(`${fieldName} must not be negative`);
  if (!allowZero && n === 0) throw badRequest(`${fieldName} must be greater than zero`);
  return n.toFixed(2);
}

export function requireString(value, fieldName, { max = 500 } = {}) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw badRequest(`${fieldName} is required`);
  }
  const v = value.trim();
  if (v.length > max) throw badRequest(`${fieldName} must be at most ${max} characters`);
  return v;
}

export function optionalString(value, { max = 2000 } = {}) {
  if (value === undefined || value === null) return null;
  const v = String(value).trim();
  if (v === '') return null;
  if (v.length > max) throw badRequest(`Value must be at most ${max} characters`);
  return v;
}

export function requireInt(value, fieldName) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw badRequest(`${fieldName} must be a positive integer`);
  return n;
}

export function parsePagination(query, { defaultPageSize = 50, maxPageSize = 500 } = {}) {
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(maxPageSize, Math.max(1, Number(query.pageSize) || defaultPageSize));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

/** Adds one day to an ISO date string. */
export function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Inclusive range helper for dashboards: defaults to today..today. */
export function resolveRange(query) {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const from = optionalDate(query.from, 'from') || today;
  const to = optionalDate(query.to, 'to') || from;
  if (from > to) throw badRequest('"from" date must not be after "to" date');
  return { from, to, today };
}
