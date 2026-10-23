# Local Development

Step-by-step instructions for running the LSR Platform on your machine.

## Prerequisites

| Tool | Version | Install |
|---|---|---|
| Node.js | 20+ | [nodejs.org](https://nodejs.org) |
| pnpm | 10+ | `npm install -g pnpm` |
| Git | any recent | [git-scm.com](https://git-scm.com) |
| Docker Desktop | latest | [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop/) |

Docker is required for running the local Supabase stack (PostgreSQL, Auth, Studio, etc.).

## 1. Clone and install

```bash
git clone https://github.com/longhorn-sim-racing/lsr-monorepo.git
cd lsr-monorepo
pnpm install
```

## 2. Start the local Supabase stack

Make sure Docker Desktop is running, then from `apps/platform/`:

```bash
cd apps/platform
npx supabase start
```

This pulls and starts Docker containers for PostgreSQL, Supabase Auth, Studio, and other services. The first run takes a few minutes to download images.

When it finishes, it prints connection details including:
- **API URL** (e.g., `http://127.0.0.1:54321`)
- **DB URL** (e.g., `postgresql://postgres:postgres@127.0.0.1:54322/postgres`)
- **anon key**
- **service_role key** (`SERVICE_ROLE_KEY`): only Jack uses it, server side, to stream replies to rooms (see [Jack locally](#jack-locally))

You can retrieve these at any time with:

```bash
npx supabase status -o env
```

**Local Supabase Studio** is available at **http://127.0.0.1:54323** for browsing your local database.

## 3. Environment variables

Copy the template:

```bash
cp apps/platform/.env.example apps/platform/.env.local
```

Fill in `apps/platform/.env.local` using the values from `supabase start` output:

```env
# Supabase local URLs and keys
NEXT_PUBLIC_SUPABASE_URL="http://127.0.0.1:54321"
NEXT_PUBLIC_SUPABASE_ANON_KEY="eyJ..."   # from supabase status -o env (ANON_KEY)

# Local database (same for both — no pooler needed locally)
DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"
DIRECT_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"

# Base URL for links and redirects (keep it, or delete the line; don't leave it empty)
NEXT_PUBLIC_SITE_URL="http://localhost:3000"

```

Prisma reads `.env` (not `.env.local`) by default, so also create `apps/platform/.env` with the database URLs:

```env
DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"
DIRECT_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"
```

For other env vars (Cloudinary, Shopify, Stripe, Resend), ask the team lead. These are optional for most local development. Stripe uses test-mode keys locally; see [payments.md](./payments.md). Jack's env vars are in [Jack locally](#jack-locally).

> **Never put production database credentials in your local env files.** Production credentials live only in Vercel.

## 4. Apply migrations and seed the database

```bash
cd apps/platform
pnpm db:migrate    # Apply all Prisma migrations to the local database
pnpm db:reset      # Reset and seed with test data
```

## 5. Generate the Prisma client

This must be done before the first build or whenever the schema changes:

```bash
pnpm --filter @lsr/platform db:generate
```

## 6. Start the dev server

From the repo root:

```bash
pnpm dev
```

Or from the app directory:

```bash
cd apps/platform
pnpm dev
```

The app will be available at **http://localhost:3000**.

## 7. Make yourself an admin

Sign in once so your account exists, then give it the admin role:

```bash
cd apps/platform
pnpm set-role you@utexas.edu admin
```

`set-role` takes an email, a handle or a user id. Admin console access comes only from the `officer` and `admin` roles.

## Managing the local Supabase stack

```bash
npx supabase start      # Start all containers
npx supabase stop       # Stop containers (data persists in Docker volumes)
npx supabase stop --no-backup  # Stop and discard local data
npx supabase status     # Show running services and ports
npx supabase status -o env     # Show connection details in env format
```

You need to run `npx supabase start` whenever you restart Docker Desktop.

## Available scripts

Run these from the repo root using `pnpm --filter @lsr/platform <script>`, or from `apps/platform/` directly with `pnpm <script>`.

| Script | Purpose |
|---|---|
| `dev` | Start the development server |
| `build` | Production build (runs `prisma generate` automatically) |
| `lint` | Run ESLint |
| `typecheck` | Run TypeScript type checking |
| `db:generate` | Regenerate the Prisma client |
| `db:migrate` | Create and apply a new migration |
| `db:deploy` | Apply pending migrations (production) |
| `db:reset` | Reset the database and re-seed |
| `set-role <email\|handle\|userId> <role>` | Assign a role to a user |
| `test` | Unit tests (Vitest) |
| `jack:fakes` | Run the local fakes of Jack's outside services ([below](#the-fakes-server)) |
| `jack:tick` | Run due scheduled jobs once; `--job <key>` runs one now ([below](#scheduled-jobs)) |
| `jack:eval` | Jack's eval; add `--db=lsr_eval`, or it runs on `DATABASE_URL`'s database ([docs/jack.md](./jack.md#the-eval)) |
| `jack:eval:prepare` | Migrate and seed the eval copy ([below](#the-eval-copy)) |
| `jack:scheduler-setup` | Print the scheduler's pg_cron and Vault SQL (a production setup step; `--local` for a local dev server). It also creates the switched-off job rows in `DATABASE_URL`'s database; `--no-db` skips that |

## Jack locally

Jack is the officer chat agent ([jack.md](./jack.md)). Everything about him runs locally against local Supabase and local fakes of the outside services. Nothing here needs a production key, and only `ANTHROPIC_API_KEY` costs money.

### Env vars

Put these in `apps/platform/.env.local`. All are optional; the app runs without them. [jack.md](./jack.md#environment-variables) explains each one.

| Variable | Locally |
|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Recommended: replies stream into the room with it. `SERVICE_ROLE_KEY` from `npx supabase status -o env`. Without it, reload the room to see a reply |
| `JACK_DATABASE_URL` | Needed for `run_sql`, `describe_schema` and the eval. `scripts/jack-local-sql-role.ts` prints it ([below](#the-read-only-sql-role)) |
| `ANTHROPIC_API_KEY` | Only for real answers (paid). Without it Jack answers "isn't connected yet". `try-jack-proposal.ts`, `try-jack-changes.ts` and `try-jack-web.ts` use a scripted fake Claude, `try-jack-tools.ts` calls no model, and `jack:eval --dry-run` uses a fake model. `try-jack-deck.ts` asks the real Claude (paid; `--deck=<id> --exports` is free) |
| `JACK_MONTHLY_BUDGET_USD`, `JACK_AUTOMATION_BUDGET_USD` | Optional (defaults 50 and 10) |
| `JACK_WEB_TOOLS` | Leave unset unless you're testing web search and fetch (paid) |
| `JACK_FILE_STORE` | Leave unset: local files go to `.jack-renders/` ([below](#files)) |
| `JACK_CHROME_PATH` | Only if slides won't render because Chrome or Edge isn't found |
| `JACK_FAKES`, `JACK_FAKES_URL` | Local only: point outside services at the fakes ([below](#the-fakes-server)) |
| `RESEND_BASE_URL` | Local only: `http://127.0.0.1:3999/resend` sends the app's email to the Resend fake |
| `SCHEDULER_SIGNING_SECRET` | Only for `jack:tick --http`: any random hex, e.g. `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` (the dev server reads the same `.env.local`) |
| Outside services (`DISCORD_*`, `TWITCH_*`, `STRIPE_READONLY_KEY`, `GOOGLE_*`, `MS_*`, ...) | Not needed. To try a service, use the fake's own made-up values from its area doc ("Trying it locally" in [jack-2/tracks/](./jack-2/tracks/)) |
| `LSR_EVAL_DATABASE_URL` | Only for `scripts/check-results-service.ts`, to use a copy other than `lsr_eval` |

A service whose env vars are set and that `JACK_FAKES` doesn't cover talks to the real service. Use the fakes' made-up values, not real keys, unless you mean to call the real thing; production keys never go in local env files.

### The read-only SQL role

Jack's SQL tools run as `jack_readonly`, a role the migrations create without a login. To use it locally:

```bash
cd apps/platform
pnpm exec tsx scripts/jack-local-sql-role.ts
```

It gives the role a fresh random password (local databases only) and prints the `JACK_DATABASE_URL` line to add to `.env.local`. A role belongs to the whole local Postgres server, which every worktree (and the `lsr_eval` copy) shares, so the new password replaces the old one for everyone using it. If another worktree already has a `JACK_DATABASE_URL` line, copy that instead of running the script. If you do run it again, update every `.env.local` that has the old line, or `run_sql`, `describe_schema`, `jack:eval` and `try-jack-tools.ts` can't log in there. `pnpm exec tsx scripts/check-jack-sql-role.ts` then checks what the role can and can't read.

### The fakes server

Every outside service (Discord, Twitch, Stripe, Resend, site traffic, Instagram, Cloudinary, Google Drive, Microsoft Graph, Teams webhooks, Claude Files) has an HTTP fake that answers with made-up data on the real API's paths.

```bash
cd apps/platform
pnpm jack:fakes                 # all of them on http://127.0.0.1:3999 (GET / lists them)
pnpm jack:fakes --port 4000     # another port; then JACK_FAKES_URL=http://127.0.0.1:4000
```

Then set `JACK_FAKES=all` (or a list like `discord,twitch`) in `.env.local` and restart the dev server. That moves Jack's connector clients (the ones built on `serviceBaseUrl()`), not the app's own email: set `RESEND_BASE_URL=http://127.0.0.1:3999/resend` too, or a real `RESEND_API_KEY` sends real mail. Checkout Stripe (`STRIPE_SECRET_KEY`) and the browser's Cloudinary uploads aren't faked. The fakes must run on this machine over plain http, and they're never used on Vercel production, whatever the env says. Each fake has test hooks under `/<service>/_fake/…` (go live on Twitch, emit a webhook, fail a call); its area doc lists them.

Connectors ship switched off. To try one, switch it on at **System → Connections** as an admin, run its smoke test against the fake, and switch it off again when you're done if other people or worktrees share your database.

### Scheduled jobs

There's no pg_cron schedule locally. Run jobs by hand:

```bash
cd apps/platform
pnpm jack:tick                       # every job that's switched on and due
pnpm jack:tick --job discord.sync    # one job now, switched on or not
pnpm jack:tick --http                # a signed tick to the dev server, as pg_cron would send it
```

Prefer `--job`: a switched-on job runs from every worktree that ticks the same database. Job keys are on **System → Scheduled jobs**. `jack:tick` refuses anything but a local database. `pnpm jack:scheduler-setup --local` prints SQL that has local pg_cron tick your dev server, but every worktree shares that schedule, so `jack:tick` is usually the better choice.

### Files

Deck renders and room uploads are kept in `apps/platform/.jack-renders/` on disk locally (gitignored), even when `SUPABASE_SERVICE_ROLE_KEY` is set. Room uploads go through a local stand-in route. Local Supabase Storage is only used with `JACK_FILE_STORE=supabase`, which needs the `jack` bucket created first (`pnpm --filter @lsr/platform exec tsx scripts/jack-storage-setup.ts`) and, on stacks made by an older Supabase CLI, an index fix. See [jack-2/tracks/files.md](./jack-2/tracks/files.md).

### The eval copy

Jack's eval runs on `lsr_eval`, a copy of production restored into a database of that name on the local Supabase server. It holds real member data: never commit it or anything made from it (results go to `.claude/hillclimb/`, which is gitignored). Ask the tech lead for a copy.

```bash
cd apps/platform
pnpm jack:fakes                                  # in its own terminal: the seeders sync from the fakes
pnpm jack:eval:prepare                           # apply migrations to lsr_eval and seed every area's fake data
pnpm jack:eval:prepare --db=lsr_eval_test        # another copy (its name must start with lsr_eval)
pnpm jack:eval --db=lsr_eval --dry-run           # every question a fake model can answer (design and a few others are skipped), no API key
```

`prepare` refuses anything but a local server and always uses the fakes (`JACK_FAKES=all`), whatever your env says. For a throwaway copy, `CREATE DATABASE lsr_eval_test TEMPLATE lsr_eval;` in psql, and drop it after.

### Checks and tries

- `scripts/check-*.ts` check what lives in the database (locks, triggers, row level security, the syncs) against the local database, and delete what they write. [jack.md](./jack.md#tests-and-checks) lists them.
- `scripts/try-jack-proposal.ts`, `try-jack-changes.ts` and `try-jack-web.ts` put proposals and web parts in a room with a scripted fake Claude; `try-jack-tools.ts` runs every tool once and calls no model; `try-discord.ts` and `try-discord-post.ts` fill in Discord data from its fake. `try-jack-deck.ts` is the exception: it asks the real Claude (paid; `--deck=<id> --exports` is free).
- Each area doc in [jack-2/tracks/](./jack-2/tracks/) has a "Trying it locally" section.

## Troubleshooting

### `EPERM: operation not permitted` during Prisma generate (Windows)

The Prisma query engine DLL can get locked by a running Node process. Fix:

```bash
# Kill all node processes, then retry
taskkill /F /IM node.exe
pnpm --filter @lsr/platform db:generate
```

### Missing environment variables

If the app crashes on startup with errors about `NEXT_PUBLIC_SUPABASE_URL` or similar, make sure your `.env.local` file is in `apps/platform/` (not the repo root).

### Prisma can't find `DATABASE_URL` or `DIRECT_URL`

Prisma reads `.env` by default, not `.env.local`. Make sure you have an `apps/platform/.env` file with `DATABASE_URL` and `DIRECT_URL` set. See step 3 above.

### Prisma advisory lock timeout

If `db:migrate` or `db:reset` fails with a lock timeout error, a previous Prisma process left a stale lock. Fix by restarting the local Supabase stack:

```bash
cd apps/platform
npx supabase stop
npx supabase start
```

### Docker containers won't start

If `supabase start` fails with container name conflicts, do a clean stop first:

```bash
npx supabase stop --no-backup
npx supabase start
```

### Prisma client out of date

If you see errors about missing Prisma models or fields after pulling new changes:

```bash
pnpm --filter @lsr/platform db:generate
```

If there are new migrations to apply:

```bash
pnpm --filter @lsr/platform db:migrate
```

### Port 3000 already in use

Another process is using port 3000. Either stop it or start Next.js on a different port:

```bash
pnpm --filter @lsr/platform dev -- --port 3001
```

### `pnpm install` warns about ignored build scripts

On first install, pnpm may warn about ignored build scripts for packages like `@prisma/client`, `esbuild`, and `sharp`. These are already approved in the root `package.json` under `pnpm.onlyBuiltDependencies`. If the warning persists, run:

```bash
rm -rf node_modules apps/platform/node_modules
pnpm install
```
