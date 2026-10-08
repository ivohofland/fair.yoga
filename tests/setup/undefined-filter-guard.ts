/**
 * Replaces `@prisma/client`'s `PrismaClient` with one that classifies its
 * construction stack (`classifyCallSite`): a client whose call site is test
 * code comes back carrying `undefinedFilterGuard`, one whose call site is app
 * code comes back plain, and a stack with no frame to decide from makes the
 * constructor throw rather than guess. What is exempt, and why:
 * `docs/test-database.md`, section "Undefined filters in test cleanup (#783)".
 *
 * Spec: docs/superpowers/specs/2026-10-08-undefined-filter-guard-design.md
 */
import { vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { classifyCallSite, undefinedFilterGuard, UNDEFINED_FILTER_GUARD_MESSAGE_PREFIX } from '../undefined-filter-guard';

const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF), '../..');

// Deep enough that a run of `node_modules` frames cannot push the deciding
// frame off the captured stack.
const STACK_FRAMES = 50;

function constructionStack(): string {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = STACK_FRAMES;
  try {
    return new Error().stack ?? '';
  } finally {
    Error.stackTraceLimit = limit;
  }
}

vi.mock('@prisma/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@prisma/client')>();
  class GuardedPrismaClient extends actual.PrismaClient {
    constructor(...args: ConstructorParameters<typeof actual.PrismaClient>) {
      super(...args);
      const stack = constructionStack();
      const site = classifyCallSite(stack, [SELF], REPO_ROOT);
      if (site === 'undecided') {
        throw new Error(
          `${UNDEFINED_FILTER_GUARD_MESSAGE_PREFIX} cannot tell whether test or app code built this PrismaClient: ` +
            `no stack frame outside node:, node_modules and ${path.relative(REPO_ROOT, SELF)}.\n${stack}`,
        );
      }
      if (site === 'test') {
        // The cast restores `PrismaClient`'s type; the extended client has no `$on`.
        return this.$extends(undefinedFilterGuard) as unknown as GuardedPrismaClient;
      }
    }
  }
  return { ...actual, PrismaClient: GuardedPrismaClient };
});
