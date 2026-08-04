import { describe, it, expect } from 'vitest';
import { canRemoveContact } from './contacts';

/**
 * #166. The one behaviour the Task 9 brief named explicitly — a declined
 * contact's remove button is absent, not present-and-failing — had no
 * committed test, because the render condition lived inline in a server
 * component no test file can reach. This is the regression guard: if a
 * future edit makes the button unconditional again, this fails before a
 * teacher ever sees a 409.
 */
describe('canRemoveContact', () => {
  it('is false for a declined contact', () => {
    expect(canRemoveContact('declined')).toBe(false);
  });

  it('is true for a pending contact', () => {
    expect(canRemoveContact('pending')).toBe(true);
  });

  // Never actually reaches this function in the running app today — the
  // contact page redirects away for an accepted invitation before it can
  // render a remove button at all. Pinned anyway: `!== 'declined'` is an
  // exclusion, and a mutation to `=== 'pending'` (an inclusion that quietly
  // drops this case to `false`) would pass every other test in this file.
  it('is true for an accepted contact', () => {
    expect(canRemoveContact('accepted')).toBe(true);
  });
});
