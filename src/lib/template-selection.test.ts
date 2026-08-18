/**
 * `ACTIVE_TEMPLATE_WHERE` is imported by two modules that must agree:
 * `services/class-generator.ts` selects templates to run with it, and
 * `services/room-archive.ts` blocks archiving a room those templates would
 * generate into. Sharing the constant is what makes them agree; this test
 * pins its VALUE, so that widening or narrowing it is a deliberate change
 * with both call sites in view rather than a one-word edit in passing.
 */
import { describe, it, expect } from 'vitest';
import { ACTIVE_TEMPLATE_WHERE } from './template-selection';

describe('ACTIVE_TEMPLATE_WHERE', () => {
  it('selects live templates only — active and not archived', () => {
    expect(ACTIVE_TEMPLATE_WHERE).toEqual({ isActive: true, isArchived: false });
  });

  // `isArchived: false` is defense in depth: the routes already keep archived
  // templates inactive, so dropping it would change nothing observable today
  // and would silently remove the backstop `class-generator.ts` documents.
  it('keeps both keys, not just isActive', () => {
    expect(Object.keys(ACTIVE_TEMPLATE_WHERE).sort()).toEqual(['isActive', 'isArchived']);
  });
});
