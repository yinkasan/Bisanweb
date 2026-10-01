# Multi-Depot Financial & Operations Management System

A complete multi-depot management platform: React web app, Express API, PostgreSQL
(Supabase-ready), Supabase Edge Functions, and a Flutter mobile app — all sharing
one database, one permission model, and one authentication scheme.

```
Depot/
├── server/     Express API + PostgreSQL access layer + migrations/seed
├── client/     React 19 + Vite + Tailwind web application
├── mobile/     Flutter app (Android, iOS, web)
└── supabase/   Edge Functions (mobile-api, alerts-worker) + config
```

---

## 1. Quickstart (local, zero external services)

Requires Node.js 20+.

```bash
npm install                 # installs server + client workspaces
npm run db:start            # boots an embedded PostgreSQL on port 5433 (first run downloads it)
npm run dev:server          # API on http://localhost:4000
npm run dev:client          # web app on http://localhost:5173
```

On first boot the server applies migrations, the base seed, and the bootstrap
administrator automatically. To load rich demo data (users, depots, customers,
suppliers, sales, payments, expenses):

```bash
npm run seed:demo
```

### Demo logins

| Username     | Password     | Role                    | Depots        |
| ------------ | ------------ | ----------------------- | ------------- |
| `superadmin` | `Admin@2026` | Super Administrator     | all           |
| `admin`      | `Demo@2026`  | Depot Administrator     | ABU, BIS      |
| `sales1`     | `Demo@2026`  | Sales Representative    | ABU           |
| `staff1`     | `Demo@2026`  | Staff (stock/expenses)  | ABU           |

---

## 2. Using Supabase as the database

The app talks plain PostgreSQL, so Supabase is a connection-string change.

1. Create a project at [supabase.com](https://supabase.com) and copy the
   **Session pooler** connection string
   (Project Settings → Database → Connection string).
2. Put it in `server/.env` (copy from `server/.env.example`):

   ```env
   DATABASE_URL=postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
   JWT_SECRET=<same secret used by the edge functions>
   ```

   TLS is detected automatically for Supabase hosts; URL-encode special
   characters in the password (`@` → `%40`).
3. Push the schema and seed:

   ```bash
   npm run db:push       # migrations + base seed (idempotent)
   npm run seed:demo     # optional demo data
   ```

The API then runs against Supabase with no code changes. Because authentication
is stateless JWT, the same `JWT_SECRET` lets the edge functions, the Express
API, and both clients accept each other's tokens.

---

## 3. Supabase Edge Functions

Two Deno functions live in `supabase/functions/`:

- **`mobile-api`** — REST backend for the Flutter app (login, dashboards,
  cash/credit sales, customers, ledger, notifications).
- **`alerts-worker`** — scheduled idempotent sweep that raises debt-threshold
  notifications (run via pg_cron + pg_net).

Deploy, set secrets, and schedule both by following
[`supabase/functions/README.md`](supabase/functions/README.md). Summary:

```bash
supabase link --project-ref <project-ref>
supabase secrets set DATABASE_URL="postgresql://..." JWT_SECRET="..." CRON_SECRET="..."
supabase functions deploy mobile-api alerts-worker
```

Type-check locally anytime with:

```bash
npx --yes -p typescript@5.6.3 tsc --noEmit -p supabase/tsconfig.json
```

---

## 4. Flutter mobile app

Requires the Flutter SDK. The app works against either backend (Express or the
`mobile-api` edge function) — the response contracts are identical.

```bash
cd mobile
flutter pub get
flutter run                                   # Android emulator -> http://10.0.2.2:4000/api
```

Point it at a different backend with `--dart-define`:

```bash
# Physical device on your LAN (replace with your machine's IP)
flutter run --dart-define=API_BASE_URL=http://192.168.1.20:4000/api

# Deployed Supabase edge function
flutter run --dart-define=API_BASE_URL=https://<project-ref>.supabase.co/functions/v1/mobile-api
```

The UI adapts from phones (bottom navigation, bottom-sheet forms) to tablets
and laptops (navigation rail, wider grids) with a single codebase.

---

## 5. Concurrent multi-user & mobile/laptop usage

- **Stateless JWT auth** — no server-side sessions, so any number of users,
  devices, and backend instances (Express or edge) can serve simultaneously.
  Web uses an httpOnly cookie; mobile and scripts use
  `Authorization: Bearer <token>` (returned by `POST /api/auth/login`).
- **Connection pooling** — the server pool defaults to 10 connections
  (`DB_POOL_MAX`), short-lived queries, `connectionTimeoutMillis: 15000`.
  Edge functions use postgres.js with `prepare: false`, which is required for
  Supabase Supavisor transaction pooling.
- **Multi-origin CORS** — set `CLIENT_ORIGIN` to a comma-separated list to
  serve several web origins (e.g. LAN laptop + localhost) from one API.
- **Responsive web** — mobile drawer navigation, overflow-safe tables,
  touch-sized inputs (`text-base` on mobile to prevent iOS zoom), adaptable
  modals and filters. Works from a 360 px phone to a wide desktop.
- **All state lives in PostgreSQL** — atomic transactions via `withTransaction`,
  server-generated timestamps in the app timezone, and a complete audit trail
  so concurrent edits stay traceable.

---

## 6. Verification

```bash
npm run test:acceptance   # SRS section 41 acceptance tests
node server/scripts/smoke.js   # HTTP smoke tests (21 checks, incl. bearer auth)
npm run build             # client production build
cd mobile && flutter analyze   # mobile static analysis
```

---

## 7. Environment reference (`server/.env`)

| Variable                    | Default                  | Purpose                                   |
| --------------------------- | ------------------------ | ----------------------------------------- |
| `DATABASE_URL`              | embedded local Postgres  | Supabase or any Postgres                  |
| `DB_SSL`                    | auto for Supabase        | force TLS on/off                          |
| `DB_POOL_MAX`               | `10`                     | pool size under concurrent load           |
| `PORT`                      | `4000`                   | API port                                  |
| `CLIENT_ORIGIN`             | `http://localhost:5173`  | comma-separated allowed web origins       |
| `JWT_SECRET`                | dev default              | sign tokens — keep identical on edge      |
| `JWT_EXPIRES_IN`            | `12h`                    | token lifetime                            |
| `BOOTSTRAP_ADMIN_USERNAME`  | `superadmin`             | first admin (created when users empty)    |
| `BOOTSTRAP_ADMIN_PASSWORD`  | `Admin@2026`             | first admin password                      |
