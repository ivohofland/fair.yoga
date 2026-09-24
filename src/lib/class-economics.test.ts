import { describe, it, expect } from 'vitest';
import { economicsViolations, formatEconomicsViolations, type ClassEconomics } from './class-economics';

const valid: ClassEconomics = { roomCost: 35, minRate: 15, targetRate: 25, minStudents: 4, maxStudents: 12 };

describe('economicsViolations', () => {
  it('returns nothing for a valid row', () => {
    expect(economicsViolations(valid)).toEqual([]);
  });

  it('allows each boundary with equality', () => {
    expect(economicsViolations({ ...valid, minStudents: 12, maxStudents: 12 })).toEqual([]);
    expect(economicsViolations({ ...valid, minRate: 25, targetRate: 25 })).toEqual([]);
    expect(economicsViolations({ ...valid, minRate: -35 })).toEqual([]); // subsidises exactly the room
  });

  it('refuses one past each boundary, naming the rule, path and message', () => {
    expect(economicsViolations({ ...valid, minStudents: 13 })).toEqual([
      { rule: 'students_order', path: 'minStudents', message: 'minStudents cannot exceed maxStudents' },
    ]);
    expect(economicsViolations({ ...valid, minRate: 26 })).toEqual([
      { rule: 'rate_order', path: 'minRate', message: 'minRate cannot exceed targetRate' },
    ]);
    expect(economicsViolations({ ...valid, minRate: -35.01 })).toEqual([
      {
        rule: 'room_subsidy',
        path: 'minRate',
        message: 'minRate cannot subsidize more than the room cost — prices would go negative',
      },
    ]);
  });

  it('reports every broken rule, in rule order', () => {
    const vs = economicsViolations({ roomCost: 10, minRate: -20, targetRate: -30, minStudents: 5, maxStudents: 2 });
    expect(vs.map((v) => v.rule)).toEqual(['students_order', 'rate_order', 'room_subsidy']);
  });

  it('formats like parseBody formats Zod issues', () => {
    const vs = economicsViolations({ ...valid, minStudents: 13, minRate: 26 });
    expect(formatEconomicsViolations(vs)).toBe(
      'minStudents: minStudents cannot exceed maxStudents, minRate: minRate cannot exceed targetRate',
    );
  });
});
