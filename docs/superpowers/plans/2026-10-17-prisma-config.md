# Plan: `prisma.config.ts` and explicit env loading (#887)

Spec: `docs/superpowers/specs/2026-10-17-prisma-config-design.md`. Read it
first. Its "What was measured" section explains why the config shape looks the
way it does.

Two tasks, in this order. Task 2's image COPY needs the file Task 1 creates.

Environment: Node 24 (`export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH`).
The worktree is already installed and set up. Run `pnpm run worktree:up`
before any integration run, and never touch the dev server on :3000.

## Task 1: the config file, its CLI tests, and the `package.json` key

Files: `prisma.config.ts` (new, repo root), `package.json`, and one new test
file.

1. **Write the failing tests first.** Put them in a new test file at the repo
   root or under `src/lib/`. Pick the vitest project whose `include` actually
   collects it and whose environment allows spawning processes: read
   `vitest.config.ts`, and look at `src/lib/script-install-census.test.ts` and
   `deploy/compose.test.ts` as neighbours. The tests drive the real Prisma CLI
   (`node_modules/.bin/prisma`) in a temp directory that holds:
   - a copy of `prisma.config.ts`
   - a copy of `prisma/schema.prisma` (no migrations needed)
   - a symlink `node_modules` → the repo's `node_modules`

   Spawn with the parent env minus `DATABASE_URL` and `DATABASE_URL_TEST`
   (vitest sets them), and with `cwd` set to the temp dir.
   - **(a) `.env` alone supplies the URL.** Write
     `DATABASE_URL="postgresql://u:p@203.0.113.1:5432/none?connect_timeout=3"`
     to the temp `.env` and run `prisma migrate status`. It exits non-zero.
     Assert the output contains `P1001` and `203.0.113.1`, and does not contain
     `P1012`.
   - **(b) No `.env` and no variable: `generate` still works.** Run
     `prisma generate` in a temp dir with no `.env` and assert exit 0. It must
     not overwrite the repo's generated client. Give the temp schema copy a
     generator `output` that points inside the temp dir, and say in the test
     why.
   - **(c) Static.** Root `package.json` has no `prisma` key. The config's
     default export has `migrations.seed === 'pnpm exec tsx prisma/seed.ts'`
     and `schema === 'prisma/schema.prisma'`. Importing the config runs
     `dotenv/config`, so either mock `dotenv/config` for this import or read
     the values another way. Do not let the test leak `.env` into the worker's
     env.

   Run them and record the RED output.
2. **Implement.** Create `prisma.config.ts` exactly as the spec's Design
   section gives it. Keep the header comment short: why `dotenv/config`, and
   why the URL is conditional (`generate` runs as `postinstall` before `.env`
   exists, and `env()` would throw there). Remove the `"prisma"` key from
   `package.json`.
3. **GREEN.** Then prove each guard bites, and record the exact error text of
   each mutation:
   - delete the `import 'dotenv/config'` line → (a) fails
   - replace the ternary with `datasource: { url: env('DATABASE_URL') }` plus
     `engine: 'classic'` → (b) fails
   - re-add the `package.json` key → (c) fails

   Restore after each mutation and re-run.
4. **Real entry points, by hand, in this worktree:**
   - `pnpm exec prisma validate` with `DATABASE_URL` unset in the shell
   - `pnpm exec prisma migrate dev`: creates the worktree dev DB if needed;
     must apply with no new migration
   - `pnpm exec prisma db seed`: must run the seed from the config
   - `pnpm exec prisma generate`
   - `mv .env .env.bak && pnpm exec prisma generate; mv .env.bak .env`

   Paste the relevant output lines into the report.
5. `pnpm run typecheck` and `pnpm run lint` are clean.
6. Commit: `chore: prisma.config.ts loads .env explicitly and replaces package.json#prisma (#887)`.

## Task 2: the migrate image, its CI guard, and the docs

Files: `Dockerfile`, `.github/workflows/ci.yml`, `docs/technical-architecture.md`,
`DEPLOYMENT.md`.

1. **`Dockerfile` migrate stage:** add `COPY prisma.config.ts ./`, with one
   short comment line on why the image needs it (the CLI's config, which
   loads env). Do not add it to `deps`; the spec gives the reason.
2. **CI guard:** in `docker-build`, the step "Prisma schema engine loads in
   the migration image" also asserts
   `grep -q 'Loaded Prisma config from prisma.config.ts'` on the same `$OUT`,
   with its own `::error::` message. Extend the step's existing comment, and
   keep it about what this step checks.
3. **Prove the guard bites locally (Docker is available):**
   - `docker build --target migrate -t fairyoga-migrate-887 .`, then run the
     step's exact command against it and show that both assertions pass.
   - Remove the COPY, rebuild, re-run: the config assertion must fail while
     P1001 still passes. That second result is the spec's point 4.
   - Record both outputs, restore, then remove the test image.
4. **Docs.**
   - `docs/technical-architecture.md`, in "Where Prisma comes from": a
     paragraph on how the CLI gets its config and URL. State only what is
     true now.
   - `DEPLOYMENT.md` §6: one short paragraph saying the migrate image carries
     `prisma.config.ts` and takes `DATABASE_URL` from compose, with no
     `.env`. The `Loaded Prisma config` line in the migrate output is how to
     tell the file was loaded.

   No counts or rosters (CLAUDE.md, Comment Discipline).
5. `pnpm run verify` (needs `pnpm run worktree:up`). Report the result with
   its file/test counts.
6. Commit: `build: the migrate image carries prisma.config.ts, and CI checks it loads (#887)`,
   with the docs in the same commit or a separate `docs:` commit.

## After both tasks

Whole-branch review → one fix wave → scoped re-review → push and open the PR →
CI → `/pr-review-toolkit:review-pr` → rebase-merge → read the `deploy` job log
for `Loaded Prisma config from prisma.config.ts` and a successful migrate
deploy → note it on the PR → verify that #887 is closed.
