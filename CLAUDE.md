# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Longhorn Sim Racing platform for UT Austin. A monorepo containing the club management application handling events, race results, membership, payments, and content.

## Monorepo Structure

- `apps/platform/` - Main Next.js web application (`@lsr/platform`)
- `docs/` - Documentation
- `.github/` - CI/CD workflows and repo config
- `.claude/skills/lsr-deck/` - Skill for building LSR slide decks

## Tech Stack

- **Monorepo**: pnpm workspaces (one app; the root scripts filter to `@lsr/platform`)
- **Framework**: Next.js 16 (App Router with React Server Components)
- **Language**: TypeScript
- **Styling**: Tailwind CSS v4 with shadcn/ui (new-york style)
- **Database**: PostgreSQL via Supabase
- **ORM**: Prisma
- **Auth**: Supabase Auth
- **Payments**: Stripe (see `docs/payments.md`)
- **Fonts**: Montserrat (body), Kanit (display headings)

## Commands

```bash
# Root-level (runs via pnpm filter)
pnpm dev              # Start dev server (localhost:3000)
pnpm build            # Production build
pnpm lint             # ESLint (fails on any warning)
pnpm test             # Unit tests (Vitest)

# From apps/platform/
pnpm dev              # Start dev server (localhost:3000)
pnpm build            # Production build (runs prisma generate first)
pnpm lint             # ESLint (fails on any warning)
pnpm typecheck        # tsc --noEmit
pnpm test             # Unit tests (Vitest); pnpm test:watch to rerun on save
pnpm db:migrate       # Create/apply migrations (prisma migrate dev)
pnpm db:reset         # Reset, re-apply migrations and re-seed
pnpm db:generate      # Regenerate Prisma client
pnpm set-role <userId> <role>  # Assign role to user
```

## Architecture

### Directory Structure (apps/platform/)

- `src/app/` - App Router pages, layouts, API routes, and most Server Actions (colocated `actions.ts`)
- `src/components/` - React components (feature-specific and shared)
- `src/components/ui/` - shadcn/ui primitives
- `src/lib/` - Utilities (roles, dates, Stripe/Shopify/email clients, `publicUserSelect`)
- `src/server/` - Server-side code (see below)
- `src/schemas/` - Zod validation schemas
- `prisma/` - Database schema, migrations and seed
- `scripts/` - One-off and ops scripts run with `tsx` (`set-role`, `payments-smoke`, LSC season setup)

### Server Code

- **Server Actions** - Mostly colocated in `src/app/**/actions.ts` (e.g. `src/app/admin/events/actions.ts`); a few shared ones in `src/server/actions/`. Pattern: guard → validate input → service/repo or Prisma → `createAuditLog` (`src/server/audit/log.ts`) for admin changes → `revalidatePath`
- `src/server/queries/` - Read-only queries for Server Components. Some are wrapped in React `cache()`; check before relying on dedup
- `src/server/services/` - Business logic (registration and waitlist, attendance, payments/checkout, league entry, memberships, notifications)
- `src/server/repos/` - CRUD for a few entities (events, series, venues, standings, memberships)
- `src/server/auth/` - `getSessionUser` (`session.ts`), `getCachedSessionUser` (`cached-session.ts`), guards (`guards.ts`)
- `src/server/db.ts` - The shared Prisma client

### Path Alias

`@/*` maps to `./src/*` (relative to `apps/platform/`)

### Data Fetching Pattern

Server Components fetch data directly via Prisma or `src/server/queries/`. Use `getCachedSessionUser()` (a React `cache()` wrapper around `getSessionUser()`) for auth context during a render, so repeated calls in one request share a single lookup.

### Authorization

- Roles in `src/lib/roles.ts`: `officer` and `admin` grant admin console access; `lsc_driver` and `collegiate_driver` are display badges only
- Guards in `src/server/auth/guards.ts`: `requireUser()`, `requireRole(role | roles)`, `requireOfficer()` (admin or officer, throws), `requireOfficerPage()` (same check, redirects to `/403`)
- Each admin page must check access itself (`requireOfficerPage()`); the admin layout checks too, but layouts don't re-run on partial renders. Each Server Action checks its own access
- `requireRole` also lets in emails listed in the `ADMIN_EMAILS` env var (checked after the session lookup)
- JIT user provisioning: `getSessionUser()` creates the Prisma `User` on first Supabase sign-in

