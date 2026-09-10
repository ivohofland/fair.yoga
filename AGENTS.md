# AGENTS.md — fair.yoga

## Quick start

```bash
docker compose up -d                     # PostgreSQL on :5432
cp .env.example .env                     # required env vars (DATABASE_URL, PASSKEY_*, etc.)
corepack enable                          # pnpm, via Corepack (ships with Node.js) — once per machine
pnpm install --frozen-lockfile           # postinstall runs `prisma generate`
pnpm exec prisma migrate dev             # apply migrations to dev DB
EMAIL_DRY_RUN=1 pnpm run dev             # start on :3000; dry-run logs magic links to stdout
```

## Verify commands (CI order matters)

```bash
pnpm run verify              # typecheck → lint → test (all three must pass)
pnpm run typecheck           # tsc --noEmit, strict mode, no `any`
pnpm run lint                # ESLint (next/core-web-vitals + typescript + prettier)
pnpm test                    # vitest, every project, in two sequenced passes
pnpm run test:e2e            # Playwright (starts dev server if not running)
```

- Local e2e is serialized (`workers: 1` in `playwright.config.ts`) — every test shares the one dev server on :3000; fan-out once failed four different tests across four parallel runs (#290).
- After editing source, hit each touched route once (`curl` is enough) before trusting a gate run or scoring a mutation — `next dev` compiles lazily per route, so the first requests pay compilation and can blow vitest's 5s default (`vitest.config.ts` sets no `testTimeout`) or Playwright's 5s `expect` budget (`playwright.config.ts` sets no `expect.timeout`). A red right after an edit is a cold route until proven otherwise.

## Test architecture — the Vitest projects

| Project | Files | Environment | DB |
|---|---|---|---|
| unit | `src/**/*.test.ts` minus `SERIAL_TESTS` | node | `DATABASE_URL_TEST` (auto-created in setup) |
| unit-sweeps | `SERIAL_TESTS` (`vitest.tiers.ts`) — database-wide sweeps plus the lock-contention files, serial | node | `DATABASE_URL_TEST` |
| integration | `tests/integration/**/*.test.ts` | node, hits `:3000` | whatever app reads (dev DB locally) |
| components | `src/components/**/*.test.tsx`, `src/app/**/*.test.tsx` | jsdom | none |

- Unit setup (`tests/setup/unit-db.ts`) creates + migrates the test DB before running. It refuses the case where `DATABASE_URL_TEST` *equals* `DATABASE_URL`; absent entirely, it logs and returns, leaving the tier on the dev database — so set `DATABASE_URL_TEST` in `.env`.
- Adding a test that calls a service sweep taking no scope argument? It goes in `SWEEP_TESTS`, not the parallel `unit` pool (`docs/test-database.md` §2).
- Components mock `next/navigation` via `tests/setup/components.ts`. Exports `routerRefresh` / `routerPush` for assertions. `fetch` is NOT mocked — stub it per-test with `vi.stubGlobal('fetch', …)` when clicks trigger requests.
- Timezone pinned to `America/New_York` in vitest config to catch UTC-vs-local date bugs. Removing the pin silently makes tests tautological on CI (UTC runner).

## Prisma and migrations

- Always create a migration after editing `prisma/schema.prisma`:
  ```bash
  pnpm exec prisma migrate dev --name <description>
  ```
- CI checks schema/migration drift — `schema.prisma` must match migration history.
- `pnpm run db:seed` wipes and recreates all domain data (emergency reset).

## Next.js version — check the installed docs, not recall

This repo tracks Next closely, and Next 16 renamed things your training data
still calls by their old names. `middleware.ts` is now `proxy.ts` (here:
`src/proxy.ts`, exporting `proxy`, not `middleware`) — issue #539's own
reachability table concluded "No middleware file exists" by running
`ls src/middleware.ts middleware.ts`, and was wrong about a file that enforces
the signed-out redirect. The rename is documented in the bundled docs — under
`01-app/02-guides/upgrading/` as of Next 16; the directory is the stable part
of that path, the rest will move.

**Version-matched docs ship with the package: `node_modules/next/dist/docs/`.**
Read them before writing framework code, and prefer them over anything you
recall about Next.

`next dev` writes a reminder of its own into this file — silently, with no
prompt — unless declined, and `next.config.ts` sets `agentRules: false` to
decline it. That block's text is Next's to reword, and a file this repo
maintains should not churn on a patch release. This section is the repo-owned
replacement; the pointer above is the part worth keeping.
`src/lib/next-agent-rules.test.ts` fails if the block ever lands here.

## Build output directories

- Dev writes to `.next/`, production writes to `.next-build/`. This separation prevents stale pages when a `next build` runs while dev server is active. The split is in `next.config.ts` (`distDir`).
- Docker image uses `output: "standalone"` — see `Dockerfile`.

## Auth quirks for testing

- Sessions are DB rows. Cookie: `fair_yoga_session=<raw token>`, row `id` = SHA-256 hex of the token.
- Seed data includes teacher `ivo@fairyoga.dev`. Use Prisma studio (`pnpm run db:studio`) or craft a session directly to log in without email.
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

## Mutation testing protocol

"A guard that cannot fail certifies nothing." When executing mutation probes (breaking a guard to watch tests go red, then restoring) or running concurrent review agents:

- **Parallel agents must use isolated worktrees**: Mutating agents sharing a checkout cause false greens and false reds (#178, #282). Use git worktrees or branched agent workspaces, each with its own `node_modules`.
- **Worktree probe recipe**:
  ```bash
  WT_DIR="/tmp/mutation-probe-$$"
  git worktree add -f "$WT_DIR" HEAD
  (cd "$WT_DIR" && pnpm install --frozen-lockfile)   # ~7s on a warm store
  (
    cd "$WT_DIR"
    # <apply mutation to target file>
    git diff <modified-file>
    pnpm exec vitest run --project <tier> <files>
  ) || true
  git worktree remove --force "$WT_DIR"
  ```
  A symlinked `node_modules` is refused, not shared: `pnpm exec` in such a worktree exits 1 with `ERR_PNPM_VERIFY_DEPS_BEFORE_RUN`. `docs/mutation-testing.md` §3 has the mechanism and the timings.
- **Single-agent runs**: Safe in-place because no background non-agent writers exist. Always verify `git diff` before measuring and use `git restore <file>` immediately after measuring.
- Full details & empirical findings: `docs/mutation-testing.md`.

## Key references

| File | Purpose |
|---|---|
| `CLAUDE.md` | Stack overview, data model, design philosophy |
| `docs/product-concept.md` | Pricing engine algorithm, class lifecycle |
| `docs/data-model.md` | Full schema with fields, types, relationships |
| `docs/mutation-testing.md` | Safe mutation testing & worktree isolation protocol |
