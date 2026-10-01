import 'dotenv/config';

const LOCAL_DATABASE_URL = 'postgres://postgres:depot_dev_password@127.0.0.1:5433/depot';

/**
 * Resolves the Postgres connection.
 * DATABASE_URL accepts any Postgres — a hosted Supabase project (hosted mode)
 * or the local embedded cluster started by `npm run db:start`.
 * TLS turns on automatically for Supabase / sslmode URLs (force it with
 * DB_SSL=true|false). Certificates are not CA-pinned so Supabase pooler or
 * region changes keep working without config edits.
 */
function resolveDb() {
  const connectionString = process.env.DATABASE_URL || LOCAL_DATABASE_URL;
  const explicit = process.env.DB_SSL;
  const wantsSsl = explicit !== undefined
    ? explicit === 'true'
    : /sslmode=/i.test(connectionString) || /supabase\.(co|com)/i.test(connectionString);
  return {
    connectionString,
    // Concurrent multi-user capacity: every request borrows a pooled connection.
    // Raise DB_POOL_MAX when running against Supabase's pooler with many users.
    poolMax: Math.max(1, Number(process.env.DB_POOL_MAX || 10)),
    ssl: wantsSsl ? { rejectUnauthorized: false } : undefined,
  };
}

export const config = {
  port: Number(process.env.PORT || 4000),
  nodeEnv: process.env.NODE_ENV || 'development',
  databaseUrl: process.env.DATABASE_URL || LOCAL_DATABASE_URL,
  db: resolveDb(),
  jwtSecret: process.env.JWT_SECRET || 'dev_secret_replace_in_production',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '12h',
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
  bootstrapAdmin: {
    username: process.env.BOOTSTRAP_ADMIN_USERNAME || 'superadmin',
    password: process.env.BOOTSTRAP_ADMIN_PASSWORD || 'Admin@2026',
    fullName: process.env.BOOTSTRAP_ADMIN_NAME || 'System Administrator',
  },
};

export const isProd = config.nodeEnv === 'production';
