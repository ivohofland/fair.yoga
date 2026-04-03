import { describe, it, expect } from 'vitest';
import {
  VALID_TRANSITIONS,
  ECONOMIC_FIELDS,
  canTransition,
  validateTransition,
  isEconomicFieldLocked,
} from './class-lifecycle';

// We use string literals matching the Prisma ClassStatus enum values.
// This keeps tests independent of the Prisma client being generated.

describe('VALID_TRANSITIONS', () => {
  it('defines transitions for every ClassStatus value', () => {
    const allStatuses = [
      'draft',
      'open',
      'full',
      'in_progress',
      'completed',
      'cancelled',
    ] as const;

    for (const status of allStatuses) {
      expect(VALID_TRANSITIONS).toHaveProperty(status);
      expect(Array.isArray(VALID_TRANSITIONS[status])).toBe(true);
    }
  });

  it('draft can transition to open or cancelled', () => {
    expect(VALID_TRANSITIONS['draft']).toEqual(
      expect.arrayContaining(['open', 'cancelled']),
    );
    expect(VALID_TRANSITIONS['draft']).toHaveLength(2);
  });

  it('open can transition to full, in_progress, or cancelled', () => {
    expect(VALID_TRANSITIONS['open']).toEqual(
      expect.arrayContaining(['full', 'in_progress', 'cancelled']),
    );
    expect(VALID_TRANSITIONS['open']).toHaveLength(3);
  });

  it('full can transition to open, in_progress, or cancelled', () => {
    expect(VALID_TRANSITIONS['full']).toEqual(
      expect.arrayContaining(['open', 'in_progress', 'cancelled']),
    );
    expect(VALID_TRANSITIONS['full']).toHaveLength(3);
  });

  it('in_progress can only transition to completed', () => {
    expect(VALID_TRANSITIONS['in_progress']).toEqual(['completed']);
  });

  it('completed is a terminal state with no transitions', () => {
    expect(VALID_TRANSITIONS['completed']).toEqual([]);
  });

  it('cancelled is a terminal state with no transitions', () => {
    expect(VALID_TRANSITIONS['cancelled']).toEqual([]);
  });
});

describe('canTransition', () => {
  it('returns true for valid transitions', () => {
    expect(canTransition('draft', 'open')).toBe(true);
    expect(canTransition('draft', 'cancelled')).toBe(true);
    expect(canTransition('open', 'full')).toBe(true);
    expect(canTransition('open', 'in_progress')).toBe(true);
    expect(canTransition('open', 'cancelled')).toBe(true);
    expect(canTransition('full', 'open')).toBe(true);
    expect(canTransition('full', 'in_progress')).toBe(true);
    expect(canTransition('full', 'cancelled')).toBe(true);
    expect(canTransition('in_progress', 'completed')).toBe(true);
  });

  it('returns false for invalid transitions', () => {
    expect(canTransition('draft', 'completed')).toBe(false);
    expect(canTransition('draft', 'full')).toBe(false);
    expect(canTransition('draft', 'in_progress')).toBe(false);
    expect(canTransition('open', 'draft')).toBe(false);
    expect(canTransition('open', 'completed')).toBe(false);
    expect(canTransition('full', 'draft')).toBe(false);
    expect(canTransition('full', 'completed')).toBe(false);
    expect(canTransition('in_progress', 'draft')).toBe(false);
    expect(canTransition('in_progress', 'open')).toBe(false);
    expect(canTransition('in_progress', 'cancelled')).toBe(false);
  });

  it('returns false for transitions out of terminal states', () => {
    expect(canTransition('completed', 'open')).toBe(false);
    expect(canTransition('completed', 'draft')).toBe(false);
    expect(canTransition('completed', 'cancelled')).toBe(false);
    expect(canTransition('cancelled', 'open')).toBe(false);
    expect(canTransition('cancelled', 'draft')).toBe(false);
    expect(canTransition('cancelled', 'completed')).toBe(false);
  });

  it('returns false for self-transitions', () => {
    expect(canTransition('draft', 'draft')).toBe(false);
    expect(canTransition('open', 'open')).toBe(false);
    expect(canTransition('full', 'full')).toBe(false);
    expect(canTransition('in_progress', 'in_progress')).toBe(false);
    expect(canTransition('completed', 'completed')).toBe(false);
    expect(canTransition('cancelled', 'cancelled')).toBe(false);
  });
});

describe('validateTransition', () => {
  it('returns { ok: true } for valid transitions', () => {
    expect(validateTransition('draft', 'open')).toEqual({ ok: true });
    expect(validateTransition('open', 'full')).toEqual({ ok: true });
    expect(validateTransition('full', 'in_progress')).toEqual({ ok: true });
    expect(validateTransition('in_progress', 'completed')).toEqual({
      ok: true,
    });
  });

  it('returns { ok: false, error } for invalid transitions', () => {
    const result = validateTransition('draft', 'completed');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('draft');
      expect(result.error).toContain('completed');
    }
  });

  it('returns { ok: false, error } for transitions out of terminal states', () => {
    const result = validateTransition('completed', 'open');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('completed');
    }
  });

  it('error message describes the invalid transition', () => {
    const result = validateTransition('cancelled', 'draft');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(typeof result.error).toBe('string');
      expect(result.error.length).toBeGreaterThan(0);
    }
  });
});

describe('isEconomicFieldLocked', () => {
  it('returns true when settingsLocked is true', () => {
    expect(isEconomicFieldLocked(true)).toBe(true);
  });

  it('returns false when settingsLocked is false', () => {
    expect(isEconomicFieldLocked(false)).toBe(false);
  });
});

describe('ECONOMIC_FIELDS', () => {
  it('contains exactly the 5 economic fields', () => {
    expect(ECONOMIC_FIELDS).toEqual([
      'roomCost',
      'minRate',
      'targetRate',
      'minStudents',
      'maxStudents',
    ]);
  });

  it('is readonly (frozen)', () => {
    expect(Object.isFrozen(ECONOMIC_FIELDS)).toBe(true);
  });
});
