/**
 * The three cross-field rules a class's economics must satisfy together,
 * stated once so every caller checks the same thing the same way (#221).
 * The same rules are `CHECK` constraints on `Class` and `ClassTemplate`;
 * see `docs/data-model.md`.
 *
 * Keep this module import-free: it is meant to be importable from client code.
 */
export type ClassEconomics = {
  roomCost: number;
  minRate: number;
  targetRate: number;
  minStudents: number;
  maxStudents: number;
};

export type EconomicsRule = 'students_order' | 'rate_order' | 'room_subsidy';

export type EconomicsViolation = {
  rule: EconomicsRule;
  path: keyof ClassEconomics;
  message: string;
};

/** Every rule `e` breaks, in rule order; empty when it breaks none. */
export function economicsViolations(e: ClassEconomics): readonly EconomicsViolation[] {
  const out: EconomicsViolation[] = [];
  if (e.minStudents > e.maxStudents) {
    out.push({ rule: 'students_order', path: 'minStudents', message: 'minStudents cannot exceed maxStudents' });
  }
  if (e.minRate > e.targetRate) {
    out.push({ rule: 'rate_order', path: 'minRate', message: 'minRate cannot exceed targetRate' });
  }
  // Negative minRate is supported (the teacher subsidises the room); this
  // bounds the subsidy at the room cost, never at zero.
  if (e.minRate < -e.roomCost) {
    out.push({
      rule: 'room_subsidy',
      path: 'minRate',
      message: 'minRate cannot subsidize more than the room cost — prices would go negative',
    });
  }
  return out;
}

/** The `path: message` list `parseBody` builds from Zod issues. */
export function formatEconomicsViolations(vs: readonly EconomicsViolation[]): string {
  return vs.map((v) => `${v.path}: ${v.message}`).join(', ');
}
