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
- **anon key** and **service_role key**

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
SUPABASE_SERVICE_ROLE_KEY="eyJ..."        # from supabase status -o env (SERVICE_ROLE_KEY)

# Local database (same for both — no pooler needed locally)
DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"
DIRECT_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"

# Admin email allowlist (comma-separated)
ADMIN_EMAILS="your-email@utexas.edu"
```

Prisma reads `.env` (not `.env.local`) by default, so also create `apps/platform/.env` with the database URLs:

```env
DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"
DIRECT_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"
```

For other env vars (Cloudinary, Shopify, Stripe, Resend), ask the team lead. These are optional for most local development.

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
| `set-role <userId> <role>` | Assign a role to a user |

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
