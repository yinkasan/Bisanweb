# Supabase Edge Functions — Depot Manager

Two Deno functions share the same Postgres database and JWT secret as the
Express API, so **web sessions (cookie) and mobile sessions (bearer token) are
interchangeable** — a token issued by any backend works against all of them.

| Function        | Purpose                                                                 |
| --------------- | ----------------------------------------------------------------------- |
| `mobile-api`    | Mobile REST API for the Flutter app: auth, depot dashboard, cash/credit sales, customers + ledger, notifications. |
| `alerts-worker` | Scheduled threshold sweep: creates/resolves customer & supplier debt alerts (SRS §25). Idempotent. |

Shared modules live in `_shared/` (db, auth, audit, notify, metrics, stamps,
http) and are direct ports of the Express services — identical formulas and
contracts, verified by `npx tsc --noEmit -p supabase/tsconfig.json`.

## 1. Prerequisites

```bash
npm i -g supabase        # or use npx supabase
supabase login
supabase link --project-ref <your-project-ref>
```

## 2. Secrets

The functions need the same values the Express API uses:

```bash
supabase secrets set DATABASE_URL="postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres"
supabase secrets set JWT_SECRET="<same value as server/.env JWT_SECRET>"
supabase secrets set CRON_SECRET="<random string>"        # protects alerts-worker
supabase secrets set APP_TIMEZONE="Africa/Lagos"          # entry stamps; optional
```

`DATABASE_URL` may be the Session pooler URI (recommended) or the direct
`db.<ref>.supabase.co` URI. `JWT_SECRET` **must** match the server's, otherwise
tokens won't validate across backends.

## 3. Deploy

```bash
supabase functions deploy mobile-api
supabase functions deploy alerts-worker
```

`verify_jwt = false` is configured in `supabase/config.toml` — these functions
do their own authentication (app JWT / cron secret).

Base URL after deploy:

```
https://<project-ref>.supabase.co/functions/v1/mobile-api
https://<project-ref>.supabase.co/functions/v1/alerts-worker
```

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
supabase functions serve mobile-api --env-file supabase/.env.local
```

Copy `supabase/.env.local.example` → `supabase/.env.local` and fill it in.

## 6. Quick checks

```bash
# health
curl https://<ref>.supabase.co/functions/v1/mobile-api/health

# login (returns the bearer token the Flutter app stores)
curl -X POST https://<ref>.supabase.co/functions/v1/mobile-api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"superadmin","password":"Admin@2026"}'

# cash sales list
curl "https://<ref>.supabase.co/functions/v1/mobile-api/cash-sales?page=1" \
  -H "Authorization: Bearer <token>"

# sweep (manual)
curl -X POST https://<ref>.supabase.co/functions/v1/alerts-worker \
  -H "x-cron-secret: <your-cron-secret>"
```
