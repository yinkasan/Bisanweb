/**
 * Thin fetch wrapper for the Depot API.
 * - Sends the httpOnly auth cookie on every request.
 * - Throws an ApiError carrying the server's message and status so callers can
 *   show friendly messages and react to 401/403 specifically.
 */
const BASE = '/api';

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

async function request(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
  });

  if (res.status === 204) return null;

  let json = null;
  try { json = await res.json(); } catch { /* non-JSON response */ }

  if (!res.ok) {
    const message = json?.error?.message || json?.message || `Request failed (${res.status})`;
    throw new ApiError(res.status, message, json?.error?.details);
  }
  return json;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body),
  put: (path, body) => request('PUT', path, body),
  del: (path) => request('DELETE', path),
};

/** Builds a query string from an object, dropping empty values. */
export function qs(params) {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v !== undefined && v !== null && v !== '') search.set(k, v);
  }
  const s = search.toString();
  return s ? `?${s}` : '';
}
