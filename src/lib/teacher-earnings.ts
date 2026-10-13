/** A class's money, in whole cents, from which the teacher's share is derived. */
export interface EarningsInput {
  /** What the students were billed. */
  totalCents: number;
  roomCents: number;
}

/**
 * What the teacher keeps from a class. A subtraction rather than a stored
 * column, so the lines a screen shows always add up to its total; see
 * docs/superpowers/specs/2026-09-14-past-class-payment-breakdown-design.md.
 */
export function teacherEarningsCents({ totalCents, roomCents }: EarningsInput): number {
  return totalCents - roomCents;
}
