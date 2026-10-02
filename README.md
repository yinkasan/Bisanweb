# Multi-Depot Financial & Operations Management System

A complete multi-depot management platform: React web app on Vercel, Supabase
Edge Functions API, Supabase (PostgreSQL) database, and a Flutter mobile app —
all sharing one database, one permission model, and one authentication scheme.

```
Depot/
├── client/     React 19 + Vite + Tailwind web application (deployed to Vercel)
├── mobile/     Flutter app (Android, iOS, web)
├── supabase/   Edge Functions (api, mobile-api, alerts-worker) + migrations + seed
└── scripts/    smoke.mjs — end-to-end checks against the deployed api function
```

There is **no application server** anymore: every former Express endpoint is
served by the `api` edge function, so the web client is a static build and the
backend scales with Supabase's function infrastructure.

---

## 1. Quickstart (local development)

Requires Node.js 20+ and the deployed edge functions (see §3) — or Docker +
`supabase functions serve api` for a fully local loop.

```bash
npm install                          # installs the client workspace
Copy-Item client\.env.example client\.env.local   # points the app at the deployed api function
npm run dev                          # web app on http://localhost:5173
```

The web app talks straight to `VITE_API_URL` (the deployed `api` function);
CORS is open on the function, so no proxy is needed.

### Demo logins

| Username     | Password     | Role                    | Depots        |
| ------------ | ------------ | ----------------------- | ------------- |
| `superadmin` | `Admin@2026` | Super Administrator     | all           |

Change this password after first login. (The old demo users came from the
local `seed:demo` data set, which was retired along with the local database.)

---

## 2. Database: Supabase

The database is the hosted Supabase project (`cayshvamuqdlhmkspjwq`); the
schema lives in `supabase/migrations/*.sql` and the baseline data in
`supabase/seed.sql` (roles, permission catalogue, expense categories, system
settings, depots, bootstrap Super Admin — all idempotent).

Against a fresh project:

```bash
supabase link --project-ref <project-ref>
supabase db push            # applies supabase/migrations
psql "$DATABASE_URL" -f supabase/seed.sql   # baseline seed
```

The production database already has this schema applied. If you add migration
files, record them on the remote with `supabase migration repair` so the CLI's
history table stays in sync.

---

## 3. Supabase Edge Functions

Three Deno functions live in `supabase/functions/`:

- **`api`** — the full web API (auth, users, roles, depots, settings,
  notifications, audit trail, reports + CSV, dashboards, customers/suppliers,
  the seven financial flow pages, stock value). The Express server's exact
  endpoints, payloads and error envelopes over bearer-token transport.
- **`mobile-api`** — REST backend for the Flutter app.
- **`alerts-worker`** — scheduled idempotent sweep that raises debt-threshold
  notifications (run via pg_cron + pg_net).

Deploy and set secrets (secrets are shared project-wide, so mobile-api's
existing values already cover `api` — verify with `supabase secrets list`):

```bash
supabase link --project-ref cayshvamuqdlhmkspjwq
supabase secrets set DATABASE_URL="postgresql://...pooler...:5432/postgres" \
                    JWT_SECRET="<the app's HS256 secret>" \
                    APP_TIMEZONE="Africa/Lagos"
supabase functions deploy api
```

`JWT_SECRET` must be identical across the `api` function, `mobile-api`, and the
Flutter app — the same token is accepted by all three.

Local loop (requires Docker):

```bash
supabase functions serve api      # http://localhost:54321/functions/v1/api
```

Type-check locally anytime with:

```bash
npm run typecheck    # tsc --noEmit -p supabase/tsconfig.json
```

---

## 4. Web deployment (Vercel)

The client is a pure static SPA.

1. Import the repo on Vercel; framework preset **Vite**.
2. Root Directory: `client` (build command `npm run build`, output `client/dist`).
   `client/vercel.json` already contains the SPA rewrite.
3. Environment variable `VITE_API_URL` =
   `https://<project-ref>.supabase.co/functions/v1/api` (production **and**
   preview).
4. No backend env vars are needed — the function API is open-CORS by design
   and authenticated by the app JWT.

---

## 5. Flutter mobile app

Requires the Flutter SDK. The app works against either backend (the `api` or
the `mobile-api` edge function) — the response contracts are identical.

```bash
cd mobile
flutter pub get
flutter run --dart-define=API_BASE_URL=https://<project-ref>.supabase.co/functions/v1/mobile-api
```

The UI adapts from phones (bottom navigation, bottom-sheet forms) to tablets
and laptops (navigation rail, wider grids) with a single codebase.

---

## 6. Concurrent multi-user & session model

- **Stateless JWT auth** — no server-side sessions. All clients (web, mobile,
  scripts) send `Authorization: Bearer <token>` issued by `POST /auth/login`;
  the web stores it in `localStorage` (`depot_token`) and clears it on 401.
- **Session policy** — the idle sign-out window (`session_idle_minutes`) is
  delivered with login and every `/auth/me` refresh; clients enforce it.
- **Connection pooling** — edge functions use postgres.js with
  `prepare: false`, which is required for Supabase Supavisor transaction
  pooling.
- **All state lives in PostgreSQL** — atomic transactions via
  `withTransaction`, server-generated timestamps in the app timezone, and a
  complete audit trail so concurrent edits stay traceable.

---

## 7. Verification

```bash
npm run typecheck       # edge functions compile
npm run build           # client production build
npm run smoke           # ~30 end-to-end checks against the deployed api function
cd mobile && flutter analyze   # mobile static analysis
```

Override the smoke target/credentials with `API_URL`, `SMOKE_USERNAME`,
`SMOKE_PASSWORD` env vars.

---

## 8. Environment reference

Client (`client/.env.local`, build-time):

| Variable       | Default                                                       | Purpose                    |
| -------------- | ------------------------------------------------------------- | -------------------------- |
| `VITE_API_URL` | `https://cayshvamuqdlhmkspjwq.supabase.co/functions/v1/api`   | deployed api function URL  |

Edge function secrets (project-wide, via `supabase secrets set`):

| Variable        | Purpose                                            |
| --------------- | -------------------------------------------------- |
| `DATABASE_URL`  | Supabase pooler connection string                  |
| `JWT_SECRET`    | HS256 signing secret (shared: web, api, mobile)    |
| `JWT_EXPIRES_IN`| Token lifetime, default `12h`                      |
| `APP_TIMEZONE`  | `Africa/Lagos` — entry stamps and daily rollover   |
| `CRON_SECRET`   | alerts-worker shared secret                        |
