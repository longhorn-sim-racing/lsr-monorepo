# Codebase survey: infrastructure and conventions (10/22)

Read-only survey for Jack 2.0. Paths are under the repo root.

## 1. Migrations
- **Kinds of migration:**
  - Prisma-generated SQL;
  - Prisma output plus a hand-written tail (e.g. `20261015000000_add_recruiting`, with a "Hand-written (Prisma can't express these)" section);
  - fully hand-written (`20261013180000_jack_sql_role`, `20261014020000_jack_room_stand`).
- **Names and headers:** folders are `YYYYMMDDHHMMSS_snake_case/migration.sql`, with round times recently. Headers name the issue and say why the migration is safe to apply before the app deploys.
- Keep `schema.prisma` in step (see `20260415164226_reconcile_schema_drift`). There's no multiSchema; Prisma manages `public` only.
- **Prod deploy:** `.github/workflows/migrate.yml` runs on a push to main touching `apps/platform/prisma/migrations/**`, or by hand.
  - It takes an encrypted `pg_dump` backup as an artifact (90 days), then runs `prisma migrate deploy`.
  - Secrets: `PRODUCTION_DATABASE_URL`/`PRODUCTION_DIRECT_URL` on the session pooler (the direct host is IPv6-only).
- **Compatibility:** the migration and the Vercel deploy start from the same push and neither waits for the other.
  - Adding tables, indexes, or nullable/defaulted columns is safe.
  - Code reading a new column errors until the migration lands.
  - Renames and drops take two deploys.
  - CI never runs migrations.
- **`jack_readonly` role** (`20261013180000_jack_sql_role`):
  - NOLOGIN NOINHERIT CONNECTION LIMIT 5; read-only by default, statement_timeout 5 s, idle timeout 10 s, search_path public.
  - SELECT on all public tables, plus default privileges granting SELECT on new tables. **Only tables created by `postgres` get the automatic grant.**
  - Revoked: `SystemSetting`, `_prisma_migrations`.
  - The migration ends with self-checks that RAISE on bad attributes, extra privileges, or USAGE on auth/storage/realtime/vault/jack_private. The prod password is set by hand.
  - Local setup: `apps/platform/scripts/jack-local-sql-role.ts`. Verify with `check-jack-sql-role.ts`.
- **A new table, depending on what it holds:**
  - **Readable by Jack, nothing sensitive:** do nothing (default privileges, no RLS).
  - **Personal data:** copy the add_recruiting tail: enable RLS, revoke anon/authenticated (guarded), and add the Jack read policy:
    ```sql
    ALTER TABLE "public"."X" ENABLE ROW LEVEL SECURITY;
    DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='jack_readonly') THEN
      EXECUTE 'DROP POLICY IF EXISTS jack_readonly_select ON public."X"';
      EXECUTE 'CREATE POLICY jack_readonly_select ON public."X" FOR SELECT TO jack_readonly USING (true)';
    END IF; END $$;
    ```
  - **Secrets:** `REVOKE ALL ON public."X" FROM jack_readonly;` in the creating migration, guarded by a role-exists check, ideally with a `has_table_privilege` RAISE check. Or keep secrets outside `public` (Vault).
  - Hiding a table only affects `run_sql`/`describe_schema`; typed tools use the app's Prisma client.
- **In prod, anon/authenticated have no USAGE on schema public** (set by hand). Locally they do, and the default ACL grants them privileges on new public tables, so RLS still matters.

## 2. Supabase
- `apps/platform/supabase/config.toml`: Postgres 17, `extra_search_path = ["public","extensions"]`, no extension config, vault commented out. There's no `supabase/migrations` folder; all DDL goes through Prisma.
- **Local DB:**
  - Installed: pgcrypto, uuid-ossp, pg_stat_statements (schema `extensions`), supabase_vault 0.3.1.
  - **pg_cron 1.6.4 and pg_net 0.20.4 are available and preloaded but not installed;** both target database `postgres`.
  - `postgres` has CREATEROLE but isn't superuser.
