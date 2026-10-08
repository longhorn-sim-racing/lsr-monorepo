# Deployment

How code gets from your branch to production.

## Overview

The LSR Platform is hosted on **Vercel**. Deployments are automated:

- **Push to `main`** triggers a production deployment.
- **Pull requests** get automatic preview deployments with unique URLs.
- **CI checks** run on every PR; don't merge one with a failing check.
- **Database migrations** run from a separate GitHub Actions workflow when a push to `main` changes `prisma/migrations/` (see [Database migrations](#database-migrations)).

## CI pipeline

The CI workflow (`.github/workflows/ci.yml`) runs on every push to `main` and on all pull requests targeting `main`.

### Steps

1. **Checkout** -- clones the repository
2. **Install pnpm** -- sets up the package manager
3. **Setup Node.js 20** -- with pnpm dependency caching
4. **Install dependencies** -- `pnpm install --frozen-lockfile`
5. **Generate Prisma client** -- `pnpm --filter @lsr/platform db:generate`
6. **Lint** -- ESLint across the platform app
7. **Type check** -- `tsc --noEmit` for TypeScript correctness
8. **Build** -- full production build (with placeholder Supabase env vars) to catch build errors

If any step fails, fix it before merging. CI isn't a required check on `main` (the ruleset requires a code owner's approval), so reviewers look for it.

### Concurrency

CI uses concurrency groups per branch. If you push again while CI is running, the in-progress run is cancelled and replaced by the new one. This saves CI minutes.

## PR preview deployments

When you open a pull request, Vercel automatically builds and deploys a preview at a unique URL. Use this to:

- Test your changes in a production-like environment
- Share the preview link with reviewers
- Verify the build succeeds on Vercel's infrastructure

Preview URLs follow the pattern: `https://lsr-monorepo-<hash>-<team>.vercel.app`

## Production deployments

Merging a PR into `main` triggers an automatic production deployment on Vercel. The process:

1. PR is approved and CI passes.
2. PR is merged into `main`.
3. Vercel detects the push and starts a build.
4. Vercel runs the build command from `apps/platform/` (root directory is set to `apps/platform` in Vercel project settings).
5. If the build succeeds, the new version goes live.

There is no manual deployment step. If you need to roll back, use Vercel's dashboard to redeploy a previous commit.

## Vercel configuration

- **Root directory**: `apps/platform`
- **Build command**: `pnpm build` (set in `apps/platform/vercel.json`; runs `prisma generate` via the `prebuild` script, then `next build`)
- **Install command**: `pnpm install --frozen-lockfile` (also in `vercel.json`)
- **Output directory**: `.next` (auto-detected by Vercel)
- **Node.js version**: 20

Environment variables (Supabase credentials, Stripe keys, etc.) are configured in the Vercel project dashboard, not committed to the repository. Production database credentials must **never** appear in local env files — local development uses the Supabase CLI local stack instead.

## Scheduled jobs

A GitHub Actions cron job (`.github/workflows/notification-cron.yml`) runs every 15 minutes to process queued notifications. It calls the `/api/cron/notifications` endpoint with a bearer token. This is independent of deployments.

## Database migrations

Migrations are applied automatically via the **Database Migrate** workflow (`.github/workflows/migrate.yml`). The process:

1. Create the migration locally: `pnpm --filter @lsr/platform db:migrate`
2. Commit the generated migration file in `prisma/migrations/`.
3. Open a PR and merge to `main`.
4. The push to `main` changes `apps/platform/prisma/migrations/`, which starts the workflow. It backs up the production database and runs `prisma migrate deploy` (`pnpm --filter @lsr/platform db:deploy`). It can also be run by hand from the Actions tab.

The backup is encrypted (with the `BACKUP_PASSPHRASE` secret) and uploaded as a GitHub Actions artifact (retained 90 days), downloadable from the Actions tab.

### Writing safe migrations

The migration workflow and the Vercel deployment both start from the same push to `main`, and **neither waits for the other**. For a few minutes, either the old code runs against the new schema or the new code runs against the old schema, depending on which finishes first. If the migration fails, the new code stays live against the old schema until someone fixes it.

So a migration must be **compatible with the code that's already deployed**, or be shipped in two steps:

- **Adding** tables, indexes, or nullable (or defaulted) columns is safe for the old code. New code that reads a new column will error until the migration lands, because Prisma selects every column by default; that window is usually short, but if it matters, merge the migration first and the code that uses it in a follow-up PR.
- **Renaming or removing** columns or tables requires two deploys: first ship code that no longer uses them, then remove them in a follow-up PR.
- Note the migration in your PR description so reviewers know to check it.

## Guidelines for safe releases

- Keep PRs small and focused. Large PRs are harder to review and riskier to deploy.
- Verify your preview deployment works before requesting review.
- If your change includes a database migration, note it in the PR description.
- After merging, monitor the Vercel deployment for build errors.
- If something breaks in production, use Vercel's instant rollback to redeploy the previous version while you fix the issue.
