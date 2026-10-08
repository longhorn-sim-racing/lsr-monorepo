# Longhorn Sim Racing Platform

The official web platform for [Longhorn Sim Racing](https://www.longhornsimracing.org) at UT Austin. Manages club events, racing competitions, member profiles, news, merchandise, and administration tools.

## Repository structure

```
lsr-monorepo/
├── apps/platform/       # Next.js web application
├── docs/                # Engineering and admin documentation
└── .github/             # CI workflows and repo config
```

## Tech stack

- **Monorepo**: pnpm workspaces
- **Framework**: Next.js 16 (App Router, React Server Components)
- **Language**: TypeScript
- **Styling**: Tailwind CSS v4 + shadcn/ui
- **Database**: PostgreSQL via Supabase
- **ORM**: Prisma
- **Auth**: Supabase Auth
- **Payments**: Stripe
- **Deployment**: Vercel

## Quick start

```bash
# Install pnpm if you don't have it
npm install -g pnpm

# Install dependencies
pnpm install

# Set up environment variables
cp apps/platform/.env.example apps/platform/.env.local
# Fill in values from the local Supabase stack (see docs/local-dev.md)

# Generate Prisma client
pnpm --filter @lsr/platform db:generate

# Start the dev server
pnpm dev
```

The app will be running at **http://localhost:3000**.

## Scripts

From the repo root:

| Command | Description |
|---|---|
| `pnpm dev` | Start the development server |
| `pnpm build` | Production build |
| `pnpm lint` | Run ESLint |

From `apps/platform/`:

| Command | Description |
|---|---|
| `pnpm dev` | Start the development server |
| `pnpm build` | Production build (runs Prisma generate first) |
| `pnpm lint` | Run ESLint |
| `pnpm typecheck` | TypeScript type checking |
| `pnpm db:generate` | Regenerate Prisma client |
| `pnpm db:migrate` | Create and apply a database migration |
| `pnpm db:reset` | Reset and re-seed the database |
| `pnpm set-role <userId> <role>` | Assign a role to a user |

## Documentation

| Document | Description |
|---|---|
| [docs/onboarding.md](docs/onboarding.md) | New engineer onboarding guide |
| [docs/architecture.md](docs/architecture.md) | Platform architecture overview |
| [docs/local-dev.md](docs/local-dev.md) | Local development setup |
| [docs/deployment.md](docs/deployment.md) | CI/CD and deployment process |
| [docs/admin-guide.md](docs/admin-guide.md) | Admin feature usage guide |
| [docs/admin-quick-reference.md](docs/admin-quick-reference.md) | Quick admin task lookup |
| [docs/payments.md](docs/payments.md) | How payments work (Stripe, products, entitlements) |
| [docs/payments-test-checklist.md](docs/payments-test-checklist.md) | Payments test run before merging payment changes |

## Contributing

1. Create a branch from `main`.
2. Make your changes.
3. Open a pull request -- CI will run lint, type checking, and a build automatically.
4. Get approval from the Digital Platforms lead (required via CODEOWNERS).
5. Merge.
