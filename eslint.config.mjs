import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';
import prettier from 'eslint-config-prettier';

// Shared by every `no-restricted-syntax` block below that covers non-test
// `src/` and refuses a direct or qualified-name cast to `ClassLock`
// (src/lib/db-locks.ts, #219) — one object, so they can't drift apart.
// Matches `x as ClassLock`, `<ClassLock>x`, and the qualified-name form of
// each — `x as dbLocks.ClassLock`, since a namespace import (`import * as
// dbLocks from '@/lib/db-locks'`) puts the name behind a qualifier — and the
// likeliest such form to get copied into `src/`; `x as unknown as ClassLock`
// is already an outer `TSAsExpression` whose own `typeAnnotation` is
// `ClassLock`, so it needs no separate branch.
//
// An early signal, not the guarantee: it matches by the literal name
// `ClassLock`, so an aliased import, a wrapper type (`as
// Readonly<ClassLock>`), or a generic escapes it silently.
// `assertClassLockHeldBy` in db-locks.ts is the runtime check that actually
// enforces this; it catches every one of those, plus a token forged some
// other way or carried across a transaction boundary, none of which any
// lint selector can see.
const classLockCastSelector = {
  selector: [
    "TSAsExpression[typeAnnotation.typeName.name='ClassLock']",
    "TSTypeAssertion[typeAnnotation.typeName.name='ClassLock']",
    "TSAsExpression[typeAnnotation.typeName.right.name='ClassLock']",
    "TSTypeAssertion[typeAnnotation.typeName.right.name='ClassLock']",
  ].join(', '),
  message:
    'Only lockClassRow (src/lib/db-locks.ts) mints a ClassLock — take the lock instead of casting one (#219).',
};

// The roster-link create/upsert refusal (#181); a named constant for the same
// reason as `classLockCastSelector`.
const teacherStudentWriteSelector = {
  selector:
    "CallExpression[callee.object.property.name='teacherStudent'][callee.property.name=/^(create|createMany|createManyAndReturn|upsert)$/]",
  message:
    'Create the roster link with linkTeacherStudent (src/services/roster-link.ts) — a direct create/upsert here reopens the #181 race.',
};

// A hardcoded dev-server origin in a test file; every `no-restricted-syntax`
// block over `tests/` below lists it.
const localhostOriginSelector = {
  selector:
    'Literal[value=/(localhost|127\\.0\\.0\\.1):[0-9]+/], TemplateElement[value.raw=/(localhost|127\\.0\\.0\\.1):[0-9]+/]',
  message:
    "Don't hardcode a localhost/127.0.0.1 origin — import BASE_URL from tests/helpers.ts and interpolate it instead, so tests work against any origin (e.g. a worktree's dev server on another port).",
};

// A `catch` with no binding discards the error it caught (#692).
const bareCatchSelector = {
  selector: 'CatchClause[param=null]',
  message:
    'Bind the error — catch (err) — and log it: logRequestFailure (src/lib/client-errors.ts) for a failed request in client code, log.error({ err }) on the server. A catch that is correct as bare says why in an eslint-disable-next-line as the last line of the try block (#692).',
};

