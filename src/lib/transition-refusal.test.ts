import { describe, it, expect } from 'vitest';
import { ClassStatus } from '@prisma/client';
import { canTransition } from '@/services/class-lifecycle';
import {
  frozenClassMessage,
  notCancellableMessage,
  transitionRefusalMessage,
} from './transition-refusal';

const STATUSES = Object.values(ClassStatus);
const QUOTED_STATUS = new RegExp(`["'\`](${STATUSES.join('|')})["'\`]`);

/** Spec §6.1: a full sentence in the user's terms — no status literal, no identifier. */
function expectUserSentence(message: string): void {
  expect(message).toMatch(/^[A-Z].*\.$/);
  expect(message).not.toMatch(QUOTED_STATUS);
  expect(message).not.toContain('_');
}

describe('transitionRefusalMessage', () => {
  const REFUSED = [
    ['draft', 'in_progress', 'Publish this class first.'],
    ['draft', 'completed', 'Publish this class first.'],
    ['open', 'draft', "A published class can't go back to draft."],
    ['open', 'completed', "This class can't be completed from here."],
    ['in_progress', 'draft', 'This class has already started.'],
    ['in_progress', 'open', 'This class has already started.'],
    ['completed', 'draft', 'This class has already finished.'],
    ['completed', 'open', 'This class has already finished.'],
    ['completed', 'in_progress', 'This class has already finished.'],
  ] as const;

  it.each(REFUSED)('%s → %s: %s', (from, to, message) => {
    expect(transitionRefusalMessage(from, to)).toBe(message);
  });

  // Tethers the table above to `VALID_TRANSITIONS`: a transition added or
  // removed there fails here until the table says what to answer.
  it('lists exactly the pairs the state machine refuses, other than a status to itself', () => {
    const refused = STATUSES.flatMap((from) =>
      STATUSES.filter((to) => to !== from && !canTransition(from, to)).map((to) => `${from}→${to}`),
    );
    expect(refused.sort()).toEqual(REFUSED.map(([from, to]) => `${from}→${to}`).sort());
  });

  it('answers every pair with a sentence that names no status literal', () => {
    for (const from of STATUSES) {
      for (const to of STATUSES) expectUserSentence(transitionRefusalMessage(from, to));
    }
  });
});

describe('notCancellableMessage', () => {
  it.each([
    ['in_progress', "This class has already started, so it can't be cancelled."],
    ['completed', "This class has already finished, so it can't be cancelled."],
  ] as const)('%s: %s', (status, message) => {
    expect(notCancellableMessage(status)).toBe(message);
  });

  it('answers a status the cancel door accepts with a sentence that names no state', () => {
    for (const status of ['draft', 'open'] as const) {
      expect(notCancellableMessage(status)).toBe(
        "This class can't be cancelled right now. Refresh and try again.",
      );
    }
  });

  it('answers every status with a sentence that names no status literal', () => {
    for (const status of STATUSES) expectUserSentence(notCancellableMessage(status));
  });
});

describe('frozenClassMessage', () => {
  it.each([
    ['completed', 'This class has finished and can no longer be changed.'],
    ['cancelled', 'This class has been cancelled and can no longer be changed.'],
  ] as const)('%s: %s', (state, message) => {
    expect(frozenClassMessage(state)).toBe(message);
  });

  it('answers a live status, which is never frozen, with a sentence that names no state', () => {
    for (const status of ['draft', 'open', 'in_progress'] as const) {
      expect(frozenClassMessage(status)).toBe('This class can no longer be changed.');
    }
  });

  it('answers every state with a sentence that names no status literal', () => {
    for (const state of [...STATUSES, 'cancelled' as const]) expectUserSentence(frozenClassMessage(state));
  });
});
