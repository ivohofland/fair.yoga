import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';
import prettier from 'eslint-config-prettier';

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
  // `TeacherStudent` rows are created in exactly one place, and
  // `src/lib/student-visibility.ts` reasons about the set of callers that
  // reach it. Before #181 the same statement was written at five call sites,
  // each with its own read-then-write race; collapsing them is only durable
  // if a sixth cannot quietly appear. Tests are exempt: the lock-order suite
  // writes this table directly on purpose, to pin Prisma's own behaviour.
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    ignores: ['src/services/roster-link.ts', 'src/**/*.test.ts', 'src/**/*.test.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.object.property.name='teacherStudent'][callee.property.name=/^(create|createMany|upsert)$/]",
          message:
            'Create the roster link with linkTeacherStudent (src/services/roster-link.ts) — a direct create/upsert here reopens the #181 race.',
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
  // parked worktree turns `npm run verify` red with eleven errors from vendored
  // JSX that is already ignored in the main tree — a gate failing for a reason
  // no diff can explain, which is how people learn to ignore the gate.
  globalIgnores([
    '.next/**',
    '.next-build/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
    'docs/**',
    '.claude/**',
  ]),
]);

export default eslintConfig;
