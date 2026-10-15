# One factory for every PrismaClient (#884) — design

Prisma 7 makes a driver adapter mandatory and drops the `datasources` /
`datasourceUrl` constructor options. Today the codebase constructs clients
directly in hundreds of places; this change routes every construction through
one factory while still on Prisma 6, so the v7 adapter change later touches
one file. Parent: #889. #885 (the engine probe) is unaffected.

## 1. The premise, measured

Measured on `origin/main` at `479f3525`, `docs/` excluded throughout.

| Measure | Command | Result |
|---|---|---|
| Loose matches, as the issue counted | `git grep -o 'new PrismaClient' -- ':!docs' \| wc -l` | 337 |
| …of which error classes, not clients | `git grep -oE 'new PrismaClient[A-Z][A-Za-z]*' -- ':!docs' \| wc -l` | 2 (`log-serializers.test.ts`, `PrismaClientUnknownRequestError`) |
| Client constructions | `git grep -oP 'new PrismaClient(?![A-Za-z])' -- ':!docs' \| wc -l` | 335 |
| …inside comments | same, lines starting `//`, `*` or `/*` | 3 |
| …in code | 335 − 3 | **332, in 218 files** |

So the issue's "~330 calls in 221 files" holds for the call count but not the
file count: 221 − 218 = 3 files its loose grep matches with no construction in
code — `log-serializers.test.ts` (error classes only; the issue itself notes it
is not a client) and two files whose only match is a comment,
`src/services/gdpr.ts` and `src/lib/scheduler.test.ts`. The third comment line
(`invitations-lock-order.test.ts`) sits in a file that also constructs. Of the 332, one is `scripts/prisma-engine-probe.cjs`, out of scope.
That leaves **331 to move, 1 of which is the `@/lib/db` singleton**.

Two constructions the grep cannot see:

- `src/lib/e2e-prisma-factory.test.ts` builds `new Plain(...)` from a
  destructured dynamic import (`const { PrismaClient: Plain } = await
  import('@prisma/client')`).
- `tests/setup/undefined-filter-guard.ts` *subclasses* `PrismaClient` inside a
  `vi.mock('@prisma/client')` factory. It is the vitest mock, not a
  construction site, and stays.

URL overrides: 14 lines carry `datasources` or `datasourceUrl`, matching the
issue (it names seven). Two more sites the issue does not name pass a
different option, `errorFormat` (`tests/integration/log-redaction.test.ts`).

## 2. The trap the issue does not name: the #783 guard decides by call site

`tests/setup/undefined-filter-guard.ts` (vitest `setupFiles`) mocks
`@prisma/client` with a subclass that inspects its own construction stack. The
first frame outside `node:`, `node_modules` and the installer file decides:
a `.test`/`.spec` file or a module under `tests/` gets a client carrying
`undefinedFilterGuard` (which refuses `deleteMany({ where: { id: undefined } })`
before it empties a table); any other frame gets a plain client.

A factory in `src/lib/` puts its own frame directly above the caller. Route
every test construction through it unchanged and **every test client in the
vitest suite becomes an app client, silently unguarded** — no test would fail,
the guard would simply stop existing. Nothing in the acceptance criteria as
written would catch it, since the suite stays green.

**Decision: the installer skips the factory's frame.** `classifyCallSite`
already takes `ignoreFiles`; the installer passes `[SELF, FACTORY]`, where
`FACTORY` is the factory module's resolved path. The caller's frame then
decides, exactly as before: a test calling `createPrismaClient()` is guarded,
`@/lib/db` calling it is plain, `src/lib/db-provision.ts` calling it is plain.

Alternatives rejected:

- *A separate test-only factory under `tests/`.* Its frame would classify
  every client as `test`, so `@/lib/db` — when a test imports it — would be
  guarded too, changing app behaviour under test. It also needs a second
  construction site, which is what the issue removes.
- *Put the guard in the factory behind a flag.* Moves test policy into app
  code and lets a caller forget the flag.

## 3. The factory

`src/lib/prisma-client.ts`, the only module that evaluates `new PrismaClient`:

```ts
export interface PrismaClientFactoryOptions {
  /** Connection URL; omitted, Prisma reads DATABASE_URL. */
  url?: string;
  errorFormat?: Prisma.PrismaClientOptions['errorFormat'];
}
export function createPrismaClient(options: PrismaClientFactoryOptions = {}): PrismaClient
```

