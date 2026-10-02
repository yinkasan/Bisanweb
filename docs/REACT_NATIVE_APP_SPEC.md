# Bisan Ventures — Multi-Depot Financial & Operations System

## Complete API Documentation & React Native Mobile App Development Specification

**Version:** 1.0 · **Date:** September 2026 · **Status:** Production system (not an MVP)

> **Purpose of this document.** This is the single, complete reference for building a
> cross-platform **React Native** mobile application for the Bisan Ventures multi-depot
> financial management system. It contains every fact the app needs: the Supabase
> project endpoints, the full REST API contract (both backends), the complete database
> schema, the authentication and permission model, the branding/design system, and a
> concrete screen-by-screen build specification. An AI agent (or human developer)
> should be able to build a professional, production-grade app from this document
> alone, without needing to read the server source code.
>
> A working **Flutter** reference implementation already exists in `mobile/` (see
> §10.9). The React Native app must reach feature parity with it and follow the same
> API contracts exactly.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Supabase Project & Environment](#2-supabase-project--environment)
3. [Authentication & Session Management](#3-authentication--session-management)
4. [API Conventions](#4-api-conventions)
5. [Database Schema (Complete)](#5-database-schema-complete)
6. [Mobile API — Supabase Edge Function `mobile-api`](#6-mobile-api--supabase-edge-function-mobile-api)
7. [Express API — Complete Endpoint Reference](#7-express-api--complete-endpoint-reference)
8. [Business Rules & Financial Formulas](#8-business-rules--financial-formulas)
9. [Branding & Design System](#9-branding--design-system)
10. [React Native Application Specification](#10-react-native-application-specification)
11. [Deployment, Operations & Testing](#11-deployment-operations--testing)
12. [Appendices — Catalogues & Enums](#12-appendices--catalogues--enums)

---

## 1. System Overview

**Bisan Ventures** is a Nigerian company operating two depots (**ABU** and **Bisan/BIS**).
The product is a multi-depot financial and operations management system that records
daily money flows per depot — cash sales, POS sales, credit sales, customer payments,
supplier purchases, supplier payments, depot expenses, and daily stock valuations —
and derives all balances and dashboards from those transactions.

### 1.1 Architecture

```
┌──────────────────┐        ┌───────────────────────────┐
│  React web app   │        │  Mobile app (React Native) │
│  client/ (Vite)  │        │  Bearer token auth         │
└────────┬─────────┘        └────────────┬──────────────┘
         │ httpOnly cookie               │ Authorization: Bearer <JWT>
         ▼                               ▼
┌─────────────────────┐       ┌──────────────────────────────┐
│ Express API         │       │ Supabase Edge Function       │
│ server/  port 4000  │       │ mobile-api (Deno, deployed)  │
│ (dev / self-host)   │       │ alerts-worker (cron sweep)   │
└─────────┬───────────┘       └──────────────┬───────────────┘
          │                                  │
          └────────────┬─────────────────────┘
                       ▼
        ┌──────────────────────────────────┐
        │ PostgreSQL (Supabase project)    │
        │ 28 tables, 4 views, 6 migrations │
        │ Single source of truth           │
        └──────────────────────────────────┘
```

Key architectural facts the mobile developer must know:

- **Two backends, one contract.** The Express API (full feature set) and the
  `mobile-api` Supabase Edge Function (mobile-optimised subset) talk to the **same
  PostgreSQL database** and sign tokens with the **same JWT secret**, so a token
  issued by either backend works against both. Response payload shapes for the shared
  endpoints are identical.
- **Production mobile backend** = the deployed `mobile-api` edge function (publicly
  reachable over HTTPS). The Express API is the development/self-host backend; it can
  also serve the app when hosted publicly.
- **Stateless auth.** No server-side sessions. Any number of devices can be signed in
  simultaneously; deactivating a user or changing their permissions takes effect on
  the very next API call (the full access context is reloaded from the DB per request).
- **Balances are never stored.** Every balance (customer credit, supplier debt,
  operating balance, cash at hand, residual balance) is *calculated* from
  `status = 'posted'` transaction rows at query time. There is no editable balance
  column anywhere in the schema.
- **History is never deleted.** Corrections update a row in place but write the
  old→new values to `adjustment_logs`; reversals flip a row to `status = 'reversed'`
  and record the reason in `transaction_reversals`. The mobile UI must present
  "Correct" and "Reverse" actions rather than delete.
- **Server-stamped audit.** `entry_date` / `entry_time` and the acting user's name/role
  snapshot are **always generated by the server** (timezone `Africa/Lagos`). The client
  never sends them.

### 1.2 Roles

| Level | Key | Name | Description |
|------:|-----|------|-------------|
| 1 | `super_admin` | Super Admin | Full control: users, roles, permissions, all depots, all data. Bypasses every permission gate. |
| 2 | `admin` | Admin | Performs the functions granted by the Super Admin. |
| 3 | `sales_rep` | Sales Representative | Sales entry and customer functions as granted. |
| 4 | `staff` | Staff | Selected pages and inputs as granted. |

Every user has **exactly one active role** (enforced by a partial unique index).
`users.all_depots = true` (or the Super Admin role) grants access to every active depot;
otherwise the user only sees depots in `user_depot_assignments`.

### 1.3 Repository Layout (monorepo, npm workspaces)

```
Depot/
├── server/                  Express API (Node 20+, ESM)
│   ├── src/
│   │   ├── config.js         Environment resolution
│   │   ├── index.js          App factory + boot (migrate → seed → listen)
│   │   ├── db/               pool.js, migrate.js, seed.js, migrations/*.sql
│   │   ├── middleware/       auth.js, errors.js, audit.js
│   │   ├── routes/           14 route modules (mounted under /api)
│   │   ├── services/         financialService, dashboardService, accessService,
│   │   │                     notifyService, permissionCatalog
│   │   └── utils/stamps.js   Validation + server stamps
│   ├── scripts/              dev-db.js (embedded PG), check-schema, reset-data, smoke
│   └── test/acceptance.test.js
├── client/                   React 19 + Vite 8 + Tailwind 4 web app
├── mobile/                   Flutter reference app (Android/iOS/web)
├── supabase/                 Edge functions + config.toml + tsconfig
│   └── functions/
│       ├── mobile-api/       Production mobile REST backend
│       ├── alerts-worker/    Scheduled debt-threshold sweep
│       └── _shared/          auth.ts, db.ts, metrics.ts, stamps.ts, notify.ts,
│                             audit.ts, http.ts (mirrors of the Express services)
└── docs/                     This document
```

### 1.4 Company & Currency

- Company record: **Bisan Ventures**, Head Office (address), currency **NGN**, symbol **₦**.
- All money is formatted `₦1,234,567.50` (2 decimal places, thousands separators).
- Business timezone: **Africa/Lagos** (server stamps and dashboards).

---

## 2. Supabase Project & Environment

### 2.1 Project identifiers

| Item | Value |
|------|-------|
| **Project ref** | `cayshvamuqdlhmkspjwq` |
| **Region** | `aws-1-eu-west-3` (Paris) |
| **Project URL** | `https://cayshvamuqdlhmkspjwq.supabase.co` |
| **Session pooler host** | `aws-1-eu-west-3.pooler.supabase.com:5432` |
| **Pooler connection string shape** | `postgresql://postgres.cayshvamuqdlhmkspjwq:<password>@aws-1-eu-west-3.pooler.supabase.com:5432/postgres` |
| **mobile-api base URL (production)** | `https://cayshvamuqdlhmkspjwq.supabase.co/functions/v1/mobile-api` |
| **alerts-worker URL** | `https://cayshvamuqdlhmkspjwq.supabase.co/functions/v1/alerts-worker` |

> **The React Native app only needs the `mobile-api` base URL above.** It never talks
> to Supabase's auto-generated PostgREST/GoTrue APIs — authentication and data access
> go exclusively through the `mobile-api` edge function with the app's own JWT
> (see §3). `supabase/config.toml` sets `verify_jwt = false` for both functions
> precisely because they authenticate requests themselves.

### 2.2 Backend base URLs per environment

| Environment | Base URL | Notes |
|-------------|----------|-------|
| **Production (mobile)** | `https://cayshvamuqdlhmkspjwq.supabase.co/functions/v1/mobile-api` | Deployed edge function. HTTPS, publicly reachable. |
| Development — Android emulator | `http://10.0.2.2:4000/api` | `10.0.2.2` is the emulator's alias for the host machine running `npm run dev:server`. |
| Development — iOS simulator | `http://localhost:4000/api` | Simulator shares the host network. |
| Development — physical device | `http://<LAN-IP>:4000/api` | Phone and computer on the same Wi-Fi. |
| Local edge function (Docker) | `http://localhost:54321/functions/v1/mobile-api` | `supabase functions serve` — rarely needed. |

The API path shapes are identical on both backends for the shared subset (§6), so a
single base-URL setting switches the app between environments.

### 2.3 Edge function configuration

```toml
# supabase/config.toml
project_id = "depot-manager"

[functions.mobile-api]
verify_jwt = false   # the function validates the app's own JWT (Authorization: Bearer)

[functions.alerts-worker]
verify_jwt = false   # protected by x-cron-secret header instead
```

### 2.4 Secrets (server-side only — never embedded in the app)

The edge functions read these from the Supabase secret store. **None of them belong
in the mobile app.** They are documented here so the operator can wire the backend;
the React Native app needs **no secrets, no Supabase anon key, no service key**.

| Secret | Purpose | Governance rule |
|--------|---------|-----------------|
| `DATABASE_URL` | Postgres connection for the functions (session pooler form) | Reused verbatim from `server/.env`; the password stays percent-encoded exactly as stored (`@` → `%40`, `#` → `%23`). |
| `JWT_SECRET` | HS256 signing key — makes tokens interchangeable with the Express API | Must be byte-identical to `server/.env`'s `JWT_SECRET`. A divergent value silently breaks cross-client auth. |
| `CRON_SECRET` | Shared secret protecting `alerts-worker` | Random opaque string; the same literal must be embedded in the pg_cron `net.http_post` SQL. |
| `APP_TIMEZONE` | Timezone for entry stamps | Fixed to `Africa/Lagos`. |

Set/rotate with:

```bash
supabase link --project-ref cayshvamuqdlhmkspjwq
supabase secrets set DATABASE_URL="postgresql://..." JWT_SECRET="..." CRON_SECRET="..." APP_TIMEZONE="Africa/Lagos"
```

Literal secret values are intentionally **not** printed in this document — read them
from `server/.env` or the Supabase dashboard (Project Settings → Edge Function Secrets).

### 2.5 Express server environment (`server/.env`)

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `4000` | API port |
| `NODE_ENV` | `development` | `production` tightens cookies |
| `DATABASE_URL` | embedded local Postgres (`127.0.0.1:5433/depot`) | Any Postgres; currently the Supabase session pooler |
| `DB_SSL` | auto (on for Supabase hosts) | Force TLS on/off |
| `DB_POOL_MAX` | `10` | Connection pool size |
| `JWT_SECRET` | dev default | HS256 signing key |
| `JWT_EXPIRES_IN` | `12h` | Token lifetime |
| `CLIENT_ORIGIN` | `http://localhost:5173` | Comma-separated allowed web origins (CORS; native apps are unaffected) |
| `BOOTSTRAP_ADMIN_USERNAME` | `superadmin` | First admin username (created only when the users table is empty) |
| `BOOTSTRAP_ADMIN_PASSWORD` | `Admin@2026` | First admin password (seed-time only — the live password may have been changed) |
| `BOOTSTRAP_ADMIN_NAME` | `System Administrator` | First admin full name |

---

## 3. Authentication & Session Management

### 3.1 Token mechanics

- **Algorithm:** HS256 (HMAC-SHA256), shared secret.
- **Payload:** `{ "uid": <user id>, "iat": <issued-at>, "exp": <expiry> }` — 12-hour expiry.
- **Transport (mobile):** `Authorization: Bearer <token>` on every request.
- **Transport (web):** httpOnly cookie `depot_token` — not used by React Native.
- **Interchangeability:** A token issued by the Express `POST /auth/login` is accepted
  by `mobile-api` and vice-versa (same secret). The app stores only the token string;
  it never needs to decode it.

### 3.2 Login flow

```
POST {base}/auth/login
Content-Type: application/json

{ "username": "superadmin", "password": "..." }
```

**200 OK**

```json
{
  "user": { ...full UserContext, see §3.3... },
  "token": "eyJhbGciOiJIUzI1NiIs..."
}
```

- The response includes the complete access context (`user`) — the app does **not**
  need a second `/auth/me` call right after login, but calling it is harmless.
- Errors: `401 {"error":{"message":"Invalid username or password"}}` (edge) /
  `401 {"error":"Invalid username or password"}` (Express); deactivated accounts:
  `401` with message *"This account has been deactivated. Contact the Super Admin."*
- Failed and blocked attempts are written to the audit trail (`LOGIN_FAILED`,
  `LOGIN_BLOCKED`) — the app must not retry aggressively.

### 3.3 The UserContext object (single source of truth for UI gating)

Returned as `user` by `/auth/login` and `/auth/me` on both backends. camelCase.

```json
{
  "id": 1,
  "username": "superadmin",
  "fullName": "System Administrator",
  "email": null,
  "phone": null,
  "roleKey": "super_admin",
  "roleName": "Super Admin",
  "roleLevel": 1,
  "isSuperAdmin": true,
  "allDepots": true,
  "lastLoginAt": "2026-09-25T12:00:11.706Z",
  "permissions": {
    "cash_sales":  { "view": true, "input": true, "edit": true,
                     "view_history": true, "export": true, "approve": true },
    "customers":   { "view": true, "input": false, "edit": false,
                     "view_history": true, "export": false, "approve": false }
  },
  "components": {
    "dashboard_depot": {
      "card_cash_at_hand": { "visible": true, "input": false },
      "new_entry":         { "visible": true, "input": true }
    }
  },
  "depots": [
    { "id": 1, "code": "ABU", "name": "ABU Depot" },
    { "id": 2, "code": "BIS", "name": "Bisan Depot" }
  ]
}
```

Notes:

- `permissions` is a sparse map keyed by **page key** (§12.1). For a Super Admin every
  page key in the catalogue is present with all six actions `true`.
- `components` contains only **explicit overrides** configured for the user's role.
  **A missing key means "visible + input allowed"** (still gated by the page-level
  permission). Super Admin: treat everything as visible/input.
- `depots` lists only depots the user may access (all active depots when
  `isSuperAdmin || allDepots`). This is the source for every depot picker in the app.

### 3.4 Two-layer permission model

1. **Per-user grants** — `user_permissions` rows (edited on the Users page).
2. **Per-role defaults** — `role_permissions` (page activation + actions) and
   `role_page_components` (per-component visibility/input), edited by the Super Admin
   on the Roles & Permissions page.

The two sources are **merged permissively (boolean OR)** when the context is loaded.
The mobile app never computes this itself — it just reads the merged result above.

### 3.5 Client-side gating helpers (implement exactly like this)

```ts
// Page/action gate — mirrors the server exactly.
function can(user, pageKey, action = 'view') {
  if (!user) return false;
  if (user.isSuperAdmin) return true;
  return Boolean(user.permissions?.[pageKey]?.[action]);
}

// Component gate — absent override means visible + input allowed.
function comp(user, pageKey, componentKey) {
  if (!user) return { visible: false, input: false };
  if (user.isSuperAdmin) return { visible: true, input: true };
  const c = user.components?.[pageKey]?.[componentKey];
  if (!c) return { visible: true, input: true };
  return { visible: c.visible, input: c.input && c.visible };
}
```

Actions: `view`, `input`, `edit`, `view_history`, `export`, `approve`.
The server re-checks permissions on every call — client gating only drives what is
displayed.

### 3.6 Session lifecycle for React Native

| Event | Required behaviour |
|-------|--------------------|
| App cold start | Read token from secure storage; if present call `GET /auth/me`. On success boot into the app with the fresh context; on `401` discard the token and show Login. |
| Login | Store token in **secure storage** (iOS Keychain / Android Keystore via `expo-secure-store`). Never in plain AsyncStorage. |
| Every request | Attach `Authorization: Bearer <token>`. |
| `401` response (any endpoint) | Clear stored token, navigate to Login. Message: server-provided ("Your session has expired — please sign in again"). |
| `403` response | Show the server message. It means the permission was revoked server-side; optionally refresh the context via `/auth/me`. |
| Logout | `POST /auth/logout` (best-effort; the edge function has no logout route — just clear the token locally), then wipe state. |
| Background → foreground | Optionally re-run `/auth/me` so revocations/role changes surface quickly. |

### 3.7 Password change

```
POST {base}/auth/change-password        (Express only; requireAuth)
{ "currentPassword": "...", "newPassword": "..." }
→ { "ok": true }
```

- `newPassword` minimum 8 characters (400 otherwise); wrong current password → 400
  "Current password is incorrect". Mobile `Profile` screen should use this endpoint —
  note it exists on the **Express** backend; if the app runs purely against
  `mobile-api`, omit the change-password feature or extend the edge function.

---

## 4. API Conventions

### 4.1 Response envelopes

**Success** — natural JSON shape (no wrapper), e.g. `{ "items": [...], "total": 42 }`.
HTTP 201 for creations.

**Failure** — the two backends differ slightly; the client must handle **both**:

| Backend | Failure body |
|---------|--------------|
| Express | `{ "error": "Human-readable message" }` (string), optionally `"details"` |
| Edge (mobile-api) | `{ "error": { "message": "Human-readable message" } }` (object) |

Robust extraction (use in the RN API client):

```ts
const message =
  (typeof json?.error === 'string' ? json.error
    : json?.error?.message) ||
  `Request failed (${status})`;
```

**Status codes:** 400 validation (message is user-safe — show it verbatim),
401 auth (§3.6), 403 permission/depot access, 404 not found, 409 conflict
(duplicate/constraint/reversed-row), 500 unexpected ("Internal server error" /
"Unexpected server error").

### 4.2 Data type contracts (critical)

| Type | Wire format | Rule |
|------|-------------|------|
| **Money** | **String** with 2 decimals, e.g. `"450000.00"` | `NUMERIC(18,2)` is returned as a string end-to-end. **Never** do float math on parsed values for display-critical sums — sum via the server (it provides totals) or use integer-cent arithmetic. |
| **Dates** | `"YYYY-MM-DD"` plain strings | These are *business dates*, not instants. Do not run them through `new Date()` + timezone conversion when sending back — echo the string. |
| **Times** | `"HH:MM:SS"` (24h, Africa/Lagos) | `entry_time` from server stamps. |
| **Timestamps** | ISO 8601 UTC (`created_at`, `updated_at`, `last_login_at`) | Safe to parse as instants. |
| **Booleans** | JSON true/false | `is_active`, `is_read`, `is_reversed`, `all_depots`, … |
| **IDs** | Integers | Serial PKs; depot/customer/supplier/category ids. |

### 4.3 Pagination

```
GET ...?page=1&pageSize=50
→ { "items": [...], "total": <int count>, "page": 1, "pageSize": 50, ... }
```

- `page` is 1-based; `pageSize` default 50.
- Max `pageSize`: **200** on `mobile-api`, **500** on Express flows/audit.
- Additional totals ride along: `postedTotal` (flows — sum of `posted` amounts),
  `totalBalance` (accounts), `latestValue` (stock).
- Order: flows `transaction_date DESC, id DESC` (edge) or
  `transaction_date DESC, created_at DESC, id DESC` (Express); accounts `name ASC`.

### 4.4 Depot scoping (applies to every list/create/dashboard endpoint)

- Endpoints accept `depotId` (query or body). If provided, the server verifies the
  user's access (403 "You do not have access to this depot" otherwise).
- If omitted: Super Admin / `allDepots` users see **all** their depots; everyone else
  is restricted to `user.depots` automatically. A user with no depots gets empty lists
  (`1 = 0` filter).
- **Mobile UX rule:** if `user.depots.length > 1`, show a depot picker (default:
  remember last choice); if exactly 1, use it silently; Super Admin/allDepots users
  get an "All depots" option (omit `depotId`).

### 4.5 Write operation model — never delete

| Operation | Semantics |
|-----------|-----------|
| **Create** (`POST`) | Needs `input` permission. Server stamps `entry_date`/`entry_time` + user snapshot. Returns the created item as `201 { "item": ... }` (flows/stock) or `201 { "account": ... }` (accounts). |
| **Correction** (`PUT /:id`) | Needs `edit` permission and a required `reason` (≤500 chars). Updates the row, writes field-level old→new to `adjustment_logs`, and an audit entry. Reversed rows cannot be corrected (409). |
| **Reversal** (`POST /:id/reverse`) | Needs `edit` permission and a required `reason`. Flips `status` to `'reversed'`, stores the reversal. **Never deletes.** Already-reversed rows → 409. |

The mobile UI must therefore offer **Correct** and **Reverse** actions (both
permission-gated with `can(page,'edit')` and component-gated with
`comp(page,'edit_action')` / `comp(page,'reverse_action')`), and display reversed rows
with a visual "Reversed" state rather than hiding them.

### 4.6 Universal list filters (Express flow endpoints)

`depotId`, `from`, `to` (transaction date range, `YYYY-MM-DD`),
`entryFrom`/`entryTo` (entry date range), `enteredBy` (user id), `status`
(`posted` | `reversed` | `all`), `search` (ILIKE across reference/notes/enterer and
linked account names), plus per-flow: `customerId`, `supplierId`, `categoryId`,
`paymentMethod`. Empty values are omitted. The `mobile-api` subset supports
`depotId`, `from`, `to` (+ `search`, `withBalance`, `isActive` for customers).

---

<!-- PART-1-END -->

## 5. Database Schema (Complete)

PostgreSQL on Supabase. Schema is managed by the app's own migrations
(`server/src/db/migrations/0001…0006`, applied automatically on Express boot) — **not**
by the Supabase CLI. All 6 migrations are already applied to the live project.
28 tables + 4 views. Money columns are `NUMERIC(18,2)`; financial rows are never
deleted (reversal model).

### 5.1 Core (migration 0001)

**companies** — one row (Bisan Ventures).
`id` PK · `name` · `address` · `phone` · `email` · `currency_code` (default `NGN`) ·
`currency_symbol` (default `₦`) · `created_at` · `updated_at`

**roles** — the four fixed levels.
`id` PK · `key` UNIQUE (`super_admin` | `admin` | `sales_rep` | `staff`) · `name` ·
`level` (1 = highest) · `description`

**users**
`id` PK · `company_id` FK→companies (default 1) · `username` UNIQUE · `full_name` ·
`email` · `phone` · `password_hash` (bcrypt, cost 10) · `is_active` (default true) ·
`all_depots` (default false) · `last_login_at` · `created_at` · `created_by` FK→users ·
`updated_at` · `updated_by` FK→users

**user_roles** — one active role per user.
`id` PK · `user_id` FK (CASCADE) · `role_id` FK→roles · `is_active` · `assigned_at` ·
`assigned_by`. Partial unique index: one `is_active` row per user.

**role_change_logs** — role history.
`id` · `user_id` · `old_role_id` · `new_role_id` · `changed_by` · `reason` · `created_at`

**permissions** — the 18-page catalogue (§12.1).
`id` PK · `page_key` UNIQUE · `page_name` · `section` · `description` · `sort_order`

**user_permissions** — per-user page grants (layer 1).
`id` PK · `user_id` FK (CASCADE) · `page_key` FK→permissions · `can_view` ·
`can_input` · `can_edit` · `can_view_history` · `can_export` · `can_approve` ·
`granted_by` · `granted_at` · `updated_at`. UNIQUE(`user_id`,`page_key`).

**depots**
`id` PK · `company_id` · `code` UNIQUE (e.g. `ABU`, `BIS`) · `name` · `location` ·
`phone` · `is_active` · `created_at` · `created_by` · `updated_at` · `updated_by`

**user_depot_assignments**
`id` PK · `user_id` FK (CASCADE) · `depot_id` FK (CASCADE) · `assigned_by` ·
`assigned_at`. UNIQUE(`user_id`,`depot_id`).

**depot_settings** — opening configuration per depot (1:1).
`depot_id` PK FK→depots (CASCADE) · `opening_balance_date` DATE (default today) ·
`opening_operating_balance` NUMERIC(18,2) · `opening_cash_at_hand` NUMERIC(18,2) ·
`updated_at` · `updated_by`. Transactions dated before `opening_balance_date` are
rejected (§8.2).

### 5.2 Financial (migration 0002)

All seven flow tables share the **core transaction structure**:

```
id PK · company_id (default 1) · depot_id FK · transaction_date DATE ·
amount NUMERIC(18,2) CHECK(> 0) · reference TEXT · notes TEXT ·
status TEXT CHECK ('posted'|'reversed') DEFAULT 'posted' ·
approval_status TEXT DEFAULT 'auto_approved' · approved_by · approved_at ·
reversal_id FK→transaction_reversals · entry_date DATE · entry_time TIME ·
entered_by FK→users · entered_by_name TEXT · entered_by_role TEXT ·
created_at · updated_at
```

| Table | Extra columns | Indexes |
|-------|---------------|---------|
| `cash_sales` | — | (depot_id, transaction_date), status |
| `pos_sales` | — | (depot_id, transaction_date), status |
| `credit_sales` | `customer_id` FK→customers (NOT NULL) | + (customer_id, transaction_date) |
| `customer_payments` | `customer_id` NOT NULL · `payment_method` TEXT default `'Cash'` | + (customer_id, transaction_date) |
| `supplier_purchases` | `supplier_id` NOT NULL · `purchase_type` CHECK (`credit`\|`cash`) default `'credit'` | + (supplier_id, transaction_date) |
| `supplier_payments` | `supplier_id` NOT NULL · `payment_method` default `'Cash'` | + (supplier_id, transaction_date) |
| `depot_expenses` | `category_id` FK→expense_categories · `description` TEXT NOT NULL · `payment_method` default `'Cash'` | (depot_id, transaction_date), category, status |

(`cash_sales`/`pos_sales` allow `amount >= 0` at the DB level but the API enforces > 0.)

**customers** / **suppliers** — same shape.
`id` PK · `company_id` · `depot_id` FK · `code` GENERATED ALWAYS AS
(`'CUS-'`/`'SUP-'` || zero-padded 4-digit id) STORED UNIQUE · `reference` · `name` ·
`phone` · `address` · `notes` · `is_active` · `created_at` · `created_by` ·
`created_by_name` · `updated_at` · `updated_by`.
**Names are globally unique** — unique functional index on `lower(btrim(name))`
(migration 0006); the API mirrors this with a friendly 409.

**stock_value_records** — one active snapshot per depot per day.
Core structure with `stock_value NUMERIC(18,2) CHECK (>= 0)` instead of `amount`, plus
`last_updated_by` · `last_updated_by_name` · `last_updated_at`.
Partial unique index `ON (depot_id, transaction_date) WHERE status = 'posted'`
(second entry for the same day → API 409 "use Correct").

**stock_value_history** — append-only audit of every snapshot change.
`id` · `stock_value_record_id` FK · `action` CHECK (`creation`\|`correction`) ·
`original_value` · `new_value` · `reason` · `changed_by` · `changed_by_name` · `changed_at`

**expense_categories**
`id` PK · `name` UNIQUE · `is_active` · `created_at`

**transaction_reversals** — one row per reversal/correction action.
`id` PK · `transaction_type` CHECK (`cash_sale`,`pos_sale`,`credit_sale`,
`customer_payment`,`supplier_purchase`,`supplier_payment`,`depot_expense`,
`stock_value`) · `transaction_id` · `action` CHECK (`reversal`\|`adjustment`) ·
`amount` · `depot_id` · `reason` NOT NULL · `replacement_transaction_id` ·
`performed_by` · `performed_by_name` · `created_at`

### 5.3 System (migration 0003)

**audit_logs** — every security-relevant event.
`id` BIGSERIAL PK · `user_id` · `user_name` · `user_role` · `action` (§12.4) ·
`entity_type` · `entity_id` TEXT · `description` · `previous_value` JSONB ·
`new_value` JSONB · `ip_address` · `user_agent` · `created_at`

**adjustment_logs** — field-level old→new for corrections/edits.
`id` BIGSERIAL · `entity_type` · `entity_id` TEXT · `field` · `old_value` ·
`new_value` · `reason` · `adjusted_by` · `adjusted_by_name` · `created_at`

**notifications**
`id` BIGSERIAL · `user_id` (NULL = broadcast to all) · `type` (§12.5) ·
`severity` CHECK (`info`\|`warning`\|`critical`) · `title` · `message` · `entity_type` ·
`entity_id` TEXT · `is_read` · `created_at`

**system_settings**
`key` PK · `value` TEXT · `label` · `type` (`string`\|`number`\|`boolean`) ·
`updated_at` · `updated_by`. Seeded keys: `cash_at_bank` (number, `0`),
`customer_debt_alert_threshold` (`1000000`), `supplier_debt_alert_threshold`
(`1000000`), `notifications_enabled` (`true`).

### 5.4 Role access (migration 0005)

**role_permissions** — per-role page grants (layer 2).
`id` PK · `role_id` FK (CASCADE) · `page_key` FK (CASCADE) · six boolean action
columns · `updated_at`. UNIQUE(`role_id`,`page_key`). A fully-deactivated page = no row.

**role_page_components** — per-role component overrides.
`id` PK · `role_id` · `page_key` · `component_key` · `is_visible` (default true) ·
`can_input` (default true) · `updated_at`. UNIQUE(`role_id`,`page_key`,`component_key`).
**Absence of a row means visible + input allowed.**

### 5.5 Views (migration 0004)

**customer_account_ledger** — UNION of posted `credit_sales` (debit, +amount) and
`customer_payments` (credit, −amount) with a window-function `running_balance`
partitioned by customer, ordered by `transaction_date, created_at, source_id`.
Columns: `source_id, customer_id, depot_id, transaction_date, entry_date, entry_time,
entry_type ('credit_sale'|'payment'), direction ('debit'|'credit'), amount,
signed_amount, running_balance, reference, entered_by, entered_by_name, created_at`.

**supplier_account_ledger** — same construction over `supplier_purchases`
(`'purchase'`, debit) and `supplier_payments` (`'payment'`, credit).

**depot_daily_balances** — per depot/day pivot of posted flows with the operating
balance chain:
`depot_id, transaction_date, cash_sales, pos_sales, credit_sales, total_sales,
supplier_purchases, supplier_payments, customer_payments, expenses, operating_balance`
where `operating_balance(day) = opening_operating_balance + Σ(supplier_purchases −
total_sales) up to day`, restricted to dates ≥ the depot's `opening_balance_date`.

**customer_credit_sales** — alias view over `credit_sales`.

### 5.6 Seed data (idempotent, applied on every Express boot)

- Company *Bisan Ventures* (Head Office, NGN, ₦)
- 4 roles, 18 permissions (§12.1)
- 11 expense categories (§12.6)
- 4 system settings (above)
- Depots **ABU** (ABU Depot, Main Branch) and **BIS** (Bisan Depot, Second Branch),
  each with `depot_settings` (opening date 2026-01-01, balances 0)
- Bootstrap Super Admin **only if the users table is empty**
  (`superadmin` / `BOOTSTRAP_ADMIN_PASSWORD`)

---

## 6. Mobile API — Supabase Edge Function `mobile-api`

**Base URL:** `https://cayshvamuqdlhmkspjwq.supabase.co/functions/v1/mobile-api`
All routes below are relative to it. Every route except login/health requires
`Authorization: Bearer <token>`. Errors: `{ "error": { "message } }` (§4.1).
`OPTIONS` preflights are answered with permissive CORS (native apps unaffected).
Source: `supabase/functions/mobile-api/index.ts` (+ `_shared/*`).

### 6.1 Health

```
GET /health            (also GET /)
→ 200 { "ok": true, "service": "mobile-api", "time": "2026-09-25T14:25:10.706Z" }
```

### 6.2 Auth

```
POST /auth/login       { "username": "...", "password": "..." }
→ 200 { "user": UserContext, "token": "<jwt>" }
   400 Username and password are required
   401 Invalid username or password
   401 This account has been deactivated. Contact the Super Admin.

GET  /auth/me
→ 200 { "user": UserContext }
   401 Please sign in | Your session has expired — please sign in again
   403 This user account is deactivated
```

### 6.3 Depots

```
GET /depots
→ 200 { "depots": [ { "id": 1, "code": "ABU", "name": "ABU Depot" }, ... ] }
```
Only depots the user may access; ordered by code. Drives every depot picker.

### 6.4 Depot dashboard

```
GET /dashboard/depot?depotId=1&from=2026-09-01&to=2026-09-25
```
- Permission: `dashboard_depot:view`. `depotId` **required** (403 without it).
- `from`/`to` optional `YYYY-MM-DD`; default `from = to = today` (Africa/Lagos);
  `from > to` → 400.

```json
{
  "depot":   { "id": 1, "code": "ABU", "name": "ABU Depot", "location": "Main Branch" },
  "range":   { "from": "2026-09-01", "to": "2026-09-25" },
  "metrics": {
    "cash_sales": "100000.00", "pos_sales": "0.00", "credit_sales": "450000.00",
    "total_sales": "550000.00", "supplier_purchases": "0.00",
    "supplier_payments": "0.00", "customer_payments": "0.00", "expenses": "0.00",
    "customer_credit": "450000.00", "supplier_debt": "0.00",
    "stock_value": "250000.00", "stock_value_date": "2026-09-24",
    "previous_stock_value": "0.00", "residual_balance": "800000.00",
    "cash_at_hand": "100000.00", "cash_at_bank": "0.00",
    "previous_operating_balance": "0.00", "operating_balance": "0.00",
    "opening_operating_balance": "0.00"
  },
  "daily": [
    { "transaction_date": "2026-09-24", "cash_sales": "100000.00", "pos_sales": "0.00",
      "credit_sales": "450000.00", "total_sales": "550000.00",
      "supplier_purchases": "0.00", "expenses": "0.00", "operating_balance": "0.00" }
  ]
}
```
All metrics are strings (§4.2). Formula reference: §8.1. Card visibility uses
`components` keys from §12.2 (e.g. `card_total_sales`, `card_residual_balance`,
`card_cash_at_hand`, `daily_movement`).

### 6.5 Cash sales

```
GET  /cash-sales?page=1&pageSize=50&depotId=1&from=2026-09-01&to=2026-09-25
→ 200 { "items": [SaleItem...], "total": 12, "postedTotal": "550000.00",
        "page": 1, "pageSize": 50 }
```
- Permission: `cash_sales:view`. `pageSize` max 200.

```
POST /cash-sales
{ "depotId": 1, "transactionDate": "2026-09-25", "amount": 25000,
  "reference": "R-1001", "notes": "optional" }
→ 201 { "item": SaleItem }
```
- Permission: `cash_sales:input`.
- `amount`: number > 0, normalized server-side to 2dp. `reference` ≤120, `notes` ≤2000.
- 400 if the depot has no settings or the date precedes `opening_balance_date`.

**SaleItem (cash):**
```json
{ "id": 3, "depot_id": 1, "depot_code": "ABU", "depot_name": "ABU Depot",
  "transaction_date": "2026-09-25", "amount": "25000.00", "reference": "R-1001",
  "notes": null, "status": "posted", "entry_date": "2026-09-25",
  "entry_time": "14:05:22", "entered_by_name": "System Administrator" }
```

### 6.6 Credit sales

Same list contract as §6.5 (permission `credit_sales:view`). Items additionally carry
`customer_id`, `customer_name`, `customer_code`.

```
POST /credit-sales
{ "depotId": 1, "transactionDate": "2026-09-25", "amount": 45000,
  "customerId": 7, "reference": "INV-022", "notes": "optional" }
→ 201 { "item": SaleItem }
```
- Permission: `credit_sales:input`. `customerId` **required** (400 with the message
  "customerId is required — every credit sale must be linked to a customer").
- Customer must exist, belong to the same depot, and be active (400 with the
  customer's name in the message).
- After a successful create the server runs the debt-threshold check (§8.3), which may
  create a notification (visible under §6.8).

### 6.7 Customers

```
GET /customers?page=1&pageSize=50&depotId=1&search=alu&withBalance=true&isActive=true&from=&to=
→ 200 { "items": [CustomerRow...], "total": 25, "totalBalance": "1250000.00",
        "page": 1, "pageSize": 50 }
```
- Permission: `customers:view`. `search` ILIKE-matches name/code/phone.
  `withBalance=true` keeps only non-zero balances. `isActive=true|false`.
- `to` (optional) = as-of date for balance computation (default today).

**CustomerRow:**
```json
{ "id": 7, "code": "CUS-0007", "name": "Aluminium Works Ltd", "phone": "0803...",
  "is_active": true, "depot_id": 1, "depot_code": "ABU", "balance": "45000.00" }
```

```
GET /customers/:id/ledger?to=2026-09-25
→ 200 { "account": CustomerRow+, "ledger": [LedgerEntry...], "asOf": "2026-09-25" }
```
- Permission: `customers:view_history` (note the underscore in the action).
- `account` includes the as-of `balance`. `ledger` rows come from the
  `customer_account_ledger` view (§5.5) — chronological with `running_balance`.

**LedgerEntry:**
```json
{ "source_id": 12, "entry_type": "credit_sale", "direction": "debit",
  "amount": "45000.00", "signed_amount": "45000.00", "running_balance": "45000.00",
  "transaction_date": "2026-09-25", "entry_date": "2026-09-25",
  "entry_time": "14:05:22", "reference": "INV-022",
  "entered_by": 1, "entered_by_name": "System Administrator" }
```
(`entry_type`: `credit_sale` | `payment`; `direction`: `debit` | `credit`.)

### 6.8 Notifications

```
GET /notifications
→ 200 { "notifications": [Notification...], "unread": 3 }
```
- Permission: `notifications:view`. Latest 200 rows where `user_id = me` OR broadcast
  (`user_id IS NULL`), newest first.

**Notification:**
```json
{ "id": 41, "type": "customer_debt", "severity": "warning",
  "title": "Customer debt above threshold: Aluminium Works Ltd",
  "message": "CUS-0007 — Aluminium Works Ltd now owes ₦450000.00 (threshold ₦1000000.00).",
  "entity_type": "customer", "entity_id": "7", "is_read": false,
  "created_at": "2026-09-25T13:12:04.101Z" }
```
- Mark-read endpoints exist only on the Express API (`POST /notifications/:id/read`,
  `POST /notifications/read-all`, `GET /notifications/unread-count` — §7.6). To clear
  the mobile badge against the edge function, either extend `mobile-api` or run the
  app against Express.

### 6.9 Not implemented on mobile-api (Express only)

POS sales, customer payments, supplier flows, expenses, stock values, dashboards'
drill-downs/global view, reports, audit trail, user/role/depot/settings administration,
change-password, notification mark-read. See §7 for the full contracts (tokens are
interchangeable, so the app can call the Express API directly when it is hosted) and
§10.10 for the recommended extension path if these are needed in production.

---

## 7. Express API — Complete Endpoint Reference

**Base URL (dev):** `http://localhost:4000/api` · Path prefix `/api`.
Auth: httpOnly cookie `depot_token` **or** `Authorization: Bearer <token>` (mobile).
Errors: `{ "error": "<message>" }` (§4.1). Every router below requires authentication
unless noted. `P@` = required page permission.

### 7.1 Health & meta

| Method | Path | Permission | Response |
|--------|------|-----------|----------|
| GET | `/api/health` | none | `{ ok, env, time }` |
| GET | `/api/meta/expense-categories` | authenticated | `{ categories: [{id,name,is_active}] }` (active only, by name) |
| GET | `/api/meta/payment-methods` | authenticated | `{ methods: ["Cash","POS","Bank Transfer","Cheque","Bank Deposit"] }` |

### 7.2 Auth — `/api/auth`

| Method | Path | Body | Response |
|--------|------|------|----------|
| POST | `/login` | `{username, password}` | `{ user, token }` + sets cookie; 401 on bad creds; audit `LOGIN`/`LOGIN_FAILED`/`LOGIN_BLOCKED` |
| POST | `/logout` | — | `{ ok: true }`; best-effort audit `LOGOUT` |
| GET | `/me` | — | `{ user }` (full context reload) |
| POST | `/change-password` | `{currentPassword, newPassword}` | `{ ok: true }`; 400 if new < 8 chars or current wrong; audit `PASSWORD_CHANGE` |

### 7.3 Users — `/api/users` (P@ `users`; permission grants PUT needs `roles_permissions`)

| Method | Path | P@ | Body / notes | Response |
|--------|------|----|--------------|----------|
| GET | `/` | view | ordered by role level, name; includes `role_key, role_name, role_level, depot_count, last_login_at` | `{ users: [...] }` |
| GET | `/:id` | view | + `permissions` (user grants), `depots` (assignments), `roleHistory` | `{ user, permissions, depots, roleHistory }` |
| POST | `/` | input | `{username, fullName, email?, phone?, password(≥8), roleKey, allDepots, depotIds[]}` — username unique (409); only Super Admin may assign `super_admin`; need ≥1 depot or allDepots | `201 { user }` |
| PUT | `/:id` | edit | `{fullName?, email?, phone?, isActive?, allDepots?}` — cannot deactivate self; cannot deactivate/remove the last active Super Admin | `{ user }` |
| PUT | `/:id/role` | edit | `{roleKey, reason?}` — writes `role_change_logs` + audit `ROLE_CHANGE`; own-super-admin removal blocked | `{ user }` |
| PUT | `/:id/permissions` | `roles_permissions:edit` | `{grants: [{pageKey, view, input, edit, viewHistory, export, approve}]}` — **replaces** the user's grants; unknown pageKey → 400; audit `PERMISSION_CHANGE` | `{ ok: true }` |
| PUT | `/:id/depots` | users:edit | `{allDepots, depotIds[]}` — **replaces** assignments; audit `DEPOT_ASSIGNMENT` | `{ ok: true }` |
| POST | `/:id/reset-password` | users:edit | `{newPassword(≥8)}` — bcrypt re-hash; audit `PASSWORD_RESET` | `{ ok: true }` |

Guard: only a Super Admin may modify a Super Admin account (403 otherwise).

### 7.4 Roles & permissions — `/api/roles`

| Method | Path | P@ | Response |
|--------|------|----|----------|
| GET | `/` | authenticated | `{ roles: [{id,key,name,level,description,user_count}] }` (by level) — for dropdowns |
| GET | `/permissions` | `roles_permissions:view` | `{ permissions: [18 pages] }` |
| GET | `/access` | `roles_permissions:view` | `{ roles, pages, rolePermissions, components, componentCatalog }` — everything the role-access editor needs |
| PUT | `/:roleId/access` | `roles_permissions:edit` | Body `{pages: [{pageKey,view,input,edit,viewHistory,export,approve}], components: [{pageKey,componentKey,visible,input}]}` — transactional replace; audit `ROLE_ACCESS_UPDATE` → `{ ok: true }` |

### 7.5 Depots — `/api/depots`

| Method | Path | P@ | Body / notes | Response |
|--------|------|----|--------------|----------|
| GET | `/` | authenticated | accessible depots only (same as `user.depots`) | `{ depots }` |
| GET | `/all` | users:view | every depot + opening settings | `{ depots }` |
| POST | `/` | settings:input | `{code(≤20, uppercased, unique), name, location?, phone?, openingBalanceDate, openingOperatingBalance?, openingCashAtHand?}` — creates depot + settings atomically | `201 { id }` |
| PUT | `/:id` | settings:edit | `{name?, location?, phone?, isActive?, openingBalanceDate?, openingOperatingBalance?, openingCashAtHand?}` — audit + adjustment logs | `{ ok: true }` |

### 7.6 Notifications — `/api/notifications` (P@ `notifications`)

| Method | Path | P@ | Response |
|--------|------|----|----------|
| GET | `/` | view | `{ notifications, unread }` — latest 200, user + broadcasts |
| GET | `/unread-count` | authenticated | `{ unread }` — for badges (polled every 60s by the web app) |
| POST | `/:id/read` | view | `{ ok: true }` |
| POST | `/read-all` | view | `{ ok: true }` |

### 7.7 Audit trail — `/api/audit-logs` (P@ `audit_trail:view`; page default 100, max 500)

| Method | Path | Filters | Response |
|--------|------|---------|----------|
| GET | `/` | `userId, action, entityType, entityId, from, to, search, page, pageSize` | `{ items, total, page, pageSize, filters: {actions, entityTypes} }` — `previous_value`/`new_value` are JSONB |
| GET | `/adjustments` | `entityType, entityId, from, to` | `{ items, total, page, pageSize }` — field-level old→new |
| GET | `/reversals` | `transactionType, from, to` (depot-scoped for non-admins) | `{ items, total, page, pageSize }` |

### 7.8 Reports — `/api/reports` (P@ `reports:view`; CSV export additionally needs `reports:export`)

```
GET /api/reports                       → { reports: [{kind,label,group}...] }  (13 reports)
GET /api/reports/:kind?from&to&depotId&format=json|csv
```

JSON response: `{ kind, columns: [{key, label, money?}], rows: [...], range|asOf }`.
CSV response: `text/csv` attachment (formula-injection-safe), audits `REPORT_EXPORT`.

| kind | Group | Notes |
|------|-------|-------|
| `sales-by-depot` | Sales | per-depot cash/POS/credit/total |
| `sales-daily` | Sales | per-day totals across scope |
| `customer-balances` | Customers | outstanding per customer as of `to` |
| `credit-sales-list` | Customers | row-level credit sales |
| `customer-payments-list` | Customers | row-level payments |
| `supplier-debts` | Suppliers | outstanding per supplier |
| `supplier-purchases-list` | Suppliers | row-level purchases |
| `supplier-payments-list` | Suppliers | row-level payments |
| `stock-values` | Stock | snapshots with entry + last-update info |
| `expenses-by-category` | Expenses | grouped totals |
| `expenses-daily` | Expenses | per depot/day |
| `operating-daily` | Operating | per depot/day operating balance |
| `operating-global` | Operating | company-wide daily |

Both view and export are audited (`REPORT_VIEW` / `REPORT_EXPORT`).

### 7.9 Dashboards — `/api/dashboard`

| Method | Path | P@ | Notes | Response |
|--------|------|----|-------|----------|
| GET | `/depot?depotId&from&to` | dashboard_depot:view | same envelope as edge §6.4 | `{ depot, range, metrics(+cash_at_bank), daily }` |
| GET | `/depot/sales-breakdown?depotId&from&to` | dashboard_depot:view | up to 100 entries per channel | `{ range, cash_sales:{total,entries}, pos_sales:{...}, credit_sales:{...} }` |
| GET | `/depot/customers?depotId&to` | dashboard_depot:view | non-zero balances | `{ asOf, customers }` |
| GET | `/depot/suppliers?depotId&to` | dashboard_depot:view | non-zero debts | `{ asOf, suppliers }` |
| GET | `/global?from&to` | dashboard_global:view | consolidates every accessible depot | `{ range, totals, depots: [{id,code,name, per-depot metrics}] }` |
| GET | `/global/customers?to` | dashboard_global:view | | `{ asOf, customers }` |
| GET | `/global/suppliers?to` | dashboard_global:view | | `{ asOf, suppliers }` |

**Global totals object** (all money strings):
`cash_sales, pos_sales, credit_sales, total_sales, supplier_purchases, expenses,
cash_at_hand, cash_at_bank, total_cash (Σ cash at hand), total_residual_balance,
customer_credit, supplier_debt`.

### 7.10 Customers / Suppliers — `/api/customers`, `/api/suppliers`

Identical contract for both (factory router). P@ `customers` / `suppliers`.

| Method | Path | P@ | Body / notes | Response |
|--------|------|----|--------------|----------|
| GET | `/?depotId&search&isActive&withBalance&to&page&pageSize` | view | balance as-of `to` (default today) | `{ items, total, totalBalance, asOf, page, pageSize }` — items include `address, notes, reference, created_at, created_by_name, last_activity_date, depot_name` |
| GET | `/:id?to` | view | account + debit/credit totals | `{ account, totals: {debit_total, credit_total}, asOf }` |
| GET | `/:id/ledger?to` | view_history | view §5.5 | `{ account, ledger, asOf }` |
| POST | `/` | input | `{depotId, name(≤160), phone?≤40, address?≤300, reference?≤80, notes?≤2000}` — **name globally unique** (case/whitespace-insensitive → 409 with existing code) | `201 { account }` |
| PUT | `/:id` | edit | any of `{name, phone, address, reference, notes, isActive, reason?}` — balance is never editable | `{ account }` |
| DELETE | `/:id` | edit | allowed **only with zero transactions**; otherwise 409 "Mark the record inactive instead" | `{ ok: true }` |

### 7.11 Financial flows — seven identical routers

Paths: `/api/cash-sales`, `/api/pos-sales`, `/api/credit-sales`,
`/api/customer-payments`, `/api/supplier-purchases`, `/api/supplier-payments`,
`/api/depot-expenses`. P@ = the matching page key.

| Method | Path | P@ | Notes | Response |
|--------|------|----|-------|----------|
| GET | `/?filters§4.6&page&pageSize` | view | posted total included | `{ items, total, postedTotal, page, pageSize }` |
| GET | `/:id` | view | | `{ item }` |
| POST | `/` | input | see create-body table below | `201 { item }` |
| PUT | `/:id` | edit | correction; `reason` required; editable fields per flow | `{ item }` |
| POST | `/:id/reverse` | edit | `reason` required | `{ item }` |

**Create body (camelCase):** `{depotId, transactionDate, amount, reference?, notes?}` plus:

| Flow | Required extras | Optional extras |
|------|------------------|-----------------|
| cash_sales / pos_sales | — | — |
| credit_sales | `customerId` | — |
| customer_payments | `customerId` | `paymentMethod` (default `Cash`) |
| supplier_purchases | `supplierId` | `purchaseType` (default `credit`) |
| supplier_payments | `supplierId` | `paymentMethod` (default `Cash`) |
| depot_expenses | `description` (≤300) | `categoryId`, `paymentMethod` |

**Full item shape (Express)** — everything in §6 plus reversal metadata:
`id, depot_id, depot_code, depot_name, transaction_date, amount, reference, notes,
status, entry_date, entry_time, entered_by, entered_by_name, entered_by_role,
created_at, updated_at, reversal_id, reversal_reason, reversed_by_name, reversed_at,
[customer_id, customer_name, customer_code], [supplier_id, supplier_name,
supplier_code], [category_id, category_name, description], [payment_method],
[purchase_type], is_reversed (bool)`.

**Correction (PUT) editable fields:** `amount, transactionDate, reference, notes,
paymentMethod, purchaseType, description, categoryId` (per flow) + `reason` (required).

Server-side create/update validations (all produce user-safe 400/409 messages):
depot access; depot configured; date ≥ opening date; amount > 0 (2dp); customer /
supplier exists, active, and belongs to the same depot; category exists + active;
`paymentMethod` ∈ §7.1 list; `purchaseType` ∈ {credit, cash}; reversed rows immutable.

### 7.12 Stock value — `/api/stock-value` (P@ `stock_balance`)

| Method | Path | P@ | Body / notes | Response |
|--------|------|----|--------------|----------|
| GET | `/?depotId&from&to&enteredBy&status&search&page&pageSize` | view | | `{ items, total, latestValue, page, pageSize }` — items include `correction_count`, `last_updated_by_name`, `last_updated_at` |
| GET | `/:id/history` | view_history | full creation+correction chain | `{ record, history }` |
| POST | `/` | input | `{depotId, transactionDate, stockValue(≥0), reference?, notes?}` — **one posted record per depot per day**; duplicate → 409 "use Correct" | `201 { item }` |
| PUT | `/:id` | edit | `{stockValue(≥0), reason}` — updates + appends history | `{ item }` |
| POST | `/:id/reverse` | edit | `{reason}` | `{ item }` |

---

<!-- PART-2-END -->

## 8. Business Rules & Financial Formulas

### 8.1 Metric definitions (SRS §15–§36 — implemented identically on both backends)

| Metric | Formula |
|--------|---------|
| **Total Sales** | Cash Sales + POS Sales + Credit Sales (period) |
| **Customer Credit** | Σ posted credit sales **to date** − Σ posted customer payments **to date** |
| **Supplier Debt** | Σ posted supplier purchases **to date** − Σ posted supplier payments **to date** |
| **Operating Balance (day)** | opening_operating_balance + Σ (supplier purchases − total sales) up to that day (from `depot_daily_balances`) |
| **Cash at Hand** | Σ posted cash sales **to date** − Σ posted depot expenses **to date** |
| **Residual Balance** | Total Sales (period) + Present Stock Value − Previous Stock Value − Supplier Purchases (period). Present = latest posted snapshot ≤ `to`; Previous = latest posted snapshot < `from` |
| **Total Cash (global)** | Σ Cash at Hand across depots |
| **Cash at Bank** | `system_settings.cash_at_bank` (company-level, manually maintained) |

"**To date**" = cumulative through the end of the selected range; period metrics use
`from`–`to` inclusive. Only `status = 'posted'` rows count — reversed rows are excluded
everywhere. Money is computed server-side and returned as 2dp strings; the app should
**display, never recompute**, these figures.

### 8.2 Validation & integrity rules

1. **Opening-date floor** — a transaction dated before its depot's
   `opening_balance_date` is rejected (400, message includes the date).
2. **Per-depot customer/supplier** — accounts belong to exactly one depot; cross-depot
   references are rejected with the account's name in the message.
3. **Globally unique account names** — case- and whitespace-insensitive across *all*
   depots; 409 includes the existing account's code.
4. **No deletion with history** — accounts with any transactions can only be
   deactivated; the server suggests this in the 409 message.
5. **Reversal-not-delete** — reversed rows are immutable (409 on edit/re-reverse).
6. **One stock snapshot per depot-day** — second entry for the same day → 409 "use
   Correct"; every change appends to `stock_value_history`.
7. **Reason required** — every correction and reversal carries a reason (≤500 chars),
   captured in the audit trail.
8. **Server stamps** — `entry_date`/`entry_time` (Africa/Lagos) and the
   `entered_by_name`/`entered_by_role` snapshot are always server-generated.
9. **Last-Super-Admin protection** — the system refuses to deactivate or demote the
   last active Super Admin; users cannot deactivate themselves or drop their own
   Super Admin role.
10. **Amounts** — strictly positive for flows; `stock_value` may be zero; everything is
    normalized to 2 decimal places.

### 8.3 Debt-threshold notifications (SRS §25)

- Settings: `customer_debt_alert_threshold`, `supplier_debt_alert_threshold`
  (default ₦1,000,000 each), `notifications_enabled` (default true).
- **Per-transaction check:** after every credit sale / customer payment / supplier
  purchase / payment, the server evaluates the account's outstanding balance; crossing
  the threshold creates a `warning` notification (one unread alert per account —
  deduplicated); dropping back below resolves (auto-marks read) existing alerts.
- **Scheduled sweep:** `alerts-worker` re-evaluates every active account, so alerts stay
  correct even if nobody enters data. Scheduled via pg_cron + pg_net every 15 minutes
  with the `x-cron-secret` header. Idempotent; safe to invoke manually:

```bash
curl -X POST https://cayshvamuqdlhmkspjwq.supabase.co/functions/v1/alerts-worker \
  -H "x-cron-secret: <CRON_SECRET>"
→ { ok, ran_at, thresholds, customersChecked, customersAlerting,
    suppliersChecked, suppliersAlerting, notificationsCreated }
```

### 8.4 Dual-backend parity rule (for maintainers)

Every formula and the permission merge are implemented twice:
`server/src/services/dashboardService.js` ↔ `supabase/functions/_shared/metrics.ts`,
and `server/src/services/accessService.js` ↔ `supabase/functions/_shared/auth.ts`.
**Any change must be applied to both and the edge function redeployed**
(`supabase functions deploy mobile-api`). `alerts-worker` does not import `metrics.ts`.

---

## 9. Branding & Design System

### 9.1 Brand identity

| Element | Requirement |
|---------|-------------|
| **Display name** | **Bisan Ventures** — used as the app title, login heading, and app-bar brand. Never "Depot Manager" in user-facing UI. |
| **Logo** | A rounded-square badge (corner radius ≈ 22% of size), background **indigo-600 `#4F46E5`**, containing a single bold white letter **"B"**. Sizes: 56×56 on the login screen, 36×36 in headers/navigation. No other artwork exists — reuse this badge for the app icon at 1024×1024. |
| **Tagline / subtitle** | "Multi-Depot Financial & Operations System" (login screen); "Multi-Depot Financials" (compact surfaces). |
| **Company footer references** | Bisan Ventures · depots ABU & Bisan. |

### 9.2 Colour palette (Tailwind v4 tokens — use these exact hex values in RN)

**Brand / primary**

| Token | Hex | Usage |
|-------|-----|-------|
| `indigo-600` | `#4F46E5` | Primary buttons, active nav item, logo badge, links, focused input border |
| `indigo-700` | `#4338CA` | Primary button pressed/hover state |
| `indigo-400` | `#818CF8` | Input focus border |
| `indigo-100` | `#E0E7FF` | Avatar chip background |
| `indigo-50` | `#EEF2FF` | Selected-row tint, info chip background |
| `indigo-300` | `#A5B4FC` | Hover border on clickable cards |

**Neutrals (slate)**

| Token | Hex | Usage |
|-------|-----|-------|
| `slate-900` | `#0F172A` | Login background, dark sidebar/header, headings |
| `slate-800` | `#1E293B` | Primary body text |
| `slate-700` | `#334155` | Emphasised labels |
| `slate-600` | `#475569` | Field labels |
| `slate-500` | `#64748B` | Secondary text, placeholder, table headers |
| `slate-400` | `#94A3B8` | Hints, timestamps, sidebar text |
| `slate-300` | `#CBD5E1` | Input borders, dividers, disabled text |
| `slate-200` | `#E2E8F0` | Card/table borders |
| `slate-100` | `#F1F5F9` | App background, hover row, inactive chip |
| `slate-50` | `#F8FAFC` | Disabled input fill, subtle surfaces |
| white | `#FFFFFF` | Cards, sheets, inputs, active nav text |

**Semantic**

| Token | Hex | Usage |
|-------|-----|-------|
| `emerald-600` | `#059669` | Positive money, "posted"/"active" badges |
| `emerald-50` / `emerald-200` / `emerald-700` | `#ECFDF5` / `#A7F3D0` / `#047857` | Success badge bg / ring / text |
| `rose-600` | `#E11E48` | Danger buttons, negative money, "reversed" badge |
| `rose-500` | `#F43F5E` | Unread-count badge dot |
| `rose-50` / `rose-200` / `rose-700` | `#FFF1F2` / `#FECDD3` / `#BE123C` | Danger badge bg / ring / text |
| `amber-50` / `amber-200` / `amber-700` | `#FFFBEB` / `#FDE68A` / `#B45309` | Warning chips (debt alerts) |
| `sky-50` / `sky-200` / `sky-800` | `#F0F9FF` / `#BAE6FD` / `#075985` | Info alerts |

Dark mode is **not** used — light theme with dark login/sidebar only.

### 9.3 Typography

| Rule | Value |
|------|-------|
| Font family | System UI stack: iOS **SF Pro** (San Francisco), Android **Roboto**. Web reference stack: `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`. No custom font files — match the platform default. |
| Money values | **Tabular figures** everywhere (`fontVariant: ['tabular-nums']` in RN; `font-variant-numeric: tabular-nums` on web), right-aligned, never wrapped. |
| Scale | 10px uppercase section labels (letterspacing +0.05em, `slate-500`) · 11px badges/hints/captions · 12px secondary · 13px nav items · **14px base UI text** · 16px inputs on phones (prevents iOS zoom) · 20px bold page titles (`slate-900`) · 24px bold stat values · 24px logo letter |
| Weights | Regular 400 body · **600 semibold** labels, buttons, section headers, card titles · **700/800 bold** headings, stat values, brand name |
| Case | Sentence case for content; UPPERCASE only for section labels and stat-card labels; statuses Capitalized ("Posted", "Reversed") |

### 9.4 Core UI components to reproduce in React Native

| Web component | RN equivalent & spec |
|---------------|----------------------|
| **StatCard** | Rounded-12 card, white bg, `slate-200` border, shadow-sm. Uppercase 12px `slate-500` label; 24px bold value (emerald if positive-tone, rose if `tone=rose`, else `slate-900`); optional hint chip; optional "View details →" in `indigo-600` when tappable (drill-down). Component-gated via `comp()`. |
| **Button** | Variants: primary (`indigo-600` bg, white text, pressed `#4338CA`), secondary (white bg, `slate-300` border, `slate-700` text), danger (`rose-600` bg), ghost (text only). Radius 8. Sizes: sm (10×6 padding, 12px), md (14×8, 14px). Weight 600. Disabled at 40% / `indigo-300`. |
| **Input / MoneyInput** | White bg, `slate-300` 1px border, radius 8, 16px text on phones, focus border `indigo-400` + subtle `indigo-100` ring. MoneyInput: numeric keyboard, 2dp, right-aligned tabular. Labels: 12px semibold `slate-600`; required marker in `rose-500`; error text 11px `rose-600`; hint 11px `slate-400`. |
| **Table / list rows** | 11px uppercase `slate-500` headers; 14px rows; row borders `slate-100`; money columns right-aligned; row tap → detail; reversed rows show a "Reversed" rose badge; empty state "No records found" centered `slate-400`. On phones prefer card-rows over dense grids. |
| **Badge** | Pill (radius-full), 11px semibold, capitalized; posted/active = emerald set; reversed = rose set; inactive = `slate-100`/`slate-500`; warning = amber set. |
| **Modal / bottom sheet** | Web uses a centered modal; the mobile pattern from the Flutter app is a **bottom sheet** for entry/correct/reverse forms. Backdrop `slate-900` at 50%; sheet radius 16 top corners; handle drag-to-dismiss; primary action right-aligned. |
| **Alert / toast** | Info (sky), success (emerald), warning (amber), error (rose) — tinted bg + matching border + dark text; server error strings render verbatim. |
| **Spinner** | `indigo-500` arc + "Loading…" in `slate-400`. |
| **Pagination** | "1–50 of 132" + ‹ Prev / Next › buttons (sm). |
| **Login screen** | Full-bleed `slate-900` background; centered 56px "B" badge (§9.1); "Bisan Ventures" 20px bold white; subtitle 14px `slate-400`; white rounded-16 card with username + password fields and a full-width primary button "Sign in"; error alert at top of card; footnote: "Every entry you make is stamped with your user, date and time — the server records it automatically." |
| **Notification badge** | Bell icon with `rose-500` count chip (top-right, white 10px bold text, "99+" cap). |

### 9.5 Formatting rules (must match the web/Flutter apps exactly)

| Value | Format | Example |
|-------|--------|---------|
| Money | `₦` + `#,##0.00` (en-NG grouping) | `₦1,234,567.50` |
| Money compact (tiles) | `Intl.NumberFormat compact`, 2dp, ≥1000 only | `₦1.23M` |
| Date | `DD/MM/YYYY` | `25/09/2026` |
| Timestamp | `DD/MM/YYYY HH:mm` | `25/09/2026 14:05` |
| Entry stamp label | `d MMM • HH:MM:SS` | `25 Sep • 14:05:22` |
| Enum label | snake_case → Title Case | `customer_debt` → "Customer Debt" |
| Negative money | `rose-600` text; positive → `emerald-600` | — |

---

## 10. React Native Application Specification

### 10.1 Recommended stack

| Concern | Choice | Rationale |
|---------|--------|-----------|
| Framework | **Expo (managed), SDK 54+ / React Native 0.81+**, TypeScript | OTA updates, EAS Build for store binaries, no Xcode/Android Studio requirement for development |
| Navigation | **Expo Router** (or React Navigation v7: bottom-tabs + native-stack) | Mirrors the Flutter shell: tab-per-capability, stack for ledger/detail |
| Data fetching | **TanStack Query v5** (or hand-rolled hooks) | Caching, pull-to-refresh, pagination, retry; keep the thin `api` client transport-agnostic |
| Token storage | **`expo-secure-store`** (`SecureStore.ITEMS.AFTER_FIRST_UNLOCK`) | Keychain/Keystore-backed; production requirement |
| Forms | `react-hook-form` + native inputs (or controlled components) | Validation mirrors §8.2 client-side for fast feedback, server is the source of truth |
| Icons | `@expo/vector-icons` (MaterialIcons — matches the Flutter app) | Visual continuity |
| Misc | `intl`-style formatting via `Intl` polyfill or `react-native-fast-currency`-free manual formatter | §9.5 rules are simple enough to hand-roll |

No state library is required — the UserContext + query cache suffice. Keep dependencies
minimal; this is a forms-and-lists business app where reliability > novelty.

### 10.2 Project structure

```
app/                        # Expo Router routes (or src/screens with React Navigation)
  _layout.tsx               # Root: auth gate (token? → App : Login)
  login.tsx
  (tabs)/
    _layout.tsx             # Permission-filtered tab bar (§10.4)
    dashboard.tsx
    cash-sales.tsx
    credit-sales.tsx
    customers.tsx
    alerts.tsx
  customers/[id]/ledger.tsx # Stack: account ledger
  profile.tsx               # Change password, depots, role, sign out
src/
  api/
    client.ts               # §10.3 — single fetch wrapper
    endpoints.ts            # Typed wrappers per §6/§7 route
    types.ts                # UserContext, SaleItem, CustomerRow, LedgerEntry, …
  auth/
    session.tsx             # Context: token + user, login/logout/refresh (§3.6)
    guards.ts               # can() / comp() (§3.5)
  format.ts                 # money/date/label (§9.5)
  theme.ts                  # §9.2 palette + spacing + radius tokens
components/                 # StatCard, Button, Badge, MoneyInput, SheetForm,
                            # RowCard, EmptyState, ErrorBanner, Pagination
config.ts                   # API_BASE_URL per build profile
```

### 10.3 API client (drop-in reference implementation)

```ts
// src/api/client.ts
import * as SecureStore from 'expo-secure-store';

export const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL ??
  'https://cayshvamuqdlhmkspjwq.supabase.co/functions/v1/mobile-api';

const TOKEN_KEY = 'depot_token';
export const getToken  = () => SecureStore.getItemAsync(TOKEN_KEY);
export const setToken  = (t: string | null) =>
  t ? SecureStore.setItemAsync(TOKEN_KEY, t) : SecureStore.deleteItemAsync(TOKEN_KEY);

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly details?: unknown) {
    super(message);
  }
}

let onUnauthorized: (() => void) | null = null;
export const setUnauthorizedHandler = (fn: () => void) => { onUnauthorized = fn; };

export async function request<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  opts: { body?: unknown; query?: Record<string, string | number | boolean | undefined> } = {},
): Promise<T> {
  const url = new URL(API_BASE_URL + path);
  for (const [k, v] of Object.entries(opts.query ?? {}))
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));

  const token = await getToken();
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  let json: any = null;
  try { json = await res.json(); } catch { /* non-JSON */ }

  if (!res.ok) {
    const message =
      (typeof json?.error === 'string' ? json.error : json?.error?.message) ||
      `Request failed (${res.status})`;
    if (res.status === 401) { await setToken(null); onUnauthorized?.(); }
    throw new ApiError(res.status, message, json?.error?.details);
  }
  return json as T;
}

export const api = {
  get:  <T>(p: string, q?: Record<string, any>) => request<T>('GET', p, { query: q }),
  post: <T>(p: string, b?: unknown) => request<T>('POST', p, { body: b ?? {} }),
  put:  <T>(p: string, b?: unknown) => request<T>('PUT', p, { body: b }),
  del:  <T>(p: string) => request<T>('DELETE', p),
};
```

Notes: timeout the fetch (AbortController, 30s) with a friendly "Check your
connection" error; `GET` uses query params only; all writes are JSON bodies with
**camelCase** keys; the 401 handler routes to Login (§3.6).

### 10.4 Navigation & permission-filtered tabs

Root layout: restore session (§3.6) → render Login or the tab shell.
Tab bar (bottom on phones, rail at ≥840dp on tablets — parity with the Flutter shell):

| Tab | Icon (MaterialIcons) | Visible when | Route content |
|-----|----------------------|--------------|---------------|
| Dashboard | `speed` | `can('dashboard_depot')` | §10.5 |
| Cash | `payments` | `can('cash_sales')` | §10.6 (cash mode) |
| Credit | `assignment-ind` | `can('credit_sales')` | §10.6 (credit mode) |
| Customers | `people` | `can('customers')` | §10.7 |
| Alerts | `notifications` with unread badge | `can('notifications')` | §10.8 |

Rules: tabs render **only** permitted pages; if none are permitted show an empty state
"Your role has no page permissions yet. Ask the Super Admin to grant access on the
Users page." A `Profile` entry (header avatar menu) is always available: full name,
role, depot list, change password (Express backend only, §3.7), sign out.

### 10.5 Dashboard screen

- Depots from `user.depots`; picker when >1 (remember last selection in storage);
  required single depot for this endpoint.
- Date-range presets: **Today** (default), Yesterday, This Week, This Month, Custom
  (`from`/`to` pickers, §4.2 date strings).
- `GET /dashboard/depot` → metrics grid of StatCards, each gated by `comp()` key
  (§12.2): `card_total_sales`, `card_pos_sales`, `card_cash_sales`,
  `card_credit_sales`, `card_customer_credit`, `card_supplier_debt`,
  `card_supplier_purchases`, `card_customer_payments`, `card_expenses`,
  `card_stock_value` (subtitle = `stock_value_date`), `card_residual_balance`,
  `card_cash_at_hand` (+ `cash_at_bank` from settings as a secondary stat).
- **Daily Movement** list (`daily` rows) gated by `comp('dashboard_depot','daily_movement')`.
- Pull-to-refresh; loading spinner; error banner with server message.
- Hint strings (copy from the web app): Residual Balance — "Total sales + present
  stock − previous stock − purchases"; Cash at Hand — "Cash sales − expenses".

### 10.6 Sales screens (cash & credit — one parameterised screen)

- **List:** `GET /cash-sales` / `GET /credit-sales` with `depotId`, `from`/`to`
  (default today), `page`/`pageSize` 50. Show `postedTotal` in the header area
  ("Posted: ₦550,000.00"). Row: date (`25 Sep`), amount (right, tabular), reference,
  credit → customer name/code; badge "Reversed" (rose) when `status !== 'posted'`.
  Infinite scroll or Prev/Next pagination; pull-to-refresh.
- **New Entry** (bottom sheet; `can(page,'input')` **and**
  `comp(page,'new_entry').input`): fields depot (picker), date (default today,
  `YYYY-MM-DD`), amount (MoneyInput), credit → customer picker (searchable, same
  depot, active only), reference (placeholder per flow: cash "Receipt number", credit
  "Invoice number"), notes. Submit → `POST`; on 400/409 show the server message
  verbatim in the sheet; on 201 optimistic-add to the list and toast "Saved".
- **Row actions** (long-press or row → detail sheet; each gated by
  `comp(page,'edit_action')` / `comp(page,'reverse_action')` and `can(page,'edit')`):
  - *Correct* → same form pre-filled (editable fields §7.11) + required Reason → `PUT /:id`.
  - *Reverse* → required Reason confirm → `POST /:id/reverse`; success updates the row badge.
  - Reversed rows: actions disabled with the 409 message surfaced on attempt.

### 10.7 Customers screen & ledger

- **List:** `GET /customers` with `depotId`, `search` (debounced), `withBalance`
  toggle, `isActive` filter. Header shows `totalBalance`. Row: name, code, phone,
  balance (right; rose if > 0 debt is "owed to us" — display positive as emerald per
  web app: balance is what the customer owes, shown plain), inactive badge.
- **Detail/ledger:** `GET /customers/:id/ledger?to=` (permission `view_history` —
  hide the drill-in when missing). Header: account info + as-of balance
  (`account.balance`). Entries: date, entry_type badge (Sale debit / Payment credit),
  amount, running balance (right, tabular). Balance-as-of date picker.
- Credit sale → customer shortcut: from a customer row, "Record credit sale" opens
  the §10.6 entry sheet pre-selected for that customer (if permitted).

### 10.8 Alerts (notifications) screen

- `GET /notifications` → list newest-first: severity dot (info `slate-400`,
  warning amber, critical rose), title, message, relative time ("2h ago"),
  unread styling (bold + `indigo-50` tint). Empty state: "No notifications".
- Tapping marks read **only when running against Express**
  (`POST /notifications/:id/read`); with pure edge backend, display-only + note.
  Refresh on focus.

### 10.9 Parity checklist against the Flutter reference app (`mobile/`)

The React Native app is the replacement for the Flutter app and must match:
- Adaptive shell: bottom tabs (phones) / navigation rail (≥840dp) — §10.4.
- The exact five surfaces: Dashboard, Cash Sales, Credit Sales, Customers + ledger,
  Alerts, plus login and profile — §10.5–§10.8.
- Same models/fields (`SaleRow`, `CustomerRow`, `LedgerEntry`, `AppNotification`,
  `SessionUser`) — see `mobile/lib/core/models.dart` for the authoritative field list.
- Same money/date formatting — §9.5 (`mobile/lib/core/format.dart`).
- Same error messaging and 401 handling — `mobile/lib/core/api_client.dart`.
- **Improvements expected** (production quality): secure token storage
  (Flutter used SharedPreferences — upgrade to SecureStore), typed API layer,
  pull-to-refresh everywhere, skeleton loading states, full a11y labels.

### 10.10 Optional: unlocking the full API on mobile

Tokens are interchangeable (§3.1). If the app must expose POS sales, supplier flows,
expenses, stock, reports, audit, or administration on mobile, choose one:
1. **Extend `mobile-api`** with the needed routes by porting the matching Express
   service (they share `_shared/` mirrors; keep formula parity §8.4), then
   `supabase functions deploy mobile-api`; or
2. **Host the Express API** publicly (any Node host; set `CLIENT_ORIGIN` accordingly —
   CORS does not apply to native apps) and point `EXPO_PUBLIC_API_BASE_URL` at it.
Route contracts for every endpoint already exist in §7.

### 10.11 Quality standards (production, not MVP)

- **TypeScript strict**; API types generated from §6/§7 (or hand-written from §12).
- **Error UX:** every server message surfaces verbatim (they are written to be
  user-safe); network failures show retry; no silent catches except logout best-effort.
- **Loading:** skeletons for lists, disabled submit buttons with activity indicator
  during writes, no double-submits (guard with an `isSubmitting` flag).
- **Empty states** with guidance text (e.g. "No cash sales yet for this depot today").
- **Accessibility:** labels on all inputs/buttons, 44pt minimum touch targets,
  dynamic-type support, contrast ≥ 4.5:1 (palette complies).
- **Offline:** the app may cache last-seen read-only data (query cache persisted to
  AsyncStorage if desired) with a clear "stale" indicator; **writes require
  connectivity** (server stamps make queued writes unsafe — do not implement offline
  write queues).
- **Security:** HTTPS only in production; token in SecureStore; no secrets in the
  bundle; certificate pinning optional; respect the audit trail (never fabricate
  entry stamps client-side).
- **Tests:** unit tests for `format.ts` and `guards.ts`; contract tests hitting
  `/health`, login, and one list per backend; RNTL smoke test of login → dashboard.

---

## 11. Deployment, Operations & Testing

### 11.1 Backend commands (operator cheat-sheet)

```bash
# Local dev
npm run dev:server                 # Express on :4000 (auto-migrate + seed on boot)
npm run dev:client                 # Vite on :5173 (proxies /api)
npm run db:push                    # migrations + base seed against DATABASE_URL
npm run seed:demo                  # demo dataset (users/depots/transactions)

# Edge functions
npx supabase link --project-ref cayshvamuqdlhmkspjwq
supabase functions deploy mobile-api
supabase functions deploy alerts-worker
npx --yes -p typescript@5.6.3 tsc --noEmit -p supabase/tsconfig.json   # type-check

# Alerts schedule (one-time, Supabase SQL editor; pg_cron + pg_net enabled)
select cron.schedule('depot-alerts-worker', '*/15 * * * *', $$
  select net.http_post(
    url := 'https://cayshvamuqdlhmkspjwq.supabase.co/functions/v1/alerts-worker',
    headers := jsonb_build_object('Content-Type','application/json',
                                  'x-cron-secret','<CRON_SECRET>'),
    body := '{}'::jsonb) as request_id;
$$);
```

Ordering constraint: apply DB migrations before (re)deploying `mobile-api` — the edge
reads `role_permissions` / `role_page_components` at request time. All 6 migrations are
currently applied ("schema is up to date" on boot).

### 11.2 Mobile app build & release

- Development: `npx expo start` with `EXPO_PUBLIC_API_BASE_URL` pointing at the dev
  Express server (`http://10.0.2.2:4000/api` for the Android emulator).
- EAS profiles (`eas.json`): `development` (dev URL), `preview`, `production`
  (`https://cayshvamuqdlhmkspjwq.supabase.co/functions/v1/mobile-api`). The base URL is
  baked at build time via `EXPO_PUBLIC_*`; runtime switching is optional via an
  in-app "Server" setting on debug builds only.
- `eas build --platform all` + `eas submit`; OTA updates via `eas update` for JS-only
  changes. App name "Bisan Ventures", bundle id e.g. `com.bisanventures.depot`.
- App icon: the "B" badge (§9.1) on `indigo-600`.

### 11.3 Verification suites (run before any release)

| Check | Command | Notes |
|-------|---------|-------|
| Acceptance tests (SRS §41) | `npm run test:acceptance` | Full API workflow suite |
| HTTP smoke (21 checks incl. bearer) | `node server/scripts/smoke.js` | From repo root |
| Edge type-check | `tsc --noEmit -p supabase/tsconfig.json` | |
| Web build | `npm run build` | Sanity-checks the shared contract |
| Mobile contract check | curl login + one list per backend | §6 examples |

### 11.4 Runtime operations facts

- Express logs one line per request (`METHOD /path -> status (ms)`), no bodies.
- Every login/logout/write/permission change/role change/password reset/report
  export is audit-logged (§12.4) with IP + user agent.
- Pool sizing: Express `DB_POOL_MAX` (default 10); edge `postgres.js` max 4
  connections per isolate with `prepare: false` (Supavisor requirement).
- Health endpoints: `GET /api/health` (Express) and `GET …/mobile-api/health` — use
  them for uptime monitors.

---

## 12. Appendices — Catalogues & Enums

### 12.1 Page catalogue (18 `page_key`s, with nav sections and icons)

| page_key | Page name | Section | Web icon |
|----------|-----------|---------|----------|
| `dashboard_global` | Global Dashboard | Dashboards | 🌍 |
| `dashboard_depot` | Depot Dashboard | Dashboards | 🏬 |
| `cash_sales` | Cash Sales | Sales | 💵 |
| `pos_sales` | POS Sales | Sales | 💳 |
| `credit_sales` | Credit Sales | Sales | 📝 |
| `customer_payments` | Customer Payments | Customers | 💰 |
| `customers` | Customers / Debtors | Customers | 👥 |
| `supplier_purchases` | Supplier Purchases | Suppliers | 📦 |
| `supplier_payments` | Supplier Payments | Suppliers | 🏦 |
| `suppliers` | Suppliers / Creditors | Suppliers | 🏭 |
| `stock_balance` | Stock Balance | Operations | 📊 |
| `depot_expenses` | Depot Expenses | Operations | 🧾 |
| `reports` | Reports | Insight | 📈 |
| `audit_trail` | Audit Trail | Insight | 🛡️ |
| `notifications` | Notifications | Insight | 🔔 |
| `users` | Users | Administration | 👤 |
| `roles_permissions` | Roles & Permissions | Administration | 🔐 |
| `settings` | System Settings | Administration | ⚙️ |

Actions per page: `view`, `input`, `edit`, `view_history`, `export`, `approve`.

### 12.2 Component catalogue (`role_page_components` keys — gate with `comp()`)

**Dashboards** — `dashboard_global`: `card_total_sales`, `card_total_residual`,
`card_customer_credit`, `card_supplier_debt`, `card_total_cash`,
`card_supplier_purchases`, `card_expenses`, `card_depots_reporting`,
`depot_comparison`. `dashboard_depot`: `card_total_sales`, `card_customer_credit`,
`card_supplier_debt`, `card_residual_balance`, `card_cash_at_hand`, `card_cash_sales`,
`card_pos_sales`, `card_supplier_purchases`, `card_customer_payments`,
`card_expenses`, `card_stock_value`, `daily_movement`.

**Flow pages** (all seven: `cash_sales`, `pos_sales`, `credit_sales`,
`customer_payments`, `supplier_purchases`, `supplier_payments`, `depot_expenses`):
`table`, `new_entry` (input), `edit_action` (input), `reverse_action` (input).

**Accounts** — `customers` / `suppliers`: `table`, `new_entry` (input),
`edit_action` (input), `delete_action` (input).

### 12.3 Roles & seed constants

Roles: `super_admin`(1) / `admin`(2) / `sales_rep`(3) / `staff`(4).
Depots: `ABU` "ABU Depot" (Main Branch), `BIS` "Bisan Depot" (Second Branch).
Expense categories: Transport, Electricity, Rent, Salaries & Wages,
Maintenance & Repairs, Fuel & Diesel, Security, Water, Communication, Bank Charges,
Miscellaneous.
System settings: `cash_at_bank` = 0, `customer_debt_alert_threshold` = 1000000,
`supplier_debt_alert_threshold` = 1000000, `notifications_enabled` = true.

### 12.4 Audit action types

`LOGIN`, `LOGOUT`, `LOGIN_FAILED`, `LOGIN_BLOCKED`, `CREATE`, `UPDATE`, `DELETE`,
`CORRECTION`, `REVERSAL`, `ROLE_CHANGE`, `PERMISSION_CHANGE`, `DEPOT_ASSIGNMENT`,
`PASSWORD_RESET`, `PASSWORD_CHANGE`, `ROLE_ACCESS_UPDATE`, `REPORT_VIEW`,
`REPORT_EXPORT`.

### 12.5 Notification types & severities

Types: `customer_debt`, `supplier_debt`, `approval`, `permission_change`, `system`,
`transaction`. Severities: `info`, `warning`, `critical`. Debt alerts are `warning`.
`user_id = null` means broadcast to all users with notifications permission.

### 12.6 Enumerations used in request bodies

| Field | Allowed values |
|-------|----------------|
| `status` filters | `posted` \| `reversed` \| `all` |
| `paymentMethod` | `Cash` \| `POS` \| `Bank Transfer` \| `Cheque` \| `Bank Deposit` |
| `purchaseType` | `credit` \| `cash` |
| `roleKey` | `super_admin` \| `admin` \| `sales_rep` \| `staff` |
| ledger `entry_type` (customer) | `credit_sale` \| `payment` |
| ledger `entry_type` (supplier) | `purchase` \| `payment` |
| ledger `direction` | `debit` \| `credit` |
| `transaction_type` (reversals) | `cash_sale`, `pos_sale`, `credit_sale`, `customer_payment`, `supplier_purchase`, `supplier_payment`, `depot_expense`, `stock_value` |

### 12.7 Primary source files (for deep reference)

| Topic | File |
|-------|------|
| Edge router | `supabase/functions/mobile-api/index.ts` |
| Edge auth/permissions | `supabase/functions/_shared/auth.ts` |
| Edge metrics | `supabase/functions/_shared/metrics.ts` |
| Edge validation/stamps | `supabase/functions/_shared/stamps.ts` |
| Express services | `server/src/services/{financialService,dashboardService,accessService,notifyService,permissionCatalog}.js` |
| Express routes | `server/src/routes/*.js` (mounted in `routes/index.js`) |
| Validation | `server/src/utils/stamps.js` |
| Migrations | `server/src/db/migrations/0001…0006.sql`, `seed.js` |
| Web design system | `client/src/components/ui.jsx`, `client/src/index.css`, `client/src/components/Layout.jsx`, `client/src/pages/LoginPage.jsx` |
| Web auth/gating | `client/src/context/AuthContext.jsx`, `client/src/api/client.js` |
| Formatting | `client/src/utils/format.js`, `mobile/lib/core/format.dart` |
| Flutter reference app | `mobile/lib/**` (`main.dart`, `core/`, `pages/`, `widgets/`) |
| Edge deploy guide | `supabase/functions/README.md`, root `README.md` |

---

*End of specification. Questions about any contract should be resolved by reading the
source file listed in §12.7 — the code is the final authority, and this document
mirrors it as of September 2026.*