- **No `CREATE EXTENSION`, `cron.schedule`, `net.http_*` or vault use in the repo yet.**
- **pg_cron migration caveat:** `prisma migrate dev` replays migrations on a shadow database in the same cluster. That database has no auth/realtime, and pg_cron can only be created in `postgres`. Guard the block, e.g. `IF to_regnamespace('auth') IS NULL OR current_database() <> current_setting('cron.database_name', true) THEN RAISE NOTICE …; RETURN; END IF;`.
- **Supabase's usual approach:** `create extension pg_cron with schema pg_catalog`; `create extension pg_net with schema extensions` (its functions live in `net`).
- Add `cron` and `net` to the jack_readonly USAGE self-check. Keep route secrets in `vault.decrypted_secrets`, not in `cron.job` text.
- **Realtime** (`20261013033000_jack_rooms`):
  - `jack_private.is_officer()` is SECURITY DEFINER with an empty search_path.
  - Policies on `realtime.messages`: `jack_officers_receive` and `jack_officers_track_presence`. They're permissive and OR together, so any new policy must exclude `jack:%` topics.
  - The server broadcasts over REST with the service role key (`apps/platform/src/server/jack/broadcast.ts`).

## 3. Scheduled work today
- **No Vercel crons.** `apps/platform/vercel.json` has build/install/ignoreCommand only.
- **GitHub Actions** `curl` the site with `Authorization: Bearer ${CRON_SECRET}`:
  - `notification-cron.yml` (`*/15` → `/api/cron/notifications`)
  - `recruiting-cron.yml` (`*/15` → `/api/cron/recruiting`)
  - `instagram-cron.yml` (`7 * * * *` → `/api/cron/instagram`)
  - GitHub pauses schedules after 60 days without commits.
- **Auth:**
  - `notifications` and `instagram` check only in production with a plain `!==`, and **fail open if CRON_SECRET is unset** ("Bearer undefined").
  - `recruiting` uses `isAuthorizedCronRequest` (`apps/platform/src/lib/recruiting/cron-auth.ts`): it fails closed with sha256 + timingSafeEqual and has tests. **Copy this one.**
- **Route settings:** `dynamic="force-dynamic"`, `maxDuration=60`. Use `runAfterResponse` (`apps/platform/src/server/after-response.ts`) for work after the response.

## 4. Vercel Blob
- `apps/platform/src/server/jack/decks/storage.ts` `jackFileStore()`:
  - picks blob if `BLOB_READ_WRITE_TOKEN` or `BLOB_STORE_ID` is set (OIDC), otherwise `.jack-renders/` files locally, otherwise none;
  - always `access: "private"`; puts use `addRandomSuffix:false, allowOverwrite:true`;
  - reads use `get()`; links come from `issueSignedToken` + `presignUrl`;
  - `setJackFileStore()` is the test seam.
- **No client-upload route exists.** Today's browser uploads go to Cloudinary (unsigned preset, or a signed video upload in `apps/platform/src/server/cloudinary.ts`).
- **@vercel/blob 2.8.2:**
  - `handleUpload` defaults to `BLOB_READ_WRITE_TOKEN`, which the OIDC setup lacks.
  - **`handleUploadPresigned` / `uploadPresigned` use `issueSignedToken`, which works with OIDC.** They verify the completion callback with `BLOB_WEBHOOK_PUBLIC_KEY` over `x-vercel-signature`. Use these.