- `url` maps to Prisma 6's `datasources: { db: { url } }`; that mapping is the
  line Prisma 7 replaces with an adapter.
- **No caching, ever.** Every call returns a new client with its own pool. The
  lock-order and race tests open holder/racer clients that must be separate
  connections; a test pins that two calls return distinct objects.
- It imports nothing but `@prisma/client`. Scripts, `prisma/seed.ts`, vitest
  and Playwright all import it — and so does the `migrate` Docker stage, which
  copies files one by one rather than `src/` (`Dockerfile`, stage `migrate`):
  `scripts/check-reserved-slugs.ts` (the deploy gate) and `scripts/admin-grant.ts`
  (the operator CLI) run there. The stage gains a `COPY` of the factory, and a
  test pins its import set, as `src/services/admin-grants.test.ts` does for
  `admin-grants.ts`. CI's "Reserved-slug check loads in the migration image"
  step is what would catch a missing `COPY`; `admin-grant.ts` has no such step,
  but it loads the same factory file.
- Options are the two this codebase uses. The issue's sketch included `log`;
  no call site passes it, so it is not added.

`src/lib/db.ts` keeps exporting the singleton, built by `createPrismaClient()`.

## 4. Playwright

Playwright has no module mocking, so `tests/e2e/prisma.ts`'s
`createGuardedPrismaClient` extends explicitly. It takes the factory's options
and returns `createPrismaClient(options).$extends(undefinedFilterGuard)`.
The e2e lint rule that bans `new PrismaClient` under `tests/e2e/` is retargeted
to ban calling `createPrismaClient` there (outside `tests/e2e/prisma.ts`), so
an e2e spec still cannot get an unguarded client.

`src/lib/e2e-prisma-factory.test.ts` unmocks `@prisma/client` and resets
modules; its plain-client case switches from the aliased `new Plain` to a
dynamically imported `createPrismaClient`, which after the reset is built on
the unmocked module.

## 5. The guard against regression

`@typescript-eslint/no-restricted-imports` on every linted TS file: importing
the **value** `PrismaClient` from `@prisma/client` is an error
(`allowTypeImports: true`, so `import type { PrismaClient }` and inline
`type PrismaClient` stay legal — services take `db: PrismaClient` parameters).
Exempt: `src/lib/prisma-client.ts` only. `tests/setup/undefined-filter-guard.ts`
needs no exemption: it reaches the class through `importOriginal()` inside
`vi.mock`, not an import declaration.

Why an import rule rather than the issue's `NewExpression` selector: a
selector keyed on the name `PrismaClient` misses an alias (`new Plain`, §1),
and `no-restricted-syntax` is already configured per glob in six blocks
(`grep -c "'no-restricted-syntax'" eslint.config.mjs`) whose options replace
rather than merge, so a new selector would need repeating into each. A separate rule has no such interaction.

Coverage, probed with eslint on typescript-eslint 8.58: a named import, an
aliased import (`PrismaClient as P`), a namespace import and a re-export
(`export { PrismaClient } from '@prisma/client'`) are all refused; `import type`
and an inline `type PrismaClient` specifier pass. Not caught, stated rather
than chased: a destructured dynamic `import('@prisma/client')`, and anything in
a `.js`/`.cjs` file — the rule's glob is the TypeScript extensions, and the
only CommonJS construction is the engine probe, out of scope. After this
change no dynamic value import remains.

Under `tests/e2e/` the bare factory is refused too (§4). That rule is a
`no-restricted-syntax` selector, kept in the existing e2e block, and it matches
the import specifier (`ImportSpecifier[imported.name='createPrismaClient']`)
as well as the call, so an alias does not escape it.

## 6. Acceptance

- `git grep -nP 'new PrismaClient(?![A-Za-z])' -- ':!docs' ':!scripts/prisma-engine-probe.cjs'`
  matches only `src/lib/prisma-client.ts`, plus comment lines (each read and
  given a verdict; one records a historical experiment, not a construction).
- Lint fails on a value import of `PrismaClient` outside `src/lib/prisma-client.ts`,
  and on `createPrismaClient` in an e2e spec — each proven by breaking it.
- A test built through `createPrismaClient` is still guarded, `@/lib/db` is
  still not — and dropping `FACTORY` from the installer's `ignoreFiles` turns
  the first of those red.
- Full suite green: same URLs, one pool per client.
