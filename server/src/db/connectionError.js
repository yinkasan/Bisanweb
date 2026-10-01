/**
 * Transient Postgres connection failures.
 *
 * A hosted pooler (Supabase Supavisor) tears down sockets once a project goes
 * quiet, and a suspended project can take tens of seconds to accept its first
 * connection again. Those failures happen while *acquiring* a connection — before
 * any SQL reaches the server — so they are safe to retry and must never be
 * reported to the user as a generic "Internal server error".
 */

/** SQLSTATE codes for connection/session problems, plus pooler saturation. */
const TRANSIENT_SQLSTATE = new Set([
  '08000', // exception_when_expected
  '08001', // sqlclient_unable_to_establish_sqlconnection
  '08003', // connection_does_not_exist
  '08004', // sqlserver_rejected_establishment_of_sqlconnection
  '08006', // connection_failure
  '53300', // too_many_connections (pooler at capacity)
  '53400', // configuration_limit_exceeded
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '58000', // system_error
  '58030', // io_error
]);

/** libuv socket errors surfaced by net/tls before Postgres replies. */
const TRANSIENT_NODE_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

/** node-postgres tears down a socket it never finished handshaking on. */
const TRANSIENT_MESSAGE = /connection terminated|connection timeout|timeout expired/i;

/** Returns true when `err` (or its cause chain) is a retryable connection problem. */
export function isTransientConnectionError(err) {
  if (!err || typeof err !== 'object') return false;
  if (TRANSIENT_SQLSTATE.has(err.code) || TRANSIENT_NODE_CODES.has(err.code)) return true;
  if (typeof err.message === 'string' && TRANSIENT_MESSAGE.test(err.message)) return true;
  const cause = err.cause;
  return cause !== undefined && cause !== null && cause !== err
    ? isTransientConnectionError(cause)
    : false;
}
