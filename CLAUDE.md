# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Longhorn Sim Racing platform for UT Austin. A monorepo containing the club management application handling events, race results, membership, and content.

## Monorepo Structure

- `apps/platform/` - Main Next.js web application
- `docs/` - Documentation
- `scripts/` - Shared scripts
- `.github/` - CI/CD workflows and repo config

## Tech Stack

- **Monorepo**: pnpm workspaces + Turborepo
- **Framework**: Next.js 16 (App Router with React Server Components)
- **Language**: TypeScript
- **Styling**: Tailwind CSS v4 with shadcn/ui (new-york style)
- **Database**: PostgreSQL via Supabase
- **ORM**: Prisma
- **Auth**: Supabase Auth
- **Fonts**: Montserrat (body), Kanit (display headings)

## Commands

```bash
# Root-level (runs via pnpm filter)
pnpm dev              # Start dev server (localhost:3000)
pnpm build            # Production build
pnpm lint             # ESLint

# From apps/platform/
pnpm dev              # Start dev server (localhost:3000)
pnpm build            # Production build (runs prisma generate first)
pnpm lint             # ESLint
pnpm db:migrate       # Apply Prisma migrations
pnpm db:reset         # Reset and re-seed database
pnpm db:generate      # Regenerate Prisma client
pnpm set-role <userId> <role>  # Assign role to user
```

## Architecture

### Directory Structure (apps/platform/)

- `src/app/` - Next.js App Router pages and layouts
- `src/components/` - React components (feature-specific and shared)
- `src/components/ui/` - shadcn/ui primitives
- `src/lib/` - Utilities (auth clients, dates, validation helpers)
- `src/server/` - Server-side code (queries, repos, services, actions)
- `src/schemas/` - Zod validation schemas
- `prisma/` - Database schema and migrations

### Server Code Organization (`src/server/`)

- `queries/` - Read-only database queries for data fetching, wrapped with React `cache()` for request-scoped memoization
- `repos/` - Repository pattern for entity CRUD operations
- `services/` - Business logic (e.g., registration with waitlist reconciliation, attendance workflows)
- `actions/` - Server Actions for mutations (validate auth → call service → audit log → revalidatePath)
- `auth/` - Session management (`getSessionUser`, `getCachedSessionUser`)

### Path Alias

`@/*` maps to `./src/*` (relative to `apps/platform/`)

### Data Fetching Pattern

Server Components fetch data directly via Prisma. Use `getSessionUser()` or `getCachedSessionUser()` for auth context in server code. Multiple calls to cached queries within the same request deduplicate to a single database query.

### Authorization

- Roles defined in `src/lib/roles.ts`: `member`, `competition`, `officer`, `president`, `alumni`, `admin`
- `isAdmin()` and `requireAdmin()` in `src/lib/authz.ts` check for admin/officer roles
- `ADMIN_EMAILS` env var provides email allowlist bypass (checked before database lookup)
- JIT user provisioning: users are auto-created in Prisma on first Supabase auth

### Key Database Models (Prisma)

- **User** - Club members with roles, entitlements, registrations
- **Event** - Club events with registration/attendance tracking, eligibility rules
- **League/Season/Round/Session** - Racing competition structure
- **Entry/Result** - Season entries and race results
- **Post/Page** - CMS content

### Client Components

Use `"use client"` directive only when interactivity is required. The codebase favors RSC by default.

### Registration System

Event registration uses database locks (`FOR UPDATE`) to prevent race conditions. Waitlist is FIFO with automatic promotion when capacity opens. See `src/server/services/registration.service.ts`.

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
- `SUPABASE_SERVICE_ROLE_KEY` (from `supabase status -o env`)
- `DATABASE_URL` (local: `postgresql://postgres:postgres@127.0.0.1:54322/postgres`)
- `DIRECT_URL` (same as `DATABASE_URL` for local dev)
- `ADMIN_EMAILS` (comma-separated admin email allowlist)

Prisma reads `.env` (not `.env.local`), so `DATABASE_URL` and `DIRECT_URL` must also be in `apps/platform/.env`.

Production credentials live only in Vercel — never in local env files.
