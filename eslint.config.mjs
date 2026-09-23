import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';
import prettier from 'eslint-config-prettier';

// Shared by both `no-restricted-syntax` blocks below that police `ClassLock`
// (src/lib/db-locks.ts, #219) — one object so the broad src/ block and its
// override for src/services/roster-link.ts can't drift apart. Matches both
// `x as ClassLock` and `<ClassLock>x`; `x as unknown as ClassLock` is already
// an outer `TSAsExpression` whose own `typeAnnotation` is `ClassLock`, so it
// needs no separate branch.
const classLockCastSelector = {
  selector:
    "TSAsExpression[typeAnnotation.typeName.name='ClassLock'], TSTypeAssertion[typeAnnotation.typeName.name='ClassLock']",
  message:
    'Only lockClassRow (src/lib/db-locks.ts) mints a ClassLock — take the lock instead of casting one (#219).',
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
  // Two unrelated `no-restricted-syntax` protections share this one block
  // rather than each getting its own: in ESLint flat config, a later config
  // object that sets `no-restricted-syntax` for a file already matched by an
  // earlier one REPLACES that rule's options for that file rather than
  // merging them — so a second `src/**` block here would have silently
  // switched the other one off wherever the two overlapped.
  //
  // `TeacherStudent` rows are created in exactly one place —
  // `linkTeacherStudent` (src/services/roster-link.ts) — and
  // `src/lib/student-visibility.ts` reasons about the set of callers that
  // reach it. This selector is what keeps that true: a direct create/upsert
  // outside that one function reopens the read-then-write race #181 closed.
  //
  // `ClassLock` is minted in exactly one place — `lockClassRow` — and
  // `readSeatCount` (src/services/capacity.ts) trusts that to mean the caller
  // holds the `Class` row lock. A cast forges that trust and would pass every
  // type guard otherwise in its way, so `classLockCastSelector` above is the
  // enforcement.
  //
  // Tests are exempt from both: some write `teacherStudent` directly on
  // purpose (fixture setup, or pinning Prisma's own locking behaviour), and
  // `db-locks.test.ts` builds a deliberately-wrong `ClassLock` shape as a
  // plain object literal, never a cast, to pin the other half of #219's
  // protection.
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    ignores: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.object.property.name='teacherStudent'][callee.property.name=/^(create|createMany|createManyAndReturn|upsert)$/]",
          message:
            'Create the roster link with linkTeacherStudent (src/services/roster-link.ts) — a direct create/upsert here reopens the #181 race.',
        },
        classLockCastSelector,
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
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'Literal[value=/(localhost|127\\.0\\.0\\.1):[0-9]+/], TemplateElement[value.raw=/(localhost|127\\.0\\.0\\.1):[0-9]+/]',
          message:
            "Don't hardcode a localhost/127.0.0.1 origin — import BASE_URL from tests/helpers.ts and interpolate it instead, so tests work against any origin (e.g. a worktree's dev server on another port).",
        },
      ],
    },
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
