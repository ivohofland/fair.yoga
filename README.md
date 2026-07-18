<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/design_handoff_fairyoga/assets/logo-reversed-outline.svg">
  <img src="docs/design_handoff_fairyoga/assets/logo-outline.svg" alt="fair.yoga" width="220">
</picture>

A free, open-source toolkit for independent yoga teachers. Handles scheduling, income-based pricing, simple CRM, payments, and communication. Not a marketplace — a utility.

## Prerequisites

- [Node.js](https://nodejs.org/) 22+ (LTS recommended)
- [Docker](https://www.docker.com/) and Docker Compose
- npm (comes with Node.js)

## Setup

### 1. Clone and install

```bash
git clone <repo-url>
cd fair.yoga
npm install
```

### 2. Environment variables

```bash
cp .env.example .env
```

The defaults work for local development. The `MAGIC_LINK_SECRET` can be any string — set it to something like `dev-secret`. Email sending is disabled in dev mode (magic link URLs are logged to the console instead).

### 3. Start the database

```bash
docker compose up -d
```

This starts PostgreSQL 16 on `localhost:5432`. Data persists across restarts via a named Docker volume.

### 4. Run migrations and seed

```bash
npx prisma migrate dev
npm run db:seed
```

The seed script creates test data: 2 teachers, 10 students across 5 income tiers, rooms, classes in every lifecycle state, registrations, payments, and notifications.

### 5. Start the dev server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Go to `/login` and enter `ivo@fairyoga.dev` (seed teacher). The magic link URL will be printed in your terminal — copy the `/verify?token=...` URL and open it in your browser.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start Next.js dev server |
| `npm run build` | Production build |
| `npm run lint` | Run ESLint |
| `npm test` | Run all tests (Vitest) |
| `npm run test:watch` | Run tests in watch mode |
| `npm run test:coverage` | Run tests with coverage report |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:seed` | Run seed script |
| `npm run db:studio` | Open Prisma Studio (database GUI) |
| `npm run db:reset` | Drop all tables, re-migrate, re-seed |

## Project structure

```
src/
  app/              Next.js App Router (pages and API routes)
    (public)/       Public pages: login, verify, teacher booking page
    (teacher)/      Teacher dashboard: schedule, class detail, student detail
    (student)/      Student pages (Phase 5)
    api/            39 API endpoints
  services/         Business logic (pricing, class lifecycle, waitlist, payments, notifications)
  lib/              Utilities (auth, database, email, validation schemas)
  components/       React components (ui, layout, schedule, class, students)
prisma/
  schema.prisma     Database schema (16 models)
  seed.ts           Test data
  migrations/       SQL migrations
tests/
  integration/      API and flow integration tests
  e2e/              Playwright end-to-end tests (Phase 6+)
docs/               Product specs, design brief, architecture docs
```

## Testing

Tests run against the real PostgreSQL database (no mocks). The database must be running and migrations applied before tests will work:

```bash
docker compose up -d    # start PostgreSQL
npx prisma migrate dev  # apply migrations (first time only)
npm test                # run all tests
```

Tests create their own data (with unique timestamps to avoid conflicts) and clean up after themselves. The seed data is not required for tests to pass, but is useful for manual testing.

To reset everything to a clean state:

```bash
npm run db:reset
```

## Seed accounts

| Role | Email | Notes |
|------|-------|-------|
| Teacher | `ivo@fairyoga.dev` | EUR, Amsterdam, 2 rooms, classes in all lifecycle states |
| Teacher | `sarah@fairyoga.dev` | GBP, London, 1 room |
| Students | `anna@example.com` through `jan@example.com` | 10 students, tiers 1-5 (2 per tier) |

## License

fair.yoga is free software, licensed under the [GNU AGPL-3.0](LICENSE). You may use, study, modify, and share it; if you run a modified version as a service, you must offer its source to your users.
