/**
 * Postgres access for edge functions via postgres.js (Deno-compatible TCP
 * client). DATABASE_URL is the same connection string the Express API uses —
 * Supabase Session pooler or direct URL. `prepare: false` keeps the client
 * compatible with Supavisor transaction pooling.
 */
import postgres from 'npm:postgres@3.4.5';

let client: ReturnType<typeof postgres> | null = null;

function connect(): ReturnType<typeof postgres> {
  if (client) return client;
  const url = Deno.env.get('DATABASE_URL');
  if (!url) {
    throw new Error('DATABASE_URL secret is not set for this function');
  }
  client = postgres(url, {
    max: 4,
    idle_timeout: 20,
    connect_timeout: 15,
    prepare: false,
    onnotice: () => {},
    types: {
      // Keep DATE columns as plain 'YYYY-MM-DD' strings (same contract as the
      // Express API, which yanks pg's default Date parser for OID 1082).
      date: {
        to: 1082,
        from: [1082],
        serialize: (x: unknown) => x,
        parse: (x: string) => x,
      },
    },
  });
  return client;
}

/** Parameterised query returning plain rows. */
export async function query<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const rows = await connect().unsafe(sql, params as never[]);
  return rows as unknown as T[];
}

/** Parameterised query returning the first row or null. */
export async function queryOne<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows.length > 0 ? rows[0] : null;
}
