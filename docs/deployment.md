# Deployment

How code gets from your branch to production.

## Overview

The LSR Platform is hosted on **Vercel**. Deployments are automated:

- **Push to `main`** triggers a production deployment.
- **Pull requests** get automatic preview deployments with unique URLs once they're out of draft.
- **CI checks** run on every PR once it's out of draft; don't merge one with a failing check.
- **Database migrations** run from a separate GitHub Actions workflow when a push to `main` changes `prisma/migrations/` (see [Database migrations](#database-migrations)).

## CI pipeline

The CI workflow (`.github/workflows/ci.yml`) runs on every push to `main` and on pull requests targeting `main`. It skips draft PRs and runs as soon as a draft is marked ready for review.

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

When you open a pull request, Vercel automatically builds and deploys a preview at a unique URL. Draft PRs are skipped by `apps/platform/scripts/vercel-ignore-build.mjs` (the `ignoreCommand` in `apps/platform/vercel.json`); marking a draft ready doesn't push a commit, so push one (even `git commit --allow-empty`) to get its preview. Use the preview to:

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

A second job (`.github/workflows/recruiting-cron.yml`) calls `/api/cron/recruiting` every 15 minutes. After a recruiting round's deadline it submits every complete draft for its applicant (and emails a confirmation); before the deadline it does nothing, and running it again changes nothing. Unlike the other cron routes it **refuses every request when `CRON_SECRET` is not set**, so the secret must exist in both Vercel and the repo's GitHub secrets (with `SITE_URL`) before the first recruiting deadline.

### Turning recruiting on

Shipping the recruiting code changes nothing for visitors until all of these are done:

1. Create the feature flag row by hand in production (there is no admin toggle; the seed only creates it locally): `INSERT INTO "FeatureFlag" (id, key, enabled) VALUES (gen_random_uuid()::text, 'recruiting', true) ON CONFLICT (key) DO UPDATE SET enabled = true;`
2. Set `PLACEHOLDER_CONTENT` to `false` in `src/schemas/recruiting.schema.ts` once the real teams and questions are in. While it is `true`, `/apply` stays closed on the production site (`VERCEL_ENV=production`), but not on Vercel previews. If previews ever point at the production database, they share the flag row and skip that placeholder gate, so don't turn the flag on until the placeholders are gone.
3. Set `RECRUITING_REPLY_TO`, `CRON_SECRET` and `SITE_URL` (below), and pick a Resend plan if the free daily limit is too small.
4. Create the round on **Admin > Recruiting > Rounds**, add each team's booking link, and make it active.

### Recruiting emails

Set `RECRUITING_REPLY_TO` in Vercel to an inbox officers read. Recruiting emails are sent from the noreply address and every one tells the applicant to "just reply"; the interview email for a team without a booking link relies on replies entirely. Unset, replies go nowhere (the decision dialog warns about this in production).

Recruiting mail counts against the same daily Resend limit as announcements and receipts (`RESEND_DAILY_LIMIT`, 100 on the free plan), and 10 emails a day are held back for registration confirmations and LSC receipts. A round costs roughly 3 to 4 emails per applicant (confirmation, interview, decision), so 60 applicants is about 240 emails, or 2.5+ days of the free plan. Decide on a Resend plan before launch.

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
