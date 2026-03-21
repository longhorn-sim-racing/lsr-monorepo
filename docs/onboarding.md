# Onboarding Guide

Welcome to the Longhorn Sim Racing Digital Platforms team. This guide will help you get oriented in the codebase and start contributing.

## What is this repository?

This is the **LSR Platform** monorepo. It powers the Longhorn Sim Racing website and internal tools for UT Austin's sim racing club. The platform handles:

- Club events (creation, registration, attendance/check-in)
- Racing competitions (leagues, seasons, standings, result ingestion)
- Member profiles and driver pages
- News and content publishing
- Merchandise shop (Shopify integration)
- Notifications (in-app and email)
- Administration tools for officers

## Repository structure

```
lsr-monorepo/
├── apps/
│   └── platform/          # Main Next.js web application
├── docs/                  # Engineering and admin documentation
├── scripts/               # Shared utility scripts
├── .github/               # CI workflows and repo config (CODEOWNERS)
├── package.json           # Root workspace config
├── pnpm-workspace.yaml    # pnpm workspace definition
├── turbo.json             # Turborepo task config
└── CLAUDE.md              # AI development guidance
```

The main application lives in **`apps/platform/`**. This is where you will spend most of your time.

## Prerequisites

- **Node.js** 20+
- **pnpm** 10+ (`npm install -g pnpm`)
- **Git**
- **Docker Desktop** ([download](https://www.docker.com/products/docker-desktop/)) — runs the local Supabase stack
- A code editor (WebStorm or VS Code recommended)

## Getting started

```bash
# 1. Clone the repository
git clone https://github.com/longhorn-sim-racing/lsr-monorepo.git
cd lsr-monorepo

# 2. Install dependencies
pnpm install

# 3. Start local Supabase (make sure Docker Desktop is running)
cd apps/platform
npx supabase start

# 4. Set up environment variables
cp .env.example .env.local
# Fill in values from `npx supabase status -o env` (see local-dev.md for details)
# Also create .env with DATABASE_URL and DIRECT_URL for Prisma

# 5. Apply migrations and seed the database
pnpm db:migrate
pnpm db:reset

# 6. Generate the Prisma client
pnpm db:generate

# 7. Start the dev server (from repo root)
cd ../..
pnpm dev
```

The app will be available at **http://localhost:3000**.

For detailed local development instructions, see [local-dev.md](./local-dev.md).

## Project tracking

We use [GitHub Projects](https://github.com/orgs/longhorn-sim-racing/projects/1) to track all work. The board has columns for **Backlog**, **Todo**, **In Progress**, **Blocked**, and **Done**. Issues auto-move through the board as PRs are opened, reviewed, and merged.

- Browse the board to see what's available
- Issues labeled `good first issue` are great starting points for new contributors
- Filter by labels (`payments`, `notifications`, `racing`, `ui/ux`, `admin`, `infrastructure`) to find work by area

## Branch workflow

1. Create a feature branch from `main`:
   ```bash
   git checkout -b your-feature-name
   ```
2. Make your changes and commit with clear messages.
3. Push your branch and open a pull request against `main`.
4. CI will automatically run lint, type checking, and a production build.
5. The PR requires review from the Digital Platforms lead (configured via CODEOWNERS).
6. Once approved and CI passes, merge into `main`.

## Working with GitHub Issues

We track tasks and bugs as [GitHub Issues](https://github.com/longhorn-sim-racing/lsr-monorepo/issues). When working on an issue:

1. **Find an issue** — Browse open issues. Issues labeled `good first issue` are great starting points. Assign yourself (or ask to be assigned) so others know it's taken.
2. **Create a branch** — Name it with the issue number as a prefix:
   ```bash
   git checkout -b 24-fix-officer-images
   ```
3. **Do the work** — Make your changes, committing as you go. Reference the issue in commit messages:
   ```bash
   git commit -m "Fix officer image placeholders (#24)"
   ```
4. **Open a Pull Request** — Push your branch and open a PR against `main`. Include `Closes #24` in the PR description to auto-close the issue when merged.
5. **Code review & merge** — Same review process as the branch workflow above.

### Tips
- Comment on an issue if you have questions or want to share progress.
- If you discover something new while working, open a new issue for it rather than scope-creeping your current PR.
- Keep PRs focused — one issue per PR when possible.

## How CI works

The CI pipeline (`.github/workflows/ci.yml`) runs on every push to `main` and on all pull requests. It runs three checks:

1. **Lint** -- ESLint across the platform app
2. **Type check** -- `tsc --noEmit` for TypeScript correctness
3. **Build** -- Full production build to catch runtime issues

All three must pass before a PR can be merged. See [deployment.md](./deployment.md) for more on the deployment process.

## Key documentation

| Document | Purpose |
|---|---|
| [architecture.md](./architecture.md) | How the platform is structured |
| [local-dev.md](./local-dev.md) | Running the app locally |
| [deployment.md](./deployment.md) | CI/CD and deployment process |
| [admin-guide.md](./admin-guide.md) | Admin feature usage guide |
| [admin-quick-reference.md](./admin-quick-reference.md) | Quick admin task lookup |
| [CLAUDE.md](../CLAUDE.md) | AI development context and conventions |

## Getting help

- Ask the team lead for any third-party credentials you need (Cloudinary, Shopify, Stripe, Resend).
- Check existing docs before asking questions -- most workflows are documented.
- If something is missing from the docs, add it as part of your PR.
