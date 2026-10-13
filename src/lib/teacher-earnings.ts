/** A class's money, in whole cents, from which the teacher's share is derived. */
export interface EarningsInput {
  /** What the students were billed. */
  totalCents: number;
  roomCents: number;
  /** The VAT contained in `totalCents`. */
  vatCents: number;
}

/**
 * What the teacher keeps from a class: what was billed, less the room and the
 * VAT. A subtraction rather than a stored
 * column, so the lines a screen shows always add up to its total; see
 * docs/superpowers/specs/2026-09-14-past-class-payment-breakdown-design.md.
 */
export function teacherEarningsCents({ totalCents, roomCents, vatCents }: EarningsInput): number {
  return totalCents - roomCents - vatCents;
}
