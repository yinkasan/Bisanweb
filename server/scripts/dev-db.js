/**
 * Local development PostgreSQL.
 *
 * Starts a real PostgreSQL cluster (bundled binaries) on a local port using
 * the local default credentials. This is only a development convenience —
 * for a hosted database (Supabase) set DATABASE_URL in server/.env and skip
 * this script entirely.
 *
 *   node scripts/dev-db.js              # init (if needed), start, keep running
 *   node scripts/dev-db.js --init-only  # init, create db, stop
 *   node scripts/dev-db.js --reset      # wipe the local cluster and re-init
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import EmbeddedPostgres from 'embedded-postgres';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * This script only ever starts a LOCAL cluster. If DATABASE_URL points at a
 * remote host (e.g. Supabase), fall back to the local default so `db:start`
 * never tries to host a copy of a hosted database.
 */
function localDatabaseUrl() {
  const fallback = 'postgres://postgres:depot_dev_password@127.0.0.1:5433/depot';
  const raw = process.env.DATABASE_URL;
  if (!raw) return new URL(fallback);
  try {
    const u = new URL(raw);
    if (['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname)) return u;
  } catch {
    // malformed URL — use the local default
  }
  return new URL(fallback);
}

const databaseUrl = localDatabaseUrl();

const port = Number(databaseUrl.port || 5433);
const user = decodeURIComponent(databaseUrl.username);
const password = decodeURIComponent(databaseUrl.password);
const dbName = databaseUrl.pathname.replace(/^\//, '') || 'depot';

const dataDir = path.join(__dirname, '..', 'data', 'pg');

const log = (m) => process.stdout.write(`[pg] ${m}\n`);

// `--reset` wipes this script's own data directory before re-initialising.
// Refuse to touch anything that is not the expected `data/pg` directory.
if (process.argv.includes('--reset')) {
  if (!dataDir.endsWith(path.join('data', 'pg'))) {
    throw new Error(`Refusing to reset unexpected path: ${dataDir}`);
  }
  log(`reset requested — removing ${dataDir}`);
  try {
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  } catch (err) {
    throw new Error(
      `Could not remove ${dataDir} (${err.message}). ` +
      'Make sure no PostgreSQL or db:start process is still running.'
    );
  }
}

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  port,
  user,
  password,
  persistent: true,
  // WIN1252 (the Windows default) cannot store characters such as the naira
  // sign; initialise the cluster as UTF8.
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
  onLog: (m) => process.stdout.write(`[pg:out] ${m}\n`),
  onError: (m) => process.stderr.write(`[pg:err] ${m}\n`),
});

const alreadyInitialised = fs.existsSync(path.join(dataDir, 'PG_VERSION'));

if (!alreadyInitialised) {
  log(`initialising cluster in ${dataDir}`);
  await pg.initialise();
} else {
  log(`using existing cluster in ${dataDir}`);
}

// On Windows a just-stopped cluster can hold its shared memory block for a
// couple of seconds; retry once after a short wait.
let started = false;
for (let attempt = 1; attempt <= 3 && !started; attempt += 1) {
  try {
    await pg.start();
    started = true;
  } catch (err) {
    const msg = String(err?.message || err);
    if (attempt < 3 && /shared memory block is still in use/i.test(msg)) {
      log(`shared memory still held, retrying (${attempt}/3)...`);
      await new Promise((r) => setTimeout(r, 3000));
    } else {
      throw err;
    }
  }
}
log(`PostgreSQL listening on 127.0.0.1:${port} (user "${user}")`);

try {
  await pg.createDatabase(dbName);
  log(`database "${dbName}" created`);
} catch (err) {
  const msg = String(err?.message || err);
  if (/already exists/i.test(msg)) {
    log(`database "${dbName}" already exists`);
  } else {
    throw err;
  }
}

if (process.argv.includes('--init-only')) {
  await pg.stop();
  log('stopped');
  process.exit(0);
}

log('running — press Ctrl+C to stop');

const shutdown = async () => {
  log('stopping...');
  try {
    await pg.stop();
  } finally {
    process.exit(0);
  }
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Keep the process alive while the cluster runs.
setInterval(() => {}, 1 << 30);
