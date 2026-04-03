/**
 * Class Lifecycle State Machine — Pure logic, no side effects.
 *
 * Manages class status transitions with guards.
 * Classes move through: draft → open → full → in_progress → completed
 * with cancellation possible from most non-terminal states.
 */

import type { ClassStatus } from '@prisma/client';

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

/**
 * All valid state transitions. Terminal states (completed, cancelled)
 * have empty arrays — no transitions out.
 */
export const VALID_TRANSITIONS: Record<ClassStatus, ClassStatus[]> = {
  draft: ['open', 'cancelled'],
  open: ['full', 'in_progress', 'cancelled'],
  full: ['open', 'in_progress', 'cancelled'],
  in_progress: ['completed'],
  completed: [],
  cancelled: [],
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TransitionResult = { ok: true } | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/**
 * Check whether a state transition is valid.
 */
export function canTransition(from: ClassStatus, to: ClassStatus): boolean {
  const allowed = VALID_TRANSITIONS[from];
  return allowed.includes(to);
}

/**
 * Validate a state transition, returning a typed result.
 * On failure, the error message describes the invalid transition.
 */
export function validateTransition(
  from: ClassStatus,
  to: ClassStatus,
): TransitionResult {
  if (canTransition(from, to)) {
    return { ok: true };
  }
  return {
    ok: false,
    error: `Invalid transition: cannot move from "${from}" to "${to}". Valid transitions from "${from}": [${VALID_TRANSITIONS[from].join(', ')}]`,
  };
}

// ---------------------------------------------------------------------------
// Economic field locking
// ---------------------------------------------------------------------------

/**
 * The economic fields that become immutable once settings_locked flips true
 * (i.e., after the first student registers).
 */
export const ECONOMIC_FIELDS = Object.freeze([
  'roomCost',
  'minRate',
  'targetRate',
  'minStudents',
  'maxStudents',
] as const);

export type EconomicField = (typeof ECONOMIC_FIELDS)[number];

/**
 * Whether economic fields are locked for editing.
 * Locked once the first registration is created (settingsLocked = true).
 */
export function isEconomicFieldLocked(settingsLocked: boolean): boolean {
  return settingsLocked;
}
