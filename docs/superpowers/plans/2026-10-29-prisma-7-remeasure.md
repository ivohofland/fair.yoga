# Re-measure the Prisma 6.19.3 notes on 7.10.1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every claim in `docs/` and in test comments that is dated to Prisma
6.19.3, or that names a file 7.10.1 no longer ships, is re-measured on 7.10.1
and replaced by what was observed (#925).

**Architecture:** Measurement first, prose second. Each task runs a throwaway
measurement (scratch tree, scratch images, or a script against the test
database), saves the raw output to a report file, and only then rewrites the
claim to match. No product code changes.

**Tech Stack:** Prisma 7.10.1 (client engine, `@prisma/adapter-pg`), Next 16
standalone build, Docker (`node:24-alpine`), pnpm 12, Postgres 16.

**Spec:** none (small change; scope agreed in the #925 session). The issue
and its 2026-10-28 owner comment are the brief: `gh issue view 925 --comments`.

## Global Constraints

- **Never touch the dev server on :3000, the working checkout's
  `node_modules`, or `.next-build`.** Builds and clean installs run in a
  scratch tree: `T=$(mktemp -d) && git archive HEAD | tar -x -C "$T"`.
- **Scratch files live in the session scratchpad**, never in the repo:
  `/private/tmp/claude-501/-Users-ivohofland-Projects-fair-yoga/1a318d7b-70d7-4e4a-b53a-9f9400b517f8/scratchpad`
  (below: `$SP`). Each task saves its raw command output to
  `$SP/task-N-measurements.md`, quoted verbatim.
- **Database measurements use the test database only**
  (`DATABASE_URL_TEST` from `.env`, `ethical_yoga_test`), never `ethical_yoga`.
- **Replace a claim, never annotate it** — no "previously", no "on 6.19.3 this
  was". The before and after go in the task report for the PR body.
- **Every rewritten claim carries its date (2026-10-29), the version (7.10.1)
  and its re-derive command**, the way the surrounding prose already does.
- **Stop condition:** if a measurement shows a behaviour change rather than a
  renamed file or a new version number — the empty-`update` upsert now
  compiles to `INSERT … ON CONFLICT`, a missing engine no longer downloads,
  the probe failure no longer fires — STOP, write the observation in the
  report, and report `BLOCKED`. Do not rewrite the reasoning around it.
- **Do not edit:** `prisma/migrations/**` (applied migrations are immutable,
  comments included); `clientVersion: '6.19.3'` fixture strings in tests
  (arbitrary values, no claim); the historical, past-tense `@prisma/config@6.19.3`
  sentences at `docs/supply-chain.md` ~672 and ~739; the 16,377–16,382 stall
  sentence in `docs/technical-architecture.md` ~398.
- No count or roster in a code comment (CLAUDE.md, *Comment Discipline*).
- Stage exact paths; never `git add -A`/`.`.

## Review Focus

- A recipe edited to the new filename but never run — the reviewer checks the
  report holds that command's literal output.
- `fast` vs `small` query compiler: the doc must name the variant the build
  actually externalises, not both by assumption.
- A dated 6.19.3 measurement silently re-dated to 7.10.1 without being re-run.
- A twin left behind: the same claim stated in `technical-architecture.md`
  and `supply-chain.md` (externals; the `--network none` reason, also named
  in `.github/workflows/ci.yml`'s comment) corrected in only one.
- An edit to a migration file or fixture string.

---

### Task 1: Claims measured against the database

**Files:**
- Modify: `docs/lock-order.md` (~2797–2805, "The empty-`update` upsert quirk")
- Modify: `src/services/invitations-lock-order.test.ts` (docblock ~200–216, comment only)
- Modify: `docs/technical-architecture.md` (~1697–1708, "A raw query's JS `Date` is bound untyped")
- Modify: `src/lib/log-serializers.test.ts:20` (comment only)

**Interfaces:** none produced. Measurement scripts are `$SP/*.ts`, run with
`pnpm exec tsx`, constructing the client through `createPrismaClient` from
`src/lib/prisma-client.ts` (it accepts `log`).

- [ ] **Step 1: Measure the empty-`update` upsert.** Script against the test
  DB with `log: [{ emit: 'event', level: 'query' }]`, printing each query.
  On an existing `TeacherBlock` row (create one in the script, delete it at the
  end), run `upsert({ where, update: {}, create })` and then the same with one
  real column in `update`. Record both query sequences verbatim.
  Expected (unchanged behaviour): the first is plain `SELECT`s only, the second
  contains `INSERT … ON CONFLICT`. Anything else → stop condition.
- [ ] **Step 2: Measure `DEBUG=prisma:query`.** Run the same script's first
  upsert with no `log` option and `DEBUG=prisma:query`; record whether any
  query text is printed.
- [ ] **Step 3: Measure raw `Date` binding.** In one transaction per
  `TimeZone` (`SET LOCAL TimeZone` = `UTC`, `America/New_York`, `Asia/Tokyo`),
  with `const d = new Date('2026-08-15T00:00:00Z')`: `SELECT ${d}::text`,
  `SELECT '2026-08-15'::date > ${d}`, `SELECT ${d}::timestamptz::text`, and
  `SELECT ${d}` with no context (expect `42P18`). Record every result.
- [ ] **Step 4: Measure the production error rendering** that
  `log-serializers.test.ts`'s `VALIDATION_MSG` quotes: with
  `NODE_ENV=production`, call `student.create` with an unknown argument
  `bogus: 1` and record `err.message` exactly. Compare with `VALIDATION_MSG`.
- [ ] **Step 5: Rewrite the four claims** to what was measured — version
  7.10.1, date 2026-10-29. Keep `lock-order.md`'s re-derive `grep` as is.
  If Step 4's message differs from `VALIDATION_MSG`, record the diff in the
  report and change only the comment's version claim if the difference is
  immaterial to what the test asserts; otherwise stop condition.
- [ ] **Step 6: Verify.** `pnpm exec vitest run src/lib/log-serializers.test.ts`
  passes; `pnpm exec vitest run --project integration src/services/invitations-lock-order.test.ts`
  passes; `git grep -n '6\.19' docs/lock-order.md docs/technical-architecture.md src/services/invitations-lock-order.test.ts`
  prints nothing, and in `src/lib/log-serializers.test.ts` only `clientVersion` fixtures remain.
- [ ] **Step 7: Commit** — `docs: re-measure the upsert, raw Date and error-rendering notes on Prisma 7.10.1 (#925)`.

### Task 2: Claims measured from a scratch install and build

**Files:**
- Modify: `docs/supply-chain.md` (~436–445, "Ignored build scripts"; ~859–888, "What the runner carries")
- Modify: `docs/technical-architecture.md` (~1593–1604, the externals paragraph)

- [ ] **Step 1: Clean install with an emptied map** in a scratch tree: set
  `allowBuilds: {}` in its `pnpm-workspace.yaml`, `pnpm install --frozen-lockfile`,
  record the `Ignored build scripts:` line and `node_modules/.modules.yaml`'s
  `ignoredBuilds`. Expected: the same five packages as `allowBuilds`, at their
  current versions. A different set → stop condition.
- [ ] **Step 2: Build** in a fresh scratch tree (normal install, then
  `pnpm exec prisma generate && pnpm run build`). Run every command in
  `supply-chain.md`'s "Re-derive after `pnpm run build`" block, with the
  `find … -name` pattern widened to `'query_compiler*'`, and record each
  output. Also record whether the build log has a `pg-native` or
  `query_compiler` warning, and the Next version.
- [ ] **Step 3: Rewrite** both sections and their re-derive commands to the
  measured filenames (exactly the variant the externals line prints) and to
  "Measured 2026-10-29 … Prisma 7.10.1, Next <version>". Fix
  `technical-architecture.md`'s externals sentence the same way — it is the
  twin.
- [ ] **Step 4: Verify** each edited recipe by re-running it verbatim, as
  edited, against the scratch build; its output must match the prose.
  `git grep -n 'query_compiler_bg' docs/technical-architecture.md` prints nothing.
- [ ] **Step 5: Commit** — `docs: re-measure the ignored-build set and the runner's Prisma externals on 7.10.1 (#925)`.

### Task 3: Claims measured from scratch images

Depends on Task 2: the "no query compiler" mutation deletes the file Task 2
measured as externalised.

**Files:**
- Modify: `docs/supply-chain.md` (~840–857, the `--network none` reason; ~903–921, the probe's two failures)
- Possibly modify: `.github/workflows/ci.yml` comment only, if Step 1's reason changes (it points at the doc; expected unchanged)

- [ ] **Step 1: Network premise.** Build the `migrate` target from the scratch
  tree. Build a scratch Dockerfile `FROM` it that removes the schema engine
  (`/app/node_modules/.pnpm/@prisma+engines@*/node_modules/@prisma/engines/schema-engine-*`
  and `rm -rf /root/.cache/prisma`; confirm the glob matched something). Run
  CI's migrate step (`prisma migrate status` against `203.0.113.1`) on it
  with and without `--network none`. Record both outputs and exit codes.
  Expected: online, it downloads from `binaries.prisma.sh` and still prints
  P1001; offline, it fails without P1001. Different → stop condition.
- [ ] **Step 2: Runner probe failures.** Build the runner from the scratch
  tree. Confirm the plain probe passes under `--network none`
  (`docker run --rm --network none -i --entrypoint node <img> - < scripts/prisma-client-probe.cjs`).
  Then two scratch images `FROM` it: one removing `/app/node_modules/.pnpm/pg@<version>`,
  one `find /app -name '<the wasm-base64 file Task 2 measured>' -delete`
  (confirm it deleted something). Record each probe output and exit code.
- [ ] **Step 3: Rewrite** both passages to the measured outputs, dated
  2026-10-29, `node:24-alpine`, arm64, Prisma 7.10.1, with the mutation
  recipe naming the real file.
- [ ] **Step 4: Verify** `git grep -n -E '6\.19|query_compiler_bg' docs/supply-chain.md`
  prints only the two historical `@prisma/config@6.19.3` lines; remove the
  scratch images (`docker image rm` by the tags the task created).
- [ ] **Step 5: Commit** — `docs: re-measure the network-none premise and the runner probe's failures on 7.10.1 (#925)`.