### Public Pages and Privacy

Anything passed to a client component on a public page ends up in the HTML. Public queries must select users through `publicUserSelect` (`src/lib/public-user.ts`), never full `User` rows (those include emails and EIDs).

### Key Database Models (Prisma)

See `prisma/schema.prisma` for the full list.

- **User / Role / UserRole** - Members and their roles; **AuditLog** records admin changes
- **Event** (+ `EventSeries`, `Venue`, `EventRegistration`, `EventAttendance`) - Club events with registration, waitlist and check-in
- **League / Season / Entry** - Competition structure; `Entry` holds a driver's per-season standings aggregates
- **LeagueApplication** - Lone Star Cup entry form
- **RawResultUpload → RaceSession / RaceParticipant / RaceResult / RaceLap / RaceEvent** - Results pipeline from uploaded sim JSON; `DriverIdentity` and `CarMapping` map sim GUIDs and car names
- **Product / Payment / Entitlement / UserMembership** - Payments and what they grant (see `docs/payments.md`)
- **Post / Page** - News posts and editable content pages (e.g. the LSC rules)
- **Notification / NotificationPreference / SystemSetting** - Notifications and site-wide settings

### Client Components

Use `"use client"` directive only when interactivity is required. The codebase favors RSC by default.

### Registration System

Event registration uses database locks (`FOR UPDATE`) to prevent race conditions. Waitlist is FIFO and auto-promotes when capacity opens, except on paid events or when the event's `waitlistAutoPromote` is off. See `src/server/services/registration.service.ts`.

## Tests

Unit tests use Vitest and sit next to the code they test as `*.test.ts` (e.g. `src/lib/money.test.ts`). They run without a database or network: tests that touch Prisma or Resend replace them with `vi.mock` fakes (see `src/server/services/notification.service.test.ts`). CI runs them on every PR. Code that needs a real database (registration locking, the waitlist) isn't covered yet.

## Local Development

Local development uses the **Supabase CLI** to run a full Supabase stack (PostgreSQL, Auth, Studio) in Docker. See `docs/local-dev.md` for setup instructions.

- `npx supabase start` from `apps/platform/` to start the local stack
- `npx supabase status -o env` to get connection details
- Local Supabase Studio at `http://127.0.0.1:54323`
- Supabase config lives in `apps/platform/supabase/config.toml`

## Environment Variables

Required in `apps/platform/.env.local`:
- `NEXT_PUBLIC_SUPABASE_URL` (local: `http://127.0.0.1:54321`)
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` (from `supabase status -o env`)
- `DATABASE_URL` (local: `postgresql://postgres:postgres@127.0.0.1:54322/postgres`)
- `DIRECT_URL` (same as `DATABASE_URL` for local dev)
- `ADMIN_EMAILS` (comma-separated admin email allowlist)

Optional ones (site URL, Stripe, Resend, Cloudinary, Shopify) are listed in `apps/platform/.env.example`.

Prisma reads `.env` (not `.env.local`), so `DATABASE_URL` and `DIRECT_URL` must also be in `apps/platform/.env`.

Production credentials live only in Vercel — never in local env files.

## Contributing

- Work is tracked on the [GitHub Project board](https://github.com/orgs/longhorn-sim-racing/projects/1)
- Tasks are tracked as [GitHub Issues](https://github.com/longhorn-sim-racing/lsr-monorepo/issues)
- Branch naming: `short-description` (e.g., `fix-officer-images`) or `<issue-number>-short-description` for issue work
- Open a **draft** PR as soon as you start on an issue so others can see what's in progress. CI and Vercel previews skip drafts; when you mark it ready for review, push a commit (an empty one is fine) so the Vercel preview builds
- Include `Closes #<number>` in PR descriptions to auto-close issues on merge
- Migrations deploy separately from the app (see `docs/deployment.md`), so keep them compatible with the code already running
- See `docs/onboarding.md` for the full contributor workflow
