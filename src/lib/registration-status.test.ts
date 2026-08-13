import { describe, it, expect } from 'vitest';
import type { WaitlistStatus } from '@prisma/client';
import { ACTIVE_REGISTRATION_STATUSES } from './registration-status';

/**
 * The membership check this constant's shape exists to keep, pinned so that
 * reverting to `as const` fails the build rather than the reasoning.
 *
 * PR #218 first shipped this list as `as const satisfies readonly
 * RegistrationStatus[]`. That infers the literal tuple `readonly
 * ["registered","attended","no_show"]`, which narrows `includes`' parameter to
 * those three literals — so all three membership call sites widened it back
 * with `as readonly string[]`, and that cast accepts any string at all. The
 * line below compiled clean under it and silently always returned false.
 *
 * Never called: `tsconfig.json` includes every `.ts` in the repo, so the
 * directive is checked at build time and costs nothing at runtime — the same
 * device `db-locks.test.ts` uses for the transaction-client brand.
 *
 * **What reverting actually does, measured rather than predicted.** The
 * expected failure here was "unused `@ts-expect-error`". It is not: under
 * `as const` this line still errors (differently), so the directive stays
 * used, and the build breaks at four OTHER places instead — the three
 * membership call sites, each reporting `Argument of type
 * 'RegistrationStatus' is not assignable to parameter of type '"registered" |
 * "attended" | "no_show"'`, plus the `as string[]` cast in the freeze test
 * below. That is a louder failure than the one intended and it names the
 * three sites that would need re-widening, which is the useful signal. Kept
 * because a guard whose observed failure differs from its documented one is
 * how a later reader concludes it does not work.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _theListRejectsAForeignEnum(status: WaitlistStatus): void {
  // @ts-expect-error A WaitlistStatus is not a RegistrationStatus. Under a
  // widened `readonly string[]` this compiles and answers false forever.
  ACTIVE_REGISTRATION_STATUSES.includes(status);
}

describe('ACTIVE_REGISTRATION_STATUSES', () => {
  it('is frozen, so no widened alias can change what "full" means', () => {
    expect(Object.isFrozen(ACTIVE_REGISTRATION_STATUSES)).toBe(true);
    expect(() => (ACTIVE_REGISTRATION_STATUSES as string[]).push('cancelled')).toThrow(TypeError);
    expect(ACTIVE_REGISTRATION_STATUSES).toEqual(['registered', 'attended', 'no_show']);
  });
});
