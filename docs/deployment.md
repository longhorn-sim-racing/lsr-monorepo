# Deployment

How code gets from your branch to production.

## Overview

The LSR Platform is hosted on **Vercel**. Deployments are automated:

- **Push to `main`** triggers a production deployment.
- **Pull requests** get automatic preview deployments with unique URLs.
- **CI checks** must pass before a PR can be merged.

## CI pipeline

The CI workflow (`.github/workflows/ci.yml`) runs on every push to `main` and on all pull requests targeting `main`.

### Steps

1. **Checkout** -- clones the repository
2. **Install pnpm** -- sets up the package manager
3. **Setup Node.js 20** -- with pnpm dependency caching
4. **Install dependencies** -- `pnpm install --frozen-lockfile`
5. **Lint** -- ESLint across the platform app
6. **Type check** -- `tsc --noEmit` for TypeScript correctness
7. **Build** -- full production build to catch runtime errors

If any step fails, the PR cannot be merged.

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
- **Build command**: `pnpm build` (which runs `prisma generate` via the `prebuild` script, then `next build`)
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
4. The workflow detects changes in `prisma/migrations/`, backs up the production database, and runs `prisma migrate deploy`.

The backup is uploaded as a GitHub Actions artifact (retained 90 days), downloadable from the Actions tab.

### Writing safe migrations

Always make migrations **backwards-compatible**. The Vercel build runs after the migration, so there's a brief window where the old code serves traffic against the new schema.

- **Adding** columns, tables, or indexes is always safe.
- **Renaming or removing** columns requires two deploys: first remove the code reference, then remove the column in a follow-up PR.
- Note the migration in your PR description so reviewers know to check it.

## Guidelines for safe releases

- Keep PRs small and focused. Large PRs are harder to review and riskier to deploy.
- Verify your preview deployment works before requesting review.
- If your change includes a database migration, note it in the PR description.
- After merging, monitor the Vercel deployment for build errors.
- If something breaks in production, use Vercel's instant rollback to redeploy the previous version while you fix the issue.
- Use feature flags (`FeatureFlag` model) to ship code that isn't ready to be visible yet.