## 5. Environment variables
| Service | Variables |
|---|---|
| Supabase | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` |
| Database | `DATABASE_URL`, `DIRECT_URL`, `JACK_DATABASE_URL` (transaction pooler, `?pgbouncer=true`, connection_limit=2) |
| Site | `NEXT_PUBLIC_SITE_URL` (falls back to `VERCEL_ENV`/`VERCEL_URL`, `src/lib/site-url.ts`) |
| Cloudinary | `NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME`, `NEXT_PUBLIC_CLOUDINARY_UPLOAD_PRESET`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` |
| Instagram | Token in the SystemSetting row `instagram`; `INSTAGRAM_GRAPH_URL` is a local stand-in |
| Email | `CRON_SECRET`, `RESEND_API_KEY`, `RESEND_DAILY_LIMIT`, `RECRUITING_REPLY_TO` |
| Stripe | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_TEST_SECRET_KEY` (scripts) |
| Jack | `ANTHROPIC_API_KEY`, `JACK_MONTHLY_BUDGET_USD`, `BLOB_STORE_ID`/`BLOB_READ_WRITE_TOKEN`, `JACK_CHROME_PATH` |
| GitHub secrets | `SITE_URL`, `CRON_SECRET`, `PRODUCTION_DATABASE_URL`, `PRODUCTION_DIRECT_URL`, `BACKUP_PASSPHRASE` |

- **How optional config is handled:**
  - return null plus a "not connected" message (Jack SQL, Claude);
  - a boolean `…Configured()` check;
  - log and no-op;
  - a result object (Resend);
  - throw on use (Stripe);
  - admin banners;
  - testable env parsing (`jackMonthlyBudgetUsd(env)`).
- **Stale docs:** `.env.example` says the Jack budget is 200 (the code says 50); `docs/local-dev.md` says the service_role key is unused; `docs/deployment.md` says Node 20 and no test step.

## 6. Tests
- **Config:** Vitest 5.0.3, node environment, `src/**/*.test.ts`, mockReset/restoreMocks/unstubEnvs. No DB or network.
- **Prisma fakes:**
  - hoisted mock: `const db = vi.hoisted(() => ({ notification: { create: vi.fn() } })); vi.mock("@/server/db", () => ({ prisma: db }))`;
  - or the in-memory `createFakeJackDb()` (`src/server/jack/jack-test-db.ts`).
- **External services:** `vi.mock("resend")`; Claude injected through `ReplyLoopDeps` with `fakeClaude()` (`src/server/jack/fake-claude.ts`); Blob through `setJackFileStore`; env through `vi.stubEnv`.
- **Route handlers:** mock `@/server/auth/guards` and call `GET(new NextRequest(url))` (`src/app/admin/recruiting/export/route.test.ts`). Server actions mock `next/cache`.
- **DB checks** are tsx scripts against local Supabase (`check-jack-sql-role.ts`, `check-jack-realtime.ts`, `check-recruiting-service.ts`).
- **CI** (`.github/workflows/ci.yml`): pushes to main and PRs (skips drafts). Steps: install → db:generate → lint (`--max-warnings 0`) → typecheck → test → build.

## 7. next.config.ts
- `serverExternalPackages`: @sparticuz/chromium, puppeteer-core. `outputFileTracingIncludes` for `/admin/jack/**` and `/api/admin/jack/**`.
- `images.remotePatterns`: res.cloudinary.com, www.longhornsimracing.org, lh3.googleusercontent.com, cdn.shopify.com.
- No headers/CSP and no middleware/proxy.

## 8. Route handlers (`apps/platform/src/app/api/`)
- **Officer guard:** `/api/admin/audit-logs`, `/api/admin/jack/decks/[deckId]/export` (maxDuration 120), `…/slides/[slideId]` (60), `/api/admin/jack/render-check`.
- **Session:** `/api/check-in/[id]`, `/api/checkout`, `/api/events/[slug]/checkout`, `/api/events/[slug]/registration`, `/api/notifications`, `/api/notifications/[id]/read`.
- **Public:** `/api/shopify/cart/*`.
- **Signature:** `/api/stripe/webhook`.
- **Bearer secret:** the cron routes (see section 3).
- **Outside `/api`:** `/admin/league-entries/export`, `/admin/recruiting/export`, `/admin/results/[id]/raw` (officer); `/auth/callback`; `/news/rss.xml`.

## 9. Versions
| Package | Installed |
|---|---|
| next | 16.1.6 |
| react | 19.2.4 |
| prisma | 6.15.0 |
| @anthropic-ai/sdk | 0.133.0 |
| @supabase/supabase-js | 2.98.0 |
| @vercel/blob | 2.8.2 |
| stripe | 20.4.1 |
| resend | 6.9.3 |
| zod | 4.3.6 |
| recharts | 3.8.1 |
| vitest | 5.0.3 |

Also: @sparticuz/chromium 153.0.0, puppeteer-core 25.12.0, Node 24.x, pnpm 10.12.1.
