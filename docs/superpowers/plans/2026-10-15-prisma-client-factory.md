# One PrismaClient factory (#884) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every `PrismaClient` in `src/`, `tests/`, `scripts/` and `prisma/seed.ts` is built by one factory, `createPrismaClient` in `src/lib/prisma-client.ts`, and lint keeps it that way.

**Architecture:** A factory that never caches; the vitest undefined-filter installer skips the factory's stack frame so its caller still decides guarded-vs-plain; Playwright's guarded factory builds on it; a `no-restricted-imports` rule bans the value import of `PrismaClient` everywhere else.

**Tech Stack:** Prisma 6.19, vitest 4 (projects `unit`, `unit-sweeps`, `integration`), Playwright, ESLint flat config with typescript-eslint.

**Spec:** `docs/superpowers/specs/2026-10-15-prisma-client-factory-design.md` — read §2 before touching anything; it is the reason Task 1 exists.

## Global Constraints

- No behaviour change: same URLs, one pool per client, no caching.
- `scripts/prisma-engine-probe.cjs` is out of scope (#885) — do not edit it.
- `tests/setup/undefined-filter-guard.ts` keeps subclassing the real `PrismaClient`; it is the mock, not a construction site.
- Comment Discipline (CLAUDE.md): no counts or rosters in comments; comments state what is true now.
- Stage exact paths; never `git add -A`/`.`; quote paths containing parentheses.
- Node 24 is required for pnpm (`~/.nvm/versions/node/v24.*/bin` on `PATH`).
- Integration/e2e in this worktree run against its own app: `pnpm run worktree:up` first.

## Review Focus

1. A test client built through the factory losing the #783 guard (spec §2) — expected: still guarded. Pinned in Task 1, Step 1, and proven to bite in Step 6.
2. Two factory calls sharing a pool (a cached singleton) — expected: distinct clients; lock-order holders depend on it. Pinned in Task 1, Step 1.
3. A URL override dropped in translation (a lock-order test silently connecting with the default pool size instead of its widened URL) — expected: each former `datasources`/`datasourceUrl` site passes the same expression as `url`. Task 3, Step 3 reconciles them one by one.
4. An e2e spec calling `createPrismaClient` and getting an unguarded client — expected: lint error. Task 2, Step 5.
5. A file that uses `PrismaClient` only as a type after the move keeping a value import — expected: lint error from the Task 4 rule; the codemod converts it to a type import.
6. The `migrate` Docker image missing the factory — expected: the deploy gate and admin CLI still load. Task 1 pins the factory's import set; Task 2 adds the `COPY` and builds the image.

---

### Task 1: The factory, the singleton, and the installer's frame skip

**Files:**
- Create: `src/lib/prisma-client.ts`
- Create: `src/lib/prisma-client.test.ts`
- Modify: `src/lib/db.ts`
- Modify: `tests/setup/undefined-filter-guard.ts`
- Modify: `tests/undefined-filter-guard.test.ts`

**Interfaces:**
- Produces: `export interface PrismaClientFactoryOptions { url?: string; errorFormat?: Prisma.PrismaClientOptions['errorFormat'] }` and `export function createPrismaClient(options?: PrismaClientFactoryOptions): PrismaClient`, from `@/lib/prisma-client`.

- [ ] **Step 1: Write the failing tests**

`src/lib/prisma-client.test.ts` (unit project, setupFiles install the guard mock):

```ts
import { describe, it, expect, afterAll } from 'vitest';
import { createPrismaClient } from './prisma-client';

const UNREACHABLE = 'postgresql://nobody@127.0.0.1:1/none';

describe('createPrismaClient', () => {
  const a = createPrismaClient();
  const b = createPrismaClient();
  afterAll(async () => {
    await Promise.all([a.$disconnect(), b.$disconnect()]);
  });

  it('returns a new client on every call, so each has its own pool', () => {
    expect(a).not.toBe(b);
  });

  it('connects to the url it is given', async () => {
    const client = createPrismaClient({ url: UNREACHABLE });
    try {
      await expect(client.$queryRaw`SELECT 1`).rejects.toThrow(/127\.0\.0\.1:1/);
    } finally {
      await client.$disconnect();
    }
  });
});
```

Add, in the same file, the import-set pin (precedent: `src/services/admin-grants.test.ts`, "imports only @prisma/client, which is all the migrate image carries"):

```ts
describe('prisma-client.ts imports', () => {
  it('imports only @prisma/client, which is all the migrate image carries', () => {
    const source = readFileSync(path.join(__dirname, 'prisma-client.ts'), 'utf8');
    const specifiers = [...source.matchAll(/(?:\bfrom\s+|\bimport\s*\(?\s*)(['"])([^'"]+)\1/g)].map((m) => m[2]);
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.every((s) => s === '@prisma/client')).toBe(true);
  });
});
```

The distinct-clients case pins identity: it catches a caching factory, which is the realistic regression; it does not prove separate engines, and the lock-order suites in Task 3's full run are what exercise separate connections.

(If Prisma's connection error text does not contain the host:port, assert on the message it does produce for this URL — e.g. `Can't reach database server` — and record the exact text in the report. The point is that the client did not connect to `DATABASE_URL`, which would succeed.)

In `tests/undefined-filter-guard.test.ts`, replace the value import of `PrismaClient` with `type PrismaClient` and import `createPrismaClient` from `@/lib/prisma-client`. Then:
- `const base = new PrismaClient();` → `const base = createPrismaClient();`
- `const moduleLevel = new PrismaClient();` → `createPrismaClient()`; `build()` returns `createPrismaClient()`. These two cases now pin that a client built through the factory from a test file is guarded.
- The "throws rather than guess" case: replace `.then(Reflect.construct.bind(null, PrismaClient))` with `.then(createPrismaClient)`, sourced from `Promise.resolve(undefined)` (not `.then(() => createPrismaClient())` — that arrow is a test-file frame and would decide `test`), so the promise job calls the factory directly and the only file frames are the factory's (skipped) and the installer's (skipped). Update the comment above it to say so.

- [ ] **Step 2: Run to see them fail**

Run: `pnpm exec vitest run --project unit src/lib/prisma-client.test.ts tests/undefined-filter-guard.test.ts`
Expected: FAIL — `Cannot find module './prisma-client'` / `@/lib/prisma-client`.

- [ ] **Step 3: Write the factory**

`src/lib/prisma-client.ts`:

```ts
import { PrismaClient, type Prisma } from '@prisma/client';

export interface PrismaClientFactoryOptions {
  /** Connection URL. Omitted, Prisma reads `DATABASE_URL`. */
  url?: string;
  errorFormat?: Prisma.PrismaClientOptions['errorFormat'];
}

/**
 * The one place a `PrismaClient` is constructed. Every call returns a new
 * client with its own connection pool, and this never caches: callers that
 * open several rely on them being separate connections.
 *
 * Under vitest the guard installer skips this module's stack frame, so the
 * caller decides whether the client carries the undefined-filter guard:
 * `docs/test-database.md`, section "Undefined filters in test cleanup (#783)".
 */
export function createPrismaClient(options: PrismaClientFactoryOptions = {}): PrismaClient {
  const { url, ...rest } = options;
  const clientOptions: Prisma.PrismaClientOptions =
    url === undefined ? rest : { ...rest, datasources: { db: { url } } };
  return new PrismaClient(clientOptions);
}
```

`src/lib/db.ts`: import `type PrismaClient` and `createPrismaClient`; the singleton line becomes `globalForPrisma.prisma ?? createPrismaClient()`.

- [ ] **Step 4: Run — the guard tests now fail for the right reason**

Run the same command. Expected: `prisma-client.test.ts` passes; in `tests/undefined-filter-guard.test.ts` the "guards a client test code builds at module level" and "…inside a function a hook calls" cases FAIL (the deleteMany resolves instead of rejecting), and "throws rather than guess" fails (the factory frame is classified `app`). This is spec §2's trap, observed. Record the failing case names in the report.

- [ ] **Step 5: Skip the factory frame in the installer**

In `tests/setup/undefined-filter-guard.ts`, beside `SELF`:

```ts
const FACTORY = path.join(REPO_ROOT, 'src/lib/prisma-client.ts');
```

and call `classifyCallSite(stack, [SELF, FACTORY], REPO_ROOT)`. Extend the header docblock's first sentence so it says frames in the installer and in `src/lib/prisma-client.ts` are skipped, so a client built through the factory is classified by the factory's caller.

Verify the stack frame path really is the `.ts` source path (vitest maps source). If the frame shows a different spelling (query suffix, `file://`), `classifyCallSite` already normalises those before comparing with `ignoreFiles`; confirm by the test passing, not by assumption.

Run the same command. Expected: PASS, all cases.

- [ ] **Step 6: Prove the skip bites**

Remove `FACTORY` from the `ignoreFiles` array, re-run the same command, record the exact failure lines (which cases, which message), restore, re-run to PASS. Also confirm "leaves the app client from @/lib/db unguarded" passes both with and without the skip (it should — `db.ts` is app code either way).

- [ ] **Step 7: Typecheck and commit**

Run: `pnpm exec tsc --noEmit -p .` → no errors.

```bash
git add src/lib/prisma-client.ts src/lib/prisma-client.test.ts src/lib/db.ts tests/setup/undefined-filter-guard.ts tests/undefined-filter-guard.test.ts
git commit -m "feat: createPrismaClient is the one PrismaClient constructor, and the vitest guard classifies its caller (#884)"
```

---

### Task 2: App-side sites, scripts, seed, and Playwright

**Files:**
- Modify: `src/lib/db-provision.ts`, `src/lib/worktree/side-effects.ts`
- Modify: `scripts/admin-grant.ts`, `scripts/check-reserved-slugs.ts`, `scripts/measure-push-fanout.ts`
- Modify: `prisma/seed.ts`, `tests/stack-ceiling.ts`
- Modify: `tests/e2e/prisma.ts`, `src/lib/e2e-prisma-factory.test.ts`
- Modify: `eslint.config.mjs` (the `tests/e2e/**` block)
- Modify: `Dockerfile` (stage `migrate`)

**Interfaces:**
- Consumes: `createPrismaClient(options?: PrismaClientFactoryOptions): PrismaClient` from Task 1.
- Produces: `createGuardedPrismaClient(options?: PrismaClientFactoryOptions): PrismaClient` (signature changes from `ConstructorParameters<typeof PrismaClient>`).

- [ ] **Step 1: Move each site**

Mechanical rewrites, same expressions:
- `new PrismaClient()` → `createPrismaClient()`
- `new PrismaClient({ datasources: { db: { url: X } } })` → `createPrismaClient({ url: X })`
- `new PrismaClient({ datasourceUrl: X })` → `createPrismaClient({ url: X })`

Imports: `src/` files use `@/lib/prisma-client` only if the file already uses `@/`; `src/lib/db-provision.ts` and `src/lib/worktree/side-effects.ts` use relative imports (`./prisma-client`, `../prisma-client`) — match the file. `scripts/*.ts` use `../src/lib/prisma-client` (relative — the `migrate` image carries no `tsconfig.json`, so `@/` does not resolve there). `prisma/seed.ts` uses `@/lib/prisma-client` (it already imports `@/lib/...`). `tests/stack-ceiling.ts` uses `@/lib/prisma-client`. Where `PrismaClient` survives only as a type, make it `type PrismaClient` (inline or `import type`).

`tests/stack-ceiling.ts` declares a local named `datasourceUrl` and passes it as shorthand; rename the local to `url` and pass `createPrismaClient({ url })`, so Task 3's `datasourceUrl` grep comes back empty here.

`Dockerfile`, stage `migrate`: add, beside the other per-file copies, with a one-line comment in the existing style:

```dockerfile
# Every PrismaClient is built here; both scripts above import it.
COPY src/lib/prisma-client.ts ./src/lib/prisma-client.ts
```

- [ ] **Step 2: Playwright's guarded factory**

`tests/e2e/prisma.ts`:

```ts
import type { PrismaClient } from '@prisma/client';
import { createPrismaClient, type PrismaClientFactoryOptions } from '@/lib/prisma-client';
import { undefinedFilterGuard } from '../undefined-filter-guard';

/** (keep the existing docblock) */
export function createGuardedPrismaClient(options?: PrismaClientFactoryOptions): PrismaClient {
  // The cast restores `PrismaClient`'s type; the extended client has no `$on`.
  return createPrismaClient(options).$extends(undefinedFilterGuard) as unknown as PrismaClient;
}
```

`@/` resolves under Playwright through `tests/e2e/tsconfig.json` (`paths`), which other e2e specs already rely on; Step 6 runs one spec to confirm.

Every e2e caller passes either nothing or an options object — grep `createGuardedPrismaClient(` under `tests/e2e` and convert any `{ datasourceUrl: X }` / `{ datasources: … }` argument to `{ url: X }`.

- [ ] **Step 3: The e2e-factory unit test**

`src/lib/e2e-prisma-factory.test.ts`: the guarded case passes `{ url: UNREACHABLE }`. The plain case drops the aliased `new Plain(...)`:

```ts
const { createPrismaClient } = await import('./prisma-client');
const message = await rejectionOf(createPrismaClient({ url: UNREACHABLE }));
```

After `vi.doUnmock` + `vi.resetModules` in `beforeAll`, the dynamically imported factory is built on the unmocked `@prisma/client`, so the case still checks that only the e2e factory guards. Value-import the factory in this file **only** dynamically: a static import would bind the mocked `@prisma/client`, and the "plain" client would come back guarded. Update the case title and the header sentence ("the plain-client case checks that the unmock held") to name the factory instead of "the unmocked module" if the wording no longer fits.

- [ ] **Step 4: Run the touched tests**

Run: `pnpm exec vitest run --project unit src/lib/e2e-prisma-factory.test.ts src/lib/db-provision.test.ts src/lib/worktree` (include whichever of those test files exist — list `src/lib/worktree/*.test.ts` and `src/lib/db-provision*.test.ts` first).
Expected: PASS.

Prove the e2e-factory guard still bites: temporarily make `createGuardedPrismaClient` return `createPrismaClient(options)` without `$extends`; the guarded case must FAIL (record the message); restore; PASS.

- [ ] **Step 5: Retarget the e2e lint rule**

In `eslint.config.mjs`, the `tests/e2e/**/*.ts` block (ignores `tests/e2e/prisma.ts`): replace the selector `NewExpression[callee.name='PrismaClient']` with `ImportSpecifier[imported.name='createPrismaClient'], CallExpression[callee.name='createPrismaClient']` (the specifier half catches an alias; keep it in this `no-restricted-syntax` entry — a `no-restricted-imports` block for `tests/e2e/**` would replace Task 4's options for those files), message: `Build e2e Prisma clients with createGuardedPrismaClient() from tests/e2e/prisma.ts; it refuses bulk writes whose filter holds undefined (#783).` Update the comment above the block so it says the guard is reached only through `createGuardedPrismaClient` and that this rule refuses the bare factory there.

Prove it bites, twice: (a) add `import { createPrismaClient } from '@/lib/prisma-client';` and `createPrismaClient();` to any e2e spec; (b) the alias, `import { createPrismaClient as make } from '@/lib/prisma-client'; make();`. Each: `pnpm exec eslint <that spec>`, record the error lines, revert, re-run clean.

- [ ] **Step 6: Exercise the scripts and an e2e spec**

- `pnpm exec tsc --noEmit -p .` → clean.
- Build the migrate image and run CI's load check locally (`.github/workflows/ci.yml`, step "Reserved-slug check loads in the migration image" — read the build step above it for the exact `docker build` invocation): the output must contain `P1001` and the exit code must be 1. Also load `scripts/admin-grant.ts` in that image without a database (its no-argument usage path, or the nearest equivalent) and confirm no module-not-found error. Then prove the `COPY` bites: remove it, rebuild, re-run the check, record the module-not-found error, restore, rebuild, re-run clean. If Docker is unavailable locally, say so in the report; CI runs the reserved-slug step on the PR.
- `pnpm run worktree:up`, then `pnpm exec playwright test tests/e2e/studio.spec.ts` → PASS (proves Playwright resolves the factory import).

- [ ] **Step 7: Commit**

```bash
git add src/lib/db-provision.ts src/lib/worktree/side-effects.ts scripts/admin-grant.ts scripts/check-reserved-slugs.ts scripts/measure-push-fanout.ts prisma/seed.ts tests/stack-ceiling.ts tests/e2e/prisma.ts src/lib/e2e-prisma-factory.test.ts eslint.config.mjs
git commit -m "refactor: app helpers, scripts, seed and Playwright build clients through createPrismaClient (#884)"
```

(Add any e2e spec whose `createGuardedPrismaClient` argument changed.)

---

### Task 3: Every test file onto the factory (codemod)

**Order:** after Tasks 1–2. Task 4's lint rule assumes this task left no value import behind.

**Files:**
- Modify: every remaining file matched by `git grep -lP '^(?!\s*(//|\*|/\*)).*new PrismaClient(?![A-Za-z])' -- ':!docs' ':!scripts/prisma-engine-probe.cjs' ':!src/lib/prisma-client.ts'` (≈ 207 test files: 217 TS construction files minus the 10 Tasks 1–2 handle; re-derive).
- Modify: comment lines naming a construction, if the comment describes current code: `src/services/gdpr.ts` (~line 1010), `src/lib/scheduler.test.ts` (~line 686). `src/services/invitations-lock-order.test.ts` (~line 206) describes a historical standalone client used during an investigation — leave it, verdict "historical, correct as written".

- [ ] **Step 1: Write a codemod in the scratchpad (not committed)**

Write it against the TypeScript AST (`ts.createSourceFile`), not lines: two files import `PrismaClient` in a multi-line import (`src/services/class-reminders.test.ts`, `src/services/student-archive.test.ts`) and seven have two `@prisma/client` import declarations (`src/services/{class-template-lifecycle,class-terminal-status,invitations.deliver,link-consent,rule-lifecycle,waitlist-retention}.test.ts`, `tests/integration/payments-overview-page.test.ts`). Hand-check those nine after the run. No construction passes a multi-line options object.

Per file:
1. Replace `new PrismaClient(` with `createPrismaClient(`.
2. Rewrite option objects passed to it: `{ datasources: { db: { url: X } } }` → `{ url: X }`; `{ datasourceUrl: X }` → `{ url: X }`; `{ datasourceUrl }` (shorthand) → `{ url: datasourceUrl }`. `errorFormat` passes through unchanged.
3. Add `import { createPrismaClient } from '@/lib/prisma-client';` as its own statement after the last import declaration.
4. In the `@prisma/client` import: if `PrismaClient` no longer appears as an identifier elsewhere in the file, remove it from the specifier list (and the whole import if the list empties); if it still appears (only as a type now), change the specifier to `type PrismaClient`. Leave `import type { … }` lines alone.

Run it, then `pnpm exec prettier --write` is NOT part of the project flow unless the repo uses it — check `package.json` scripts; otherwise rely on lint.

- [ ] **Step 2: Typecheck and lint**

Run: `pnpm exec tsc --noEmit -p .` and `pnpm run lint`. Fix any file the codemod mishandled by hand (the nine files above; an AST census found no value use of `PrismaClient` outside `new` other than the two Tasks 1–2 already handle). List every hand fix in the report.

- [ ] **Step 3: Reconcile the URL overrides one by one**

`git grep -nE 'datasources|datasourceUrl' -- ':!docs'` must now match only `scripts/prisma-engine-probe.cjs` and `src/lib/prisma-client.ts`. For each line that matched before this branch (spec §1: 14 lines), name the new line and confirm the `url:` expression is the identical expression it replaced. Put that table in the report.

- [ ] **Step 4: Acceptance grep**

`git grep -nP 'new PrismaClient(?![A-Za-z])' -- ':!docs' ':!scripts/prisma-engine-probe.cjs'` → only `src/lib/prisma-client.ts` and comment lines; give each comment line a verdict. Update the `gdpr.ts` and `scheduler.test.ts` comments to say `createPrismaClient()` where they describe what `@/lib/db` builds.

- [ ] **Step 5: Full suite**

`pnpm run worktree:up` (if not up), then `pnpm run verify` (typecheck, lint, the whole vitest suite against the worktree app). Expected: green. If anything earlier in the chain is red, run `pnpm exec vitest run --project integration` directly as well, per the hazard list. Report the test-file counts per project.

- [ ] **Step 6: Commit**

Stage the changed files by exact path (generate the list from `git diff --name-only`, quote paths with parentheses).

```bash
git commit -m "refactor: every test builds its clients through createPrismaClient (#884)"
```

---

### Task 4: The lint guard and the docs

**Order:** last. It turns red until Task 3 is complete.

**Files:**
- Modify: `eslint.config.mjs`
- Modify: `docs/test-database.md` (section 6)
- Modify: `docs/technical-architecture.md` (the project-tree entry `db.ts  # Prisma client singleton`, near line 102 — `grep -n 'Prisma client singleton'`; add a `prisma-client.ts` entry beside it, and the paragraph wherever the services/data-access prose sits)

- [ ] **Step 1: Add the rule**

A new block in `eslint.config.mjs`, with a comment stating why (Prisma 7 adapter lands in one place, #884) and that it bans the value import, not the type:

```js
{
  files: ['**/*.ts', '**/*.tsx', '**/*.mts'],
  ignores: ['src/lib/prisma-client.ts'],
  rules: {
    '@typescript-eslint/no-restricted-imports': [
      'error',
      {
        paths: [
          {
            name: '@prisma/client',
            importNames: ['PrismaClient'],
            allowTypeImports: true,
            message: 'Build clients with createPrismaClient() from @/lib/prisma-client (#884). A type-only import is fine.',
          },
        ],
      },
    ],
  },
},
```

Check the plugin namespace in this config: the rule must resolve under whatever prefix the config registers typescript-eslint as. Place the block so it is not shadowed by a later block setting the same rule (none does today).

- [ ] **Step 2: Prove it bites, three ways**

Each: make the change in a real file, run `pnpm exec eslint <file>`, record the exact error, revert, re-run clean.
1. A test file: `import { PrismaClient } from '@prisma/client'; const x = new PrismaClient();` → error.
2. An alias: `import { PrismaClient as P } from '@prisma/client';` → error.
3. Inline type specifier: `import { type PrismaClient, Prisma } from '@prisma/client';` → **no** error (the plan review probed this on typescript-eslint 8.58; confirm).

Then `pnpm run lint` → clean.

- [ ] **Step 3: Docs**

`docs/test-database.md` §6: the vitest bullet says a client a test builds through `createPrismaClient()` comes back guarded, because the installer skips the factory's frame along with its own and the factory's caller decides; the Playwright bullet says `createGuardedPrismaClient()` wraps `createPrismaClient()` and lint refuses `createPrismaClient` under `tests/e2e`. In the "which frame decides" paragraph, add the factory to the skipped frames.

`docs/technical-architecture.md`: one short paragraph beside the description of `src/lib/db.ts`: `src/lib/prisma-client.ts` is the one place a client is constructed; `@/lib/db` is the app singleton built from it; tests, scripts and the seed call the factory for clients of their own (each call a new pool); lint (`no-restricted-imports`) refuses a value import of `PrismaClient` elsewhere; the purpose is that the Prisma 7 driver-adapter change (#889) lands in that one file. No counts.

- [ ] **Step 4: Verify and commit**

`pnpm run verify` → green.

```bash
git add eslint.config.mjs docs/test-database.md docs/technical-architecture.md
git commit -m "chore: lint refuses a value import of PrismaClient outside the factory, and the docs say where clients come from (#884)"
```