// The promise-chain spelling of the same discard: a `.catch` handler that
// takes no parameter, or one named with a leading underscore (#692).
const discardedRejectionSelector = {
  selector:
    "CallExpression[callee.property.name='catch'] > :function:matches([params.length=0], [params.0.name=/^_/])",
  message:
    'A .catch handler that takes no parameter (or an _-named one) drops the rejection — take (err: unknown) and log it: logRequestFailure (src/lib/client-errors.ts) for a failed request in client code, log.error({ err }) on the server. A handler correct as it is says why in an eslint-disable-next-line above the .catch (#692).',
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  prettier,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  // In ESLint flat config, a later config object that sets
  // `no-restricted-syntax` for a file already matched by an earlier one
  // REPLACES that rule's options for that file rather than merging them. So
  // every block below that matches a file this `src/**` block also matches
  // repeats the shared selectors that should still apply there, beside its own; a
  // second `src/**` block here would have silently switched the others off
  // wherever they overlapped.
  //
  // `TeacherStudent` rows are created in exactly one place —
  // `linkTeacherStudent` (src/services/roster-link.ts) — and
  // `src/lib/student-visibility.ts` reasons about the set of callers that
  // reach it. `teacherStudentWriteSelector` is what keeps that true: a direct
  // create/upsert outside that one function reopens the read-then-write race
  // #181 closed.
  //
  // `ClassLock` is minted in exactly one place — `lockClassRow` — and
  // `readSeatCount` (src/services/capacity.ts) trusts that to mean the caller
  // holds the `Class` row lock, checking it at runtime via
  // `assertClassLockHeldBy` (src/lib/db-locks.ts). `classLockCastSelector`
  // above is an early signal against a cast that names `ClassLock` literally,
  // not the enforcement — see its own comment for what it misses.
  //
  // Tests are exempt from these two protections: some write `teacherStudent` directly on
  // purpose, for fixture setup or to pin Prisma's own locking behaviour.
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    ignores: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    rules: {
      'no-restricted-syntax': ['error', teacherStudentWriteSelector, classLockCastSelector],
    },
  },
  // Client and route code refuses an unbound `catch` and a parameterless
  // `.catch` handler (#692). It repeats the shared selectors (see the
  // `src/**` block's comment on replacement). `src/lib` is outside; the scope
  // and its cost are in docs/technical-architecture.md (Error responses).
  {
    files: ['src/components/**/*.{ts,tsx}', 'src/app/**/*.{ts,tsx}'],
    ignores: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        teacherStudentWriteSelector,
        classLockCastSelector,
        bareCatchSelector,
        discardedRejectionSelector,
      ],
    },
  },
  // `linkTeacherStudent` itself is the one place the create/upsert selector
  // above must NOT apply — this narrower block, matched after the broad one,
  // replaces its whole `no-restricted-syntax` entry for this one file, which
  // is what makes only the `ClassLock` selector survive here. This file
  // never mints or casts a `ClassLock` either, so the selector still
  // protects it like any other non-test file.
  {
    files: ['src/services/roster-link.ts'],
    rules: {
      'no-restricted-syntax': ['error', classLockCastSelector],
    },
  },
  // A hardcoded dev-server origin in a test file breaks against any server
  // not on that exact host and port (a worktree's isolated server, for
  // one). Scoped to the whole tests/ tree, not just e2e — #547 found the
  // same defect one tier over. tests/helpers.ts is excluded: it's where
  // the fallback literal legitimately lives.
  {
    files: ['tests/**/*.ts', 'tests/**/*.tsx'],
    ignores: ['tests/helpers.ts'],
    rules: {
      'no-restricted-syntax': ['error', localhostOriginSelector],
    },
  },
  // Playwright has no module mocking, so an e2e spec reaches the undefined-
  // filter guard (#783) only through createGuardedPrismaClient. A flat-config
  // block replaces a rule's options rather than merging them, so this block
  // repeats the localhost selector the `tests/**` block above sets.
  {
    files: ['tests/e2e/**/*.ts'],
    ignores: ['tests/e2e/prisma.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        localhostOriginSelector,
        {
          selector: "NewExpression[callee.name='PrismaClient']",
          message:
            'Build e2e Prisma clients with createGuardedPrismaClient() from tests/e2e/prisma.ts; it refuses bulk writes whose filter holds undefined (#783).',
        },
      ],
    },
  },
  // The engine probe is CommonJS by construction (`.cjs`) and uses `require`.
  {
    files: ['scripts/prisma-engine-probe.cjs'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  // docs/ holds the vendored design-system reference (prototype JSX, generated
  // support.js) — documentation, not app code.
  //
  // .claude/ is tooling state, and it is gitignored (.gitignore:4), so CI never
  // sees it — but a git worktree under .claude/worktrees/ puts a *second* copy
  // of the whole repo on disk, and `docs/**` above is resolved relative to this
  // config's directory, so it does not reach that copy. Without this line one
  // parked worktree turns `pnpm run verify` red with eleven errors from vendored
  // JSX that is already ignored in the main tree — a gate failing for a reason
  // no diff can explain, which is how people learn to ignore the gate.
  //
  // playwright-report/ is that same failure with a different source: Playwright
  // writes minified trace bundles into it, so running the e2e suite and then
  // `pnpm run verify` turned lint red on generated JavaScript no diff had
  // touched. test-results/ holds no JavaScript today — screenshots, traces and
  // JSON — so it is listed as the sibling output directory rather than a second
  // measured cause. Both are build output, never authored.
  //
  // coverage/ is the third, and the same shape: the lcov reporter writes an
  // HTML report whose bundled scripts carry an eslint-disable this config has
  // nothing to disable, so `--coverage` in the test run made the warning count
  // depend on whether an untracked artifact happened to be on disk.
  globalIgnores([
    '.next/**',
    '.next-build/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
    'docs/**',
    '.claude/**',
    'playwright-report/**',
    'test-results/**',
    'coverage/**',
  ]),
]);

export default eslintConfig;
