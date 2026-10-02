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
    // Supabase's session-mode pooler caps backends at pool_size (15 by
    // default). Edge functions autoscale, so keep a tiny per-isolate pool and
    // release idle sockets fast — otherwise lingering connections from warm
    // isolates collectively trip (EMAXCONNSESSION) under burst load.
    max: 2,
    idle_timeout: 3,
    connect_timeout: 10,
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

/**
 * A transaction-scoped query runner. Statements issued through it only become
 * visible on commit — mirrors the `withTransaction(client)` helper the
 * Express API uses for every multi-statement financial write.
 */
export interface Tx {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  queryOne<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>;
}

function wrap(tx: { unsafe: (sql: string, params: unknown[]) => Promise<unknown[]> }): Tx {
  async function run<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await tx.unsafe(sql, params as never[])) as unknown as T[];
  }
  return {
    query: run,
    async queryOne<T>(sql: string, params: unknown[] = []): Promise<T | null> {
      const rows = await run<T>(sql, params);
      return rows.length > 0 ? rows[0] : null;
    },
  };
}

/**
 * Runs `fn` inside a BEGIN/COMMIT transaction, rolling back on any error.
 * All statements — including audit rows — must go through the given `tx` so
 * they commit (or roll back) atomically together.
 */
export async function withTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return (await connect().begin(async (tx) => await fn(wrap(tx)))) as T;
}
