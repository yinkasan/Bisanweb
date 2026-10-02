# Supabase Edge Functions — Depot Manager

Three Deno functions share the same Postgres database and JWT secret, so
**web sessions and mobile sessions are interchangeable** — a token issued by
any function works against all of them (`Authorization: Bearer <jwt>`).

| Function        | Purpose                                                                 |
| --------------- | ----------------------------------------------------------------------- |
| `api`           | Full web API for the React client: auth, users, roles, depots, settings, notifications, audit trail, reports + CSV exports, dashboards, customers/suppliers, the seven financial flow pages (cash sales, POS sales, credit sales, customer payments, supplier purchases, supplier payments, depot expenses), stock value. A 1:1 port of the former Express routes — identical paths, payloads, status codes and error envelopes. |
| `mobile-api`    | Mobile REST API for the Flutter app: auth, depot dashboard, cash/credit sales, customers + ledger, notifications. |
| `alerts-worker` | Scheduled threshold sweep: creates/resolves customer & supplier debt alerts (SRS §25). Idempotent. |

Shared modules live in `_shared/` (db with `withTransaction`, auth, audit,
notify, metrics, stamps, sessionPolicy, permissionCatalog, http) and are
direct ports of the former Express services — identical formulas and
contracts, verified by `npm run typecheck`
(`tsc --noEmit -p supabase/tsconfig.json`).

The `api` function is mounted at `/functions/v1/api`; inside it, paths mirror
the Express routers (`/auth/login`, `/dashboard/depot`, `/cash-sales`, …).
`GET /health`, `POST /auth/login` are public; `POST /auth/logout` is
best-effort; everything else requires a valid bearer token, and per-route
permission checks (`assertPermission`, `assertDepotAccess`) enforce the same
access model as the old server.

## 1. Prerequisites

```bash
npm i -g supabase        # or use npx supabase
supabase login
supabase link --project-ref <your-project-ref>
```

## 2. Secrets

Secrets are project-wide — set once, all functions see them:

```bash
supabase secrets set DATABASE_URL="postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres"
supabase secrets set JWT_SECRET="<the app's HS256 secret>"
supabase secrets set CRON_SECRET="<random string>"        # protects alerts-worker
supabase secrets set APP_TIMEZONE="Africa/Lagos"          # entry stamps; optional
```

`DATABASE_URL` may be the Session pooler URI (recommended) or the direct
`db.<ref>.supabase.co` URI — postgres.js runs with `prepare: false`, which is
required for Supavisor transaction pooling. `JWT_SECRET` **must** be the same
value used by `mobile-api` and accepted by the Flutter app, otherwise tokens
won't validate across clients.

> **Connection budget.** Supabase's session-mode pooler caps real backends at
> its `pool_size` (15 by default), shared across all functions and autoscaled
> isolates. `_shared/db.ts` therefore keeps a small pool (`max: 2`) that
> releases idle sockets quickly (`idle_timeout: 3s`), and the `api` router
> maps pool-exhaustion errors (`EMAXCONNSESSION`, code `53300`, SQL class `08`)
> to a retryable **503**. For sustained high concurrency, raise the pooler
> `pool_size` in Dashboard → Database, or point `DATABASE_URL` at the
> transaction-mode pooler (port 6543).

## 3. Deploy

```bash
supabase functions deploy api
supabase functions deploy mobile-api
supabase functions deploy alerts-worker
```

`verify_jwt = false` is configured for all three in `supabase/config.toml` —
they do their own authentication (app JWT / cron secret).

Base URLs after deploy:

```
https://<project-ref>.supabase.co/functions/v1/api
https://<project-ref>.supabase.co/functions/v1/mobile-api
https://<project-ref>.supabase.co/functions/v1/alerts-worker
```

The web client is configured with `VITE_API_URL` pointing at the `api` URL
(see `client/.env.example`); CORS is open on the function, so the static
build (Vercel or local `npm run dev`) calls it directly.

## 4. Schedule alerts-worker (pg_cron + pg_net)

In the Supabase SQL editor (enable the `pg_cron` and `pg_net` extensions in
Dashboard → Database → Extensions first):

```sql
select cron.schedule(
  'depot-alerts-worker',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/alerts-worker',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', '<your-cron-secret>'
    ),
    body := '{}'::jsonb
  ) as request_id;
  $$
);
```

## 5. Local development (needs Docker)

```bash
supabase functions serve api            # http://localhost:54321/functions/v1/api
supabase functions serve api mobile-api --env-file supabase/.env.local
```

Copy `supabase/.env.local.example` → `supabase/.env.local` and fill it in, or
run `supabase functions serve` without `--env-file` while linked to a project
to use the deployed secrets.

Schema and baseline data for a fresh database live in
`supabase/migrations/*.sql` (`supabase db push`) and `supabase/seed.sql`
(idempotent: roles, permission catalogue, expense categories, system
settings, depots, bootstrap superadmin).

## 6. Quick checks

```bash
# api health (public)
curl https://<ref>.supabase.co/functions/v1/api/health

# web login (returns the same bearer token the Flutter app stores)
curl -X POST https://<ref>.supabase.co/functions/v1/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"superadmin","password":"Admin@2026"}'

# authenticated call
curl https://<ref>.supabase.co/functions/v1/api/dashboard/global \
  -H "Authorization: Bearer <token>"

# mobile-api health
curl https://<ref>.supabase.co/functions/v1/mobile-api/health

# sweep (manual)
curl -X POST https://<ref>.supabase.co/functions/v1/alerts-worker \
  -H "x-cron-secret: <your-cron-secret>"
```

A fuller end-to-end pass (~30 checks: auth gates, flow create/correct/
reverse, ledger balance, reports JSON + CSV, audit trail) runs from the repo
root against the deployed `api` function:

```bash
npm run smoke
```
