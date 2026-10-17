# `prisma-client` generator with an explicit output (#888)

Part of the Prisma 6 → 7 upgrade (#889). Still on Prisma 6.19.3. No runtime
behaviour changes: the same engine (`library`), the same queries, the same
error classes. What changes is where the generated client lives, how it is
bundled, and what each image has to carry for it.

## What was measured (premise check)

Every finding below comes from switching the generator in this worktree and
running the runtime in question — `tsc`, `tsx`, vitest, `next build` plus the
standalone server, and both Docker targets — not from the Prisma docs.

1. **Holds:** the generator block is the only schema change, and
   `src/lib/prisma-client.ts` is the only module that has to repoint at the
   output for TypeScript: with `provider = "prisma-client"` and
   `output = "../src/generated/prisma"`, `pnpm run typecheck` is clean with no
   other edit. The output is 19 MB, almost all of it the engine
   (`libquery_engine-<platform>.node`) copied in beside the `.ts` files, and is
   gitignored.
2. **Correction: "the only source change" does not hold — one shared module
   needs a second, enums-only entry point.** `src/lib/schemas.ts` is imported
   by client components (the login, verify, signup, class and settings
   forms among them) and value-imports five enums from
   `@/lib/prisma-client`. Under `prisma-client-js` that worked because the
   package's `browser` field swapped in `index-browser.js` for the client
   bundle. The generated output has no such switch, so `next build` panics:
   `Failed to write app endpoint /(public)/login/page … the chunking context
   (unknown) does not support external modules (request: node:module)`.
   The generated `enums.ts` imports nothing, so a second funnel that
   re-exports only it (`src/lib/prisma-enums.ts`) fixes the build. On the
   server both funnels hand back the same `enums.ts` module, so the enum
   objects stay one identity. The generated `browser.ts` was rejected: it also
   exports a browser `Prisma` namespace whose `Decimal` is a different class
   from the server's, which would split `instanceof` for any shared code that
   ever used it.
3. **Decision: `moduleFormat = "cjs"`, `runtime = "nodejs"`, both written
   out.** The package is not `"type": "module"`. The default ESM output
   begins `globalThis['__dirname'] = path.dirname(fileURLToPath(import.meta.url))`,
   a process-wide global pointing at `src/generated/prisma` for every other
   module in the process; the `cjs` output uses the module's own `__dirname`
   instead. Measured with `cjs` on all four runtimes: `tsx` (`db:seed`
   and a scratch script — engine loads, P1001 on an unreachable host,
   `instanceof Prisma.PrismaClientInitializationError` true), vitest, `next
   dev`, and `next build` plus the standalone server (`/api/health` →
   `{"status":"ok","db":"up"}`, which runs a model query). ESM was not
   measured failing; it was not chosen, for the global.
4. **Holds, and better than expected: standalone tracing carries the
   engine.** Turbopack rewrites the generated `__dirname` to its
   `/ROOT/src/generated/prisma` placeholder and keeps the generator's literal
   `path.join(__dirname, "libquery_engine-…")` hint, so `next build` traces
   the `.node` file to `.next-build/standalone/src/generated/prisma/`. No
   `outputFileTracingIncludes` is needed. The `export *` warning #886 noted
   (`[externals]/@prisma/client` re-exports a CommonJS module) is gone: the
   generated client is bundled, and only `@prisma/client/runtime/library`
   stays an external.
5. **Correction: the runner-image engine probe cannot survive in its current
   shape.** `scripts/prisma-engine-probe.cjs` does
   `createRequire('/app/')('@prisma/client')`. In the new runner image that
   fails with `Cannot find module '@prisma/client'` — the package is
   present only under `.pnpm` as the runtime the bundle's external resolves
   to, with no top-level link, and in any fresh install its
   `default.js` requires a `.prisma/client` that this generator never writes.
   The generated client exists in the runner only inside Turbopack chunks, so
   nothing outside the bundle can construct it. The probe therefore has to
   start the real `server.js` (`--network none`, `DATABASE_URL` at RFC 5737
   `203.0.113.1`), request `/api/health`, and read the server's own log.
   Measured: with the engine present the logged error is
   ``Can't reach database server at `203.0.113.1:5432` `` (P1001's text);
   with the `.node` file `rm`'d from a scratch image it is `Prisma Client
   could not locate the Query Engine for runtime "linux-musl-arm64-openssl-3.0.x"`.
   That probe tests strictly more than the old one did: it proves the
   *bundle* finds its engine, where the old one proved only that a package
   copy beside the bundle could.
6. **Observation, pre-existing, not this change:** the health route's logged
   `PrismaClientInitializationError` carries no `code`. The serializer takes
   `code` from `err.errorCode`, and a lazy-connect `$queryRaw` failure leaves
   that unset — measured identically on an image built from `origin/main`
   (7ec3c799). So the probe matches P1001's message, not a code. This belongs
   with #885, which revisits the P-codes and the serializer; noted there.
7. **Holds:** the migrate image needs nothing beyond an explicit generate.
   It is built `FROM deps`, whose `pnpm install` runs the `postinstall`
   (`prisma generate`) with `prisma/` present, so `/app/src/generated/prisma`
   already exists there and its `.ts` runs under `tsx`. Both existing CI
   checks pass unchanged on the new image (`migrate status` → P1001 plus
   `Loaded Prisma config`; `check-reserved-slugs.ts` → P1001, exit 1). An
   explicit `RUN pnpm exec prisma generate` in the stage removes the reliance
   on the `postinstall` having run, the way the build stage already does.
8. **Holds:** `instanceof` against `Prisma.*` error classes still sees the
   classes the client throws, because the generated `Prisma` namespace
   re-exports `@prisma/client/runtime/library`'s classes and the client
   throws those. `Prisma.Decimal` likewise. The integration suite's 409/503
   mappings (`api-errors.ts`, `exclusion-conflict.ts`) are the behavioural
   proof, and `log-serializers.ts` is exercised by its unit tests.
9. **Correction: the vitest seams fail closed, which is the proof they
   bite.** With the factory repointed but `vi.mock('@prisma/client')` left
   alone, `tests/undefined-filter-guard.test.ts` goes red on three installer
   cases (the mock no longer reaches the class the factory constructs), and
   `prisma-client.test.ts`'s import pin goes red. Both seams move to the
   generated module.
10. **`.dockerignore` needs `src/generated`.** The build stage's `COPY . .`
    would otherwise carry a developer's local output (a darwin engine) into
    the context. The stage regenerates anyway; the ignore keeps the context
    honest and 19 MB smaller.
11. **The generated client does not load `.env`.** `prisma-client-js` called
    `tryLoadEnvs`; the generated client reads `DATABASE_URL` from the
    environment only. Measured: `env -u DATABASE_URL pnpm exec tsx
    scripts/check-reserved-slugs.ts` answered `P1012 Environment variable not
    found: DATABASE_URL`, where main reached the database. Fix: the three
    `tsx` scripts that construct a client import `dotenv/config` first.

## Design

- `prisma/schema.prisma`: `provider = "prisma-client"`, `output =
  "../src/generated/prisma"`, `moduleFormat = "cjs"`, `runtime = "nodejs"`.
- `scripts/admin-grant.ts`, `scripts/check-reserved-slugs.ts` and
  `scripts/measure-push-fanout.ts` import `dotenv/config` first.
- `src/lib/prisma-client.ts` imports `../generated/prisma/client` (relative,
  because the migrate image copies this file without a `tsconfig.json` to
  resolve `@/`).
- `src/lib/prisma-enums.ts` re-exports `../generated/prisma/enums` and nothing
  else; `schemas.ts` takes its enums from there.
- Lint: `@prisma/client` refused everywhere; the generated output refused
  everywhere except the two funnels; `src/generated/**` globally ignored.
- `prisma-client.test.ts` pins each funnel to its one specifier and asserts
  the two funnels hand back the same enum object.
- The vitest mock and its `doUnmock` name the generated client module.
- Dockerfile migrate stage: explicit generate. `.gitignore`, `.dockerignore`.
- `scripts/prisma-engine-probe.cjs` boots `server.js` and asserts on the log;
  its CI success line is unchanged so the step's `grep` is too.
- Docs: `technical-architecture.md` "Where Prisma comes from" (two funnels,
  why, the panic text a future client-reachable import produces),
  `supply-chain.md` "Prisma's engine in the images" (what the runner probe now
  proves, the re-derivation), the `verify` skill's scratch-script recipe (a
  scratch script reaches the database through `src/lib/prisma-client` under
  `tsx`, since the package no longer carries a client).

## Not in scope

- The driver adapter, `engineType = "client"` and the SQLSTATE matching
  (#885). The probe will need revisiting there, as #889 already says.
- `pnpm-workspace.yaml`'s `'@prisma/client': true` build permission. The
  package's own postinstall now generates into the same output as the root
  `postinstall`; redundant, harmless, and gone with v7.
- The missing `code` on a lazy-connect initialization error (item 6).
