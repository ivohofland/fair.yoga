# `prisma.config.ts` and explicit env loading (#887)

Part of the Prisma 6 → 7 upgrade (#889). Still on Prisma 6.19.3. No runtime
behaviour changes: the app's `PrismaClient` reads its URL exactly as before.
What changes is how the **CLI** gets its configuration and its environment.

## What was measured (premise check)

Each finding comes from running the CLI in this worktree, with `DATABASE_URL`
unset in the shell and the worktree's `.env` present or moved away.

1. **Holds:** v6.19.3 accepts `prisma.config.ts` with `schema`,
   `migrations.path`, `migrations.seed`, and a datasource URL. On v6 the URL
   override is typed `engine: 'classic', datasource: { url }`
   (`@prisma/config` 6.19.3 `index.d.ts`, `SchemaEngineConfigClassic`). The
   CLI already warns that `package.json#prisma` is deprecated.
2. **Correction: the config file and explicit env loading are a single step on v6,
   not two.** Once `prisma.config.ts` exists, the v6 CLI prints
   `Prisma config detected, skipping environment variable loading.` and
   `prisma validate` fails with `.env` present. So adding the file already
   gives the v7 env behaviour, and the env loading has to land in the same
   commit.
3. **Correction: `env('DATABASE_URL')` (the helper from `prisma/config`) cannot be
   used.** It throws while the config loads
   (`PrismaConfigEnvError: Missing required environment variable`), and every
   command loads the config, `prisma generate` included. `generate` is the
   `postinstall`, and it runs before any `.env` exists in three real paths:
   the README's fresh clone (`pnpm install` at line 24, `cp .env.example .env`
   at line 30), a fresh worktree (install first, then `worktree:setup` writes
   `.env`), and the Dockerfile `deps` stage. `generate` itself needs no URL.
4. **Correction: neither CI nor a production deploy would notice the config
   missing from the migrate image on v6.** With no config file the v6 CLI
   uses the schema's `url = env("DATABASE_URL")`, and compose supplies
   `DATABASE_URL`, so `migrate deploy` still succeeds. A green deploy proves
   that the config's imports resolve **if** the file is there. It does not
   prove the file is there. The CLI prints
   `Loaded Prisma config from prisma.config.ts.` when it loads the file, and
   that line is the signal to assert on.
5. **Correction: neither doc "describes how the CLI gets its URL" today**
   (`git grep` of `docs/technical-architecture.md` and `DEPLOYMENT.md` for
   `.env`/`DATABASE_URL`/`seed` prose about the CLI: no hits). So the docs
   change adds that text. It does not replace any.
6. **Holds: every other entry point already sets the variable explicitly.**
   - Every CI job that installs or runs the CLI (`checks`, `test-components`,
     `test-unit`, `test-integration`, `test-integration-e2e`, and
     `e2e-flake-repro.yml`) sets `DATABASE_URL` at job level.
   - `src/lib/db-provision.ts`, the worktree/test-DB provisioner, passes
     `DATABASE_URL` in `execSync`'s `env`.
   - dotenv never overrides a variable that is already set. Measured: an
     explicit `DATABASE_URL=…203.0.113.1…` beat the `.env` value, so a
     provisioned test DB still wins over `.env`.
   - The worktree scripts call the CLI only through `db-provision`.

## Design

### `prisma.config.ts` (repo root)

```ts
import 'dotenv/config';
import { defineConfig } from 'prisma/config';

const url = process.env.DATABASE_URL;
const paths = {
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations', seed: 'pnpm exec tsx prisma/seed.ts' },
};

export default defineConfig(url === undefined ? paths : { ...paths, engine: 'classic', datasource: { url } });
```

- **`dotenv/config` instead of `process.loadEnvFile`.**
  - `dotenv` is already a devDependency (`playwright.config.ts` uses it), and
    the migrate image's `deps` stage installs devDependencies.
  - A missing `.env` is a silent no-op. That is correct in the production
    migrate container, where compose supplies the env and `.dockerignore`
    keeps `.env` out of the image. It is also correct in CI and before the
    README's `cp`.
  - `process.loadEnvFile` throws `ENOENT` in all three of those places, so it
    would need a try/catch that filters by error code.
  - Neither option overrides a variable that is already set.
- **The URL override is conditional, and no URL is made up.** With
  `DATABASE_URL` unset, the config adds no datasource and the v6 CLI falls
  back to the schema's own `env("DATABASE_URL")`. That fails clearly
  (`P1012 Environment variable not found: DATABASE_URL`) for the commands
  that need a URL, and `generate` still runs. A conditional spread
  (`...(url ? {engine, datasource} : {})`) does not typecheck, because the
  union widens `engine` to optional (TS2345). A ternary between two whole
  objects does typecheck. A `?? ''` fallback would make up a URL, so it is
  not used.
- **The v7 step will need:** drop `engine: 'classic'`. The schema's `url`
  goes too, and with it the fallback, so the v7 bump has to decide how a
  missing URL fails. That decision belongs to that step, not this one.
- `package.json` loses its `prisma` key.

### Migrate image

- The `migrate` stage gains `COPY prisma.config.ts ./`. Its imports (`dotenv`,
  `prisma/config`) are already in the `deps` stage's `node_modules`.
- The `deps` stage does not copy it. That stage's `postinstall` generate runs
  without a config, as it does today.
- The `build` stage's `COPY . .` already includes the file.

### Guard that bites on v6

The `docker-build` CI job's step "Prisma schema engine loads in the migration
image" also asserts `Loaded Prisma config from prisma.config.ts` in its output.
Prove it: build the migrate image without the `COPY`, run the step's command,
check the assertion fails, then restore.

### Tests (test-first)

A test that drives the real CLI the way a fresh clone would:

- **(a) URL from `.env` alone.** In a temp dir holding a copy of
  `prisma.config.ts`, the schema, a `node_modules` symlink, and a `.env` with a
  reserved-address `DATABASE_URL` (`203.0.113.1`, RFC 5737), run
  `prisma migrate status` with `DATABASE_URL` removed from the child env.
  Assert the output names that host (`P1001` at `203.0.113.1`).
  - Mutation: delete the `dotenv/config` import → `P1012`.
- **(b) No `.env` and no variable.** `prisma generate` exits 0.
  - Mutation: switch to `env('DATABASE_URL')` → `PrismaConfigEnvError`.
  - Use `generate --no-engine`, or any form that doesn't overwrite the real
    generated client, if one exists. Otherwise point it at the temp copy.
- **(c) `package.json` has no `prisma` key, and the config's `migrations.seed`
  is the seed command.**

### Docs

- `docs/technical-architecture.md`, in the Prisma section: how the CLI gets
  its config and URL (`prisma.config.ts`, which loads `.env` through
  `dotenv/config`; an explicit env wins), and why there is no `env()` helper.
- `DEPLOYMENT.md` §6: the migrate image carries `prisma.config.ts`, gets
  `DATABASE_URL` from compose and has no `.env`. How to spot a missing config
  file (the `Loaded Prisma config` line).

### Production proof

Auto-deploy (CI `deploy` job on `main`) runs `docker compose run --rm migrate`.
After the merge, read that job's log for `Loaded Prisma config from
prisma.config.ts` followed by a successful `migrate deploy`. Note the result on
the PR.
