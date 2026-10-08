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
└── .github/             # CI workflows, CODEOWNERS
```

The monorepo uses **pnpm workspaces**. Currently there is one app (`@lsr/platform`), and the root `package.json` scripts just run its scripts with `pnpm --filter`. The structure supports adding more apps or shared packages in the future.

## Application structure (`apps/platform/`)

```
apps/platform/
├── src/
│   ├── app/             # Next.js App Router (pages, layouts, API routes, most Server Actions)
│   ├── components/      # React components
│   ├── lib/             # Utilities and integrations
│   ├── schemas/         # Zod validation schemas
│   └── server/          # Server-side data layer
├── prisma/              # Database schema, migrations, seed scripts
├── public/              # Static assets (images, PDFs)
└── scripts/             # One-off and ops scripts, run with tsx
```

## Routing (`src/app/`)

The app uses file-system routing via the Next.js App Router. Key route groups:

| Route | Purpose |
|---|---|
| `/` | Homepage |
| `/events`, `/events/[slug]` | Event listings and detail pages |
| `/drivers`, `/drivers/[handle]` | Driver directory and profiles |
| `/lone-star-cup` | Lone Star Cup season hub, entry form and rules (`/series/*` redirects here) |
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
- **`home/`** -- Homepage sections (hero, next event, leaderboard, sponsor strip)
- **`drivers/`** -- Driver profile components
- **`events/`** -- Event check-in UI
- **`shop/`** -- E-commerce components (cart, product cards, wishlist)
- **`ui/`** -- shadcn/ui primitives (button, dialog, table, form, etc.)
- Root-level shared components (site header, footer, notification bell, auth dialog, etc.)

The project uses **shadcn/ui** (new-york style) built on Radix UI primitives, styled with **Tailwind CSS v4**.

## Server-side code (`src/server/`)

Server code follows a layered architecture, though simpler actions skip straight to Prisma:

```
Server Actions (src/app/**/actions.ts, src/server/actions/)
       │
       ▼
Services (src/server/services/)      ← Business logic
       │
       ▼
Repos (src/server/repos/)            ← CRUD operations
       │
       ▼
Prisma Client (src/server/db.ts)     ← Database access
```

### Layers

**Queries (`queries/`)** -- Read-only data fetching functions used directly in Server Components. Some are wrapped with React `cache()` for request-scoped deduplication; not all are.

**Repos (`repos/`)** -- Repository pattern for entity CRUD. A few domains have one (events, series, venues, standings, memberships); most code queries Prisma directly.

**Services (`services/`)** -- Business logic that coordinates across repos. Key services:
- `registration.service.ts` -- Event registration with database locks (`FOR UPDATE`) and FIFO waitlist promotion
- `attendance.service.ts` -- Check-in workflows (QR and manual)
- `notification.service.ts` -- Notification scheduling and dispatch
- `payment.service.ts` -- Stripe payment processing (see [payments.md](./payments.md))
- `league-entry.service.ts` -- Lone Star Cup entries

**Actions** -- Next.js Server Actions for mutations. Most are colocated with their route as `src/app/**/actions.ts` (e.g. `src/app/admin/events/actions.ts`); a few shared ones live in `src/server/actions/`. Each action checks auth with a guard, does the work (through a service or repo, or Prisma directly), writes an audit log for admin changes (`audit/log.ts`), and calls `revalidatePath`.

**Auth (`auth/`)** -- Session management via `getSessionUser()` and `getCachedSessionUser()`. Guards in `guards.ts` (`requireUser`, `requireRole`, `requireOfficer`, and `requireOfficerPage` for admin pages) check role-based access. `requireRole` also admits emails in the `ADMIN_EMAILS` allowlist. Every admin page checks access itself, because the admin layout doesn't re-run when a client fetches just the page segment.

**Database (`db.ts`)** -- The shared Prisma client.

## Utilities (`src/lib/`)

- **Supabase client** -- `supabase-browser.ts` for the browser; the server client is created in `server/auth/session.ts` and the auth callback
- **Roles** -- `roles.ts` defines `officer`, `admin`, `lsc_driver` and `collegiate_driver`
- **Public user fields** -- `public-user.ts` (`publicUserSelect`): the only user fields a public page may send to the browser
- **Integrations** -- `shopify/` (product catalog, cart), `stripe.ts` (payments), `email/` (Resend transactional email)
- **Helpers** -- date formatting, slug generation, QR codes, status indicators

## Validation (`src/schemas/`)

Zod schemas for form validation and Server Action input:
- `league-application.schema.ts` -- League entry form
- `news.schema.ts` -- News post creation
- `product.schema.ts` -- Product edits in `/admin/products`

## Database

The database schema is defined in `prisma/schema.prisma`. Key model groups:

- **Identity**: `User`, `Role`, `UserRole`, `AuthIdentity`, `AuditLog`
- **Payments & membership**: `Product`, `Payment`, `Entitlement`, `UserMembership`, `MembershipTier` (see [payments.md](./payments.md))
- **Events**: `Event`, `EventSeries`, `Venue`, `EventRegistration`, `EventAttendance`, `EventEligibility`
- **Competition**: `League`, `Season`, `Entry` (a driver's per-season standings aggregates), `LeagueApplication` (Lone Star Cup entry form)
- **Race data**: `RawResultUpload` → `RaceSession`, `RaceParticipant`, `RaceResult`, `RaceLap`, `RaceEvent`, `ParseReport`; `DriverIdentity` and `CarMapping` map sim driver GUIDs and car names
- **Content**: `Post`, `Page` (editable pages such as the Lone Star Cup rules), `GalleryImage`, `Media`, `Tag`
- **Notifications & settings**: `Notification`, `NotificationPreference`, `SystemSetting`, `FeatureFlag`

Migrations live in `prisma/migrations/`. Apply with `pnpm --filter @lsr/platform db:migrate`.

## External integrations

| Service | Purpose | Config |
|---|---|---|
| **Supabase** | Auth + PostgreSQL database | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `DATABASE_URL` |
| **Stripe** | Payment processing | Webhook at `/api/stripe/webhook`; see [payments.md](./payments.md) |
| **Shopify** | Merchandise catalog and cart | Storefront API via `src/lib/shopify/` |
| **Cloudinary** | Image hosting | Images referenced via `res.cloudinary.com` |
| **Resend** | Transactional email | Via `src/lib/email/` |
| **Vercel** | Hosting and deployment | Auto-deploys from `main` |

## Key patterns

- **React Server Components by default.** Only use `"use client"` when interactivity is required.
- **Path alias:** `@/*` maps to `./src/*` (relative to `apps/platform/`).
- **Audit logging:** Admin mutations write to the `AuditLog` table with before/after snapshots (`createAuditLog` in `src/server/audit/log.ts`).
- **Public user data:** Anything passed to a client component on a public page ends up in the HTML, so public queries select users through `publicUserSelect` (`src/lib/public-user.ts`), never full `User` rows.
- **JIT user provisioning:** Users are auto-created in Prisma on their first Supabase authentication.
