# AGENTS.md — fair.yoga

## Quick start

```bash
docker compose up -d        # PostgreSQL on :5432
cp .env.example .env        # required env vars (DATABASE_URL, PASSKEY_*, etc.)
npm install                 # postinstall runs `prisma generate`
npx prisma migrate dev      # apply migrations to dev DB
EMAIL_DRY_RUN=1 npm run dev # start on :3000; dry-run logs magic links to stdout
```

## Verify commands (CI order matters)

```bash
npm run verify              # typecheck → lint → test (all three must pass)
npm run typecheck           # tsc --noEmit, strict mode, no `any`
npm run lint                # ESLint (next/core-web-vitals + typescript + prettier)
npm test                    # vitest (unit + integration + components)
npm run test:e2e            # Playwright (starts dev server if not running)
```

- Local e2e is serialized (`workers: 1` in `playwright.config.ts`) — every test shares the one dev server on :3000; fan-out once failed four different tests across four parallel runs (#290).
- After editing source, hit each touched route once (`curl` is enough) before trusting a gate run or scoring a mutation — `next dev` compiles lazily per route, so the first requests pay compilation and can blow vitest's 5s default (`vitest.config.ts` sets no `testTimeout`) or Playwright's 5s `expect` budget (`playwright.config.ts` sets no `expect.timeout`). A red right after an edit is a cold route until proven otherwise.

## Test architecture — three Vitest projects

| Project | Files | Environment | DB |
|---|---|---|---|
| unit | `src/**/*.test.ts` | node | `DATABASE_URL_TEST` (auto-created in setup) |
| integration | `tests/integration/**/*.test.ts` | node, hits `:3000` | whatever app reads (dev DB locally) |
| components | `src/components/**.test.tsx`, `src/app/**.test.tsx` | jsdom | none |

- Unit setup (`tests/setup/unit-db.ts`) creates + migrates the test DB before running. It refuses to run against `DATABASE_URL` — set `DATABASE_URL_TEST` in `.env`.
- Components mock `next/navigation` via `tests/setup/components.ts`. Exports `routerRefresh` / `routerPush` for assertions. `fetch` is NOT mocked — stub it per-test with `vi.stubGlobal('fetch', …)` when clicks trigger requests.
- Timezone pinned to `America/New_York` in vitest config to catch UTC-vs-local date bugs. Removing the pin silently makes tests tautological on CI (UTC runner).

## Prisma and migrations

- Always create a migration after editing `prisma/schema.prisma`:
  ```bash
  npx prisma migrate dev --name <description>
  ```
- CI checks schema/migration drift — `schema.prisma` must match migration history.
- `npm run db:seed` wipes and recreates all domain data (emergency reset).

## Build output directories

- Dev writes to `.next/`, production writes to `.next-build/`. This separation prevents stale pages when a `next build` runs while dev server is active. The split is in `next.config.ts` (`distDir`).
- Docker image uses `output: "standalone"` — see `Dockerfile`.

## Auth quirks for testing

- Sessions are DB rows. Cookie: `fair_yoga_session=<raw token>`, row `id` = SHA-256 hex of the token.
- Seed data includes teacher `ivo@fairyoga.dev`. Use Prisma studio (`npm run db:studio`) or craft a session directly to log in without email.
- Helper: `tests/helpers.ts` exports `seedSession(db, accountId)`.

## Service layer principle

Business logic lives in `src/services/` — pure functions, no HTTP/framework imports. API routes under `src/app/api/` are thin wrappers. Test services directly, not through HTTP when possible.

## Playing with the running app

- Dev DB accumulates test data over time. Notification titles are NOT unique — scope mutations by `id`, never by title text.
- SSE connection stays open indefinitely — never use `waitUntil: 'networkidle'` in Playwright scripts; use `waitUntil: 'load'` + explicit locator waits.

## Cron scheduler

In-process job scheduler starts with the server. Set `CRON_SCHEDULER="off"` to disable (useful when an external cron hits `/api/cron/*`). CI always sets it off.

## Design system

- Tokens in `src/app/globals.css` (Tailwind v4 `@theme`, no `tailwind.config`).
- Mobile-first, 640px content column, no motion/transitions.
- Reference docs: `docs/design-brief.md`, vendored system in `docs/design_handoff_fairyoga/`.

## Key references

| File | Purpose |
|---|---|
| `CLAUDE.md` | Stack overview, data model, design philosophy |
| `docs/product-concept.md` | Pricing engine algorithm, class lifecycle |
| `docs/data-model.md` | Full schema with fields, types, relationships |
