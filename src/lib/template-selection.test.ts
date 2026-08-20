/**
 * `ACTIVE_TEMPLATE_WHERE` is imported by two modules that must agree:
 * `services/class-generator.ts` selects templates to run with it, and
 * `services/room-archive.ts` blocks archiving a room those templates would
 * generate into. Sharing the constant is what makes them agree; this test
 * pins its VALUE, so that widening or narrowing it is a deliberate change
 * with both call sites in view rather than a one-word edit in passing.
 *
 * `templateGenerationState` (#194) is the same rule asked of a single row, for
 * callers that need to name the state rather than filter on it. It has its own
 * describe block below, and one of its cases pins the two against each other.
 */
import { describe, it, expect } from 'vitest';
import { ACTIVE_TEMPLATE_WHERE, templateGenerationState } from './template-selection';

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

/**
 * The one-row form of the same question (#194). `updateClassTemplate` gates
 * its first-effective-week probe on this, and `templateUpdatedMessage` picks
 * one of three sentences from it — so a wrong answer here is a confirmation
 * naming a week the sweep will never fill.
 */
describe('templateGenerationState', () => {
  it('agrees with ACTIVE_TEMPLATE_WHERE about what "live" means', () => {
    // The pin that keeps the row-set predicate and the single-row answer from
    // drifting: the constant's own value, fed to the function, must be the
    // state the constant selects.
    expect(templateGenerationState(ACTIVE_TEMPLATE_WHERE)).toBe('active');
  });

  it('calls a template the sweep skips paused, not active', () => {
    expect(templateGenerationState({ isActive: false, isArchived: false })).toBe('paused');
  });

  /**
   * Both archive directions force `isActive: false`, so this is the shape
   * every archived row actually has — and it must answer `archived`, not
   * `paused`. Resuming is not the remedy for it; un-archiving first is.
   */
  it('calls an archived template archived even though it is also inactive', () => {
    expect(templateGenerationState({ isActive: false, isArchived: true })).toBe('archived');
  });

  /**
   * Unreachable through any route today — nothing sets `isArchived` without
   * clearing `isActive` in the same write — but pinned because it is what
   * makes the branch ORDER load-bearing. Test `isActive` first and this row
   * reports `active`, which would put a dated week in front of a teacher for
   * a template the sweep's `isArchived: false` half excludes.
   */
  it('lets isArchived win over a stale isActive', () => {
    expect(templateGenerationState({ isActive: true, isArchived: true })).toBe('archived');
  });
});
