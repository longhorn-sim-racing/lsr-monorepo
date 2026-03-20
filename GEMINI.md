# Project Context: Longhorn Sim Racing Platform (`@lsr/platform`)

## Overview
This is the official web platform for **Longhorn Sim Racing** at UT Austin. It is organized as a monorepo with the main application in `apps/platform/`. The platform manages club operations including event scheduling, race result tracking, membership management, and content publishing.

## Tech Stack
*   **Monorepo:** pnpm workspaces + Turborepo
*   **Framework:** Next.js 16 (App Router)
*   **Language:** TypeScript
*   **Styling:** Tailwind CSS v4, shadcn/ui (Radix Primitives), Framer Motion
*   **Database:** PostgreSQL (via Supabase)
*   **ORM:** Prisma 6.15.0
*   **Authentication:** Supabase Auth (SSR & Client)
*   **Validation:** Zod, React Hook Form
*   **Date Handling:** date-fns

## Key Directories
*   `apps/platform/src/app`: Next.js App Router pages, layouts, and API routes.
*   `apps/platform/src/components`: React components.
    *   `apps/platform/src/components/ui`: Reusable UI components (shadcn/ui).
*   `apps/platform/src/lib`: Shared utilities, configuration, and business logic.
    *   `apps/platform/src/lib/prisma.ts`: Prisma client instance.
    *   `apps/platform/src/lib/supabase-*.ts`: Supabase client initialization (client/server/rsc).
*   `apps/platform/src/server`: Server-side specific logic (Actions, Queries, Repos, Services).
*   `apps/platform/prisma`: Database schema, migrations, and seed scripts.
*   `apps/platform/public`: Static assets.
*   `apps/platform/scripts`: Utility scripts (e.g., `set-role.ts`).

## Database Schema (Prisma)
The database is extensive, covering several domains:
*   **Identity & Access:** `User`, `Role`, `UserRole`, `AuthIdentity`.
    *   Roles: `admin`, `officer`, `member`, `competition`, `president`, `alumni`.
*   **Events:** `Event`, `EventSeries`, `Venue`, `EventRegistration`, `EventAttendance`.
    *   Supports check-ins via QR or manual entry.
*   **Racing Data (Leagues):** `League`, `Season`, `Round`, `Session`, `Result`, `Entry`.
    *   Tracks traditional season standings and individual race results.
*   **Ingestion (Sim Data):** `RawResultUpload`, `RaceSession`, `RaceParticipant`, `RaceResult`.
    *   Handles raw JSON uploads from sim racing games.
*   **Commerce & Membership:** `Product`, `Payment`, `Entitlement`, `MembershipTier`.
*   **Content:** `Post`, `Page`, `Media`, `GalleryImage`.

## Development Workflow

### Prerequisites
*   Node.js (v20+)
*   pnpm 10+
*   Docker Desktop (for local Supabase stack)
*   Env vars set in `apps/platform/.env.local` (copy from `apps/platform/.env.example`).
*   Prisma also reads `apps/platform/.env` for `DATABASE_URL` and `DIRECT_URL`.

### Key Commands
*   **Start Dev Server:** `pnpm dev`
*   **Build:** `pnpm build`
*   **Lint:** `pnpm lint`
*   **Type Check:** `pnpm --filter @lsr/platform typecheck`
*   **Database Migrations:** `pnpm --filter @lsr/platform db:migrate`
*   **Generate Prisma Client:** `pnpm --filter @lsr/platform db:generate`
*   **Set User Role:** `pnpm --filter @lsr/platform set-role <userId> <role>`
*   **Seed Database:** `cd apps/platform && npx prisma db seed`

## Environment Variables
*   `NEXT_PUBLIC_SUPABASE_URL`: Supabase URL (local: `http://127.0.0.1:54321`).
*   `NEXT_PUBLIC_SUPABASE_ANON_KEY`: Supabase anon key (from `npx supabase status -o env`).
*   `SUPABASE_SERVICE_ROLE_KEY`: Supabase service role key (from `npx supabase status -o env`).
*   `DATABASE_URL`: PostgreSQL connection string (local: `postgresql://postgres:postgres@127.0.0.1:54322/postgres`).
*   `DIRECT_URL`: Direct connection string (same as `DATABASE_URL` for local dev).
*   `ADMIN_EMAILS`: Comma-separated admin email allowlist.

Local development uses the Supabase CLI (`npx supabase start` from `apps/platform/`) to run PostgreSQL, Auth, and Studio in Docker. Production credentials live only in Vercel.

## Architecture & Conventions
*   **React Server Components (RSC):** The app uses the App Router. Default to Server Components unless interactivity is needed (`"use client"`).
*   **Data Fetching:** Fetch data directly in Server Components using Prisma or cached queries.
*   **Mutations:** Use Server Actions for form submissions and data mutations.
*   **Server Code Layers:** Actions → Services → Repos → Prisma.
*   **Type Safety:** Heavy use of Zod for schema validation (forms, env vars, API inputs).
*   **Styling:** Utility-first CSS with Tailwind. Components are built on top of Radix UI primitives.
*   **Path Alias:** `@/*` maps to `./src/*` (relative to `apps/platform/`).
