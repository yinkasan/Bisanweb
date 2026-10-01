import pg from 'pg';
import { config } from '../config.js';
import { isTransientConnectionError } from './connectionError.js';

const { Pool } = pg;

/**
 * node-postgres returns NUMERIC as string by default, which is actually good
 * for precision. We keep that behaviour and format on the client, but the
 * type parsers below make DATE come back as a plain YYYY-MM-DD string instead
 * of a JS Date shifted by timezone, which keeps transaction dates stable.
 */
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

const poolConfig = {
  connectionString: config.db.connectionString,
  max: config.db.poolMax,
  // Hosted poolers (Supabase) drop quiet sockets, and a project that has been
  // suspended takes a while to accept a fresh connection. Keeping one warm,
  // enabled socket-level keepalive, and widening the idle window means a login
  // after a long pause reuses a live connection instead of racing a cold
  // handshake — which previously surfaced as a 500 on the login screen.
  min: 1,
  keepAlive: true,
  keepAliveInitialDelay: 10000,
  idleTimeoutMillis: 60000,
  // Two acquire attempts fit inside the mobile client's 30s request timeout.
  connectionTimeoutMillis: 12000,
};
// TLS for hosted Postgres (Supabase); omitted entirely for local clusters.
if (config.db.ssl) poolConfig.ssl = config.db.ssl;

export const pool = new Pool(poolConfig);

pool.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.error('[db] unexpected idle client error', err);
});

// Periodic ping: keeps the reserved connection from being reaped by the pooler
// and keeps a hosted project marked as active. unref() so it never blocks exit.
const HEARTBEAT_MS = 45000;
setInterval(() => {
  pool.query('SELECT 1').catch((err) => {
    // eslint-disable-next-line no-console
    console.warn('[db] heartbeat failed:', err.message);
  });
}, HEARTBEAT_MS).unref();

const ACQUIRE_ATTEMPTS = 2;

/**
 * Borrows a pooled client, retrying once when the failure is a dead or cold
 * socket. Only the acquisition is retried, so no statement can run twice.
 */
async function acquire() {
  let lastError;
  for (let attempt = 1; attempt <= ACQUIRE_ATTEMPTS; attempt += 1) {
    try {
      return await pool.connect();
    } catch (err) {
      if (!isTransientConnectionError(err)) throw err;
      lastError = err;
      // eslint-disable-next-line no-console
      console.warn(`[db] connection attempt ${attempt}/${ACQUIRE_ATTEMPTS} failed: ${err.message}`);
    }
  }
  throw lastError;
}

export async function query(text, params) {
  const client = await acquire();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

/** Runs `fn` inside a transaction, rolling back on error. */
export async function withTransaction(fn) {
  const client = await acquire();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Money values are kept as strings end-to-end; this normalises to 2dp string. */
export function money(value) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return '0.00';
  return n.toFixed(2);
}
