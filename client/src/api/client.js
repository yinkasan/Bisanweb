/**
 * Thin fetch wrapper for the Depot API (Supabase Edge Function `api`).
 * - Authenticates with `Authorization: Bearer <jwt>` — the same contract the
 *   Flutter app uses. The token is persisted in localStorage on login and
 *   cleared on 401 (expired session) or logout.
 * - Throws an ApiError carrying the server's message and status so callers can
 *   show friendly messages and react to 401/403 specifically.
 */
const BASE = import.meta.env.VITE_API_URL ?? '';

const TOKEN_KEY = 'depot_token';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function authHeaders() {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (res.status === 204) return null;

  let json = null;
  try { json = await res.json(); } catch { /* non-JSON response */ }

  if (!res.ok) {
    if (res.status === 401) clearToken();
    const message = json?.error?.message || json?.message || `Request failed (${res.status})`;
    throw new ApiError(res.status, message, json?.error?.details);
  }

  // The login response carries the bearer token — persist it before the
  // caller touches the session so every subsequent request is signed.
  if (path.endsWith('/auth/login') && json?.token) setToken(json.token);
  return json;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body),
  put: (path, body) => request('PUT', path, body),
  del: (path) => request('DELETE', path),
};

/**
 * Downloads an authenticated CSV (window.open cannot send the bearer
 * header cross-origin) and triggers a browser save via a temporary link.
 */
export async function downloadFile(path, filename) {
  const res = await fetch(`${BASE}${path}`, { headers: authHeaders() });
  if (!res.ok) {
    if (res.status === 401) clearToken();
    let json = null;
    try { json = await res.json(); } catch { /* non-JSON response */ }
    throw new ApiError(res.status, json?.error?.message || `Download failed (${res.status})`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Builds a query string from an object, dropping empty values. */
export function qs(params) {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v !== undefined && v !== null && v !== '') search.set(k, v);
  }
  const s = search.toString();
  return s ? `?${s}` : '';
}
