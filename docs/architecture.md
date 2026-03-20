# Architecture

This document describes how the LSR Platform is structured.

## High-level overview

The platform is a **Next.js 16** application using the App Router with React Server Components. It connects to a **PostgreSQL** database via **Supabase**, accessed through **Prisma** ORM. Authentication is handled by **Supabase Auth** with Google OAuth and email/password sign-in. Local development runs the full Supabase stack (PostgreSQL, Auth, Studio) in Docker via the Supabase CLI — see [local-dev.md](./local-dev.md).

```
Browser
  │
  ▼
Next.js App Router (Server Components + Client Components)
  │
  ├── Server Actions ──► Services ──► Repos ──► Prisma ──► PostgreSQL (Supabase)
  │
  ├── API Routes ──► Direct Prisma queries / external APIs
  │
  └── Auth ──► Supabase Auth (SSR cookies)
```

## Monorepo layout

```
lsr-monorepo/
├── apps/platform/       # The web application (Next.js)
├── docs/                # Engineering and admin documentation
├── scripts/             # Shared utility scripts
└── .github/             # CI workflows, CODEOWNERS
```

The monorepo uses **pnpm workspaces** with **Turborepo** for task orchestration. Currently there is one app (`@lsr/platform`). The structure supports adding more apps or shared packages in the future.

## Application structure (`apps/platform/`)

```
apps/platform/
├── src/
│   ├── app/             # Next.js App Router (pages, layouts, API routes)
│   ├── components/      # React components
│   ├── lib/             # Utilities and integrations
│   ├── schemas/         # Zod validation schemas
│   └── server/          # Server-side data layer
├── prisma/              # Database schema, migrations, seed scripts
├── public/              # Static assets (images, PDFs)
└── scripts/             # App-specific utility scripts
```

## Routing (`src/app/`)

The app uses file-system routing via the Next.js App Router. Key route groups:

| Route | Purpose |
|---|---|
| `/` | Homepage |
| `/events`, `/events/[slug]` | Event listings and detail pages |
| `/drivers`, `/drivers/[handle]` | Driver directory and profiles |
| `/series/[slug]` | Racing series with standings |
| `/news`, `/news/[slug]` | News articles |
| `/shop`, `/shop/products/[handle]` | Merchandise store |
| `/gallery` | Photo gallery |
| `/sponsors` | Sponsor information |
| `/account` | User account settings |
| `/auth/*` | Sign in, password reset, OAuth callback |
| `/admin/*` | Admin console (events, users, results, seasons, etc.) |
| `/api/*` | API routes (registration, payments, cron, Shopify cart, etc.) |
| `/check-in/[id]` | QR-based event check-in |

## Components (`src/components/`)

Components are organized by feature domain:

- **`admin/`** -- Admin console components (event forms, user management, results ingestion)
- **`home/`** -- Homepage sections (hero, leaderboard, schedule preview, sponsor strip)
- **`drivers/`** -- Driver profile components
- **`events/`** -- Event check-in UI
- **`shop/`** -- E-commerce components (cart, product cards, wishlist)
- **`ui/`** -- shadcn/ui primitives (button, dialog, table, form, etc.)
- Root-level shared components (site header, footer, notification bell, auth dialog, etc.)

The project uses **shadcn/ui** (new-york style) built on Radix UI primitives, styled with **Tailwind CSS v4**.

## Server-side code (`src/server/`)

Server code follows a layered architecture:

```
Server Actions (src/server/actions/)
       │
       ▼
Services (src/server/services/)      ← Business logic
       │
       ▼
Repos (src/server/repos/)            ← CRUD operations
       │
       ▼
Prisma Client                        ← Database access
```

### Layers

**Queries (`queries/`)** -- Read-only data fetching functions wrapped with React `cache()` for request-scoped deduplication. Used directly in Server Components.

**Repos (`repos/`)** -- Repository pattern for entity CRUD. Each repo encapsulates Prisma queries for a domain (events, users, seasons, etc.).

**Services (`services/`)** -- Business logic that coordinates across repos. Key services:
- `registration.service.ts` -- Event registration with database locks (`FOR UPDATE`) and FIFO waitlist promotion
- `attendance.service.ts` -- Check-in workflows (QR and manual)
- `notification.service.ts` -- Notification scheduling and dispatch
- `payment.service.ts` -- Stripe payment processing

**Actions (`actions/`)** -- Next.js Server Actions for mutations. Each action validates auth, calls the service layer, writes an audit log, and calls `revalidatePath`.

**Auth (`auth/`)** -- Session management via `getSessionUser()` and `getCachedSessionUser()`. Authorization guards like `requireAdmin()` check role-based access.

## Utilities (`src/lib/`)

- **Supabase clients** -- `supabase-browser.ts`, `supabase-server.ts`, `supabase-rsc.ts` for different runtime contexts
- **Prisma client** -- `prisma.ts` for database access
- **Roles** -- `roles.ts` defines: `member`, `competition`, `officer`, `president`, `alumni`, `admin`
- **Authorization** -- `authz.ts` with `isAdmin()`, `requireAdmin()` helpers
- **Integrations** -- `shopify/` (product catalog, cart), `stripe.ts` (payments), `email/` (Resend transactional email)
- **Helpers** -- date formatting, slug generation, QR codes, status indicators

## Validation (`src/schemas/`)

Zod schemas for form validation and Server Action input:
- `event.schema.ts` -- Event creation/editing
- `news.schema.ts` -- News post creation
- `result.schema.ts` -- Race result validation

## Database

The database schema is defined in `prisma/schema.prisma`. Key model groups:

- **Identity**: `User`, `UserRole`, `AuditLog`
- **Membership**: `MembershipTier`, `UserMembership`, `Entitlement`, `Payment`
- **Events**: `Event`, `EventSeries`, `Venue`, `EventRegistration`, `EventAttendance`
- **Competition**: `League`, `Season`, `Round`, `Session`, `Entry`, `Result`
- **Content**: `Post`, `Page`, `GalleryImage`, `Media`
- **Notifications**: `Notification`, `NotificationPreference`
- **Race data**: `RawResultUpload`, `RaceSession`, `RaceParticipant`, `RaceResult`, `RaceLap`

Migrations live in `prisma/migrations/`. Apply with `pnpm --filter @lsr/platform db:migrate`.

## External integrations

| Service | Purpose | Config |
|---|---|---|
| **Supabase** | Auth + PostgreSQL database | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `DATABASE_URL` |
| **Stripe** | Payment processing | Webhook at `/api/stripe/webhook` |
| **Shopify** | Merchandise catalog and cart | Storefront API via `src/lib/shopify/` |
| **Cloudinary** | Image hosting | Images referenced via `res.cloudinary.com` |
| **Resend** | Transactional email | Via `src/lib/email/` |
| **Vercel** | Hosting and deployment | Auto-deploys from `main` |

## Key patterns

- **React Server Components by default.** Only use `"use client"` when interactivity is required.
- **Path alias:** `@/*` maps to `./src/*` (relative to `apps/platform/`).
- **Audit logging:** All admin mutations write to the `AuditLog` table with before/after snapshots.
- **JIT user provisioning:** Users are auto-created in Prisma on their first Supabase authentication.
- **Feature flags:** The `FeatureFlag` model enables toggling features without code changes.
