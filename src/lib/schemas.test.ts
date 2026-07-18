import { describe, it, expect } from 'vitest';
import {
  transitionClassSchema,
  magicLinkSendSchema,
  createClassSchema,
  updateTeacherSchema,
  isSafeRelativePath,
  MAX_CLASS_SIZE,
} from './schemas';

describe('transitionClassSchema', () => {
  it('accepts legal manual transitions', () => {
    for (const status of ['draft', 'open', 'in_progress', 'cancelled']) {
      expect(transitionClassSchema.safeParse({ status }).success).toBe(true);
    }
  });

  it("rejects 'completed' — completion must run the pricing engine via /complete", () => {
    // A bare status flip to completed would skip pricing, payments, and
    // payment-request notifications entirely (silent revenue loss).
    expect(transitionClassSchema.safeParse({ status: 'completed' }).success).toBe(false);
  });
});

describe('redirect path validation', () => {
  const parse = (redirect: string) =>
    magicLinkSendSchema.safeParse({ email: 'a@b.test', redirect }).success;

  it('accepts ordinary relative paths', () => {
    expect(parse('/')).toBe(true);
    expect(parse('/teacher-slug/book/abc?x=1')).toBe(true);
  });

  it('rejects absolute and protocol-relative URLs', () => {
    expect(parse('https://evil.com')).toBe(false);
    expect(parse('//evil.com')).toBe(false);
  });

  it('rejects backslash variants that browsers normalize to //', () => {
    // `/\evil.com` becomes `//evil.com` in every major browser.
    expect(parse('/\\evil.com')).toBe(false);
    expect(parse('/foo\\bar')).toBe(false);
    expect(isSafeRelativePath('/\\evil.com')).toBe(false);
    expect(isSafeRelativePath('\\/evil.com')).toBe(false);
  });
});

describe('class size caps', () => {
  const base = {
    teacherRoomId: '4f7c2a10-1111-4222-8333-444455556666',
    classType: 'Hatha',
    date: '2099-06-01',
    startTime: '09:00',
    durationMinutes: 60,
    roomCost: 20,
    minRate: 10,
    targetRate: 20,
    cancelDeadline: 'HOURS_24',
  };

  it('accepts sizes up to the cap', () => {
    const result = createClassSchema.safeParse({
      ...base,
      minStudents: 1,
      maxStudents: MAX_CLASS_SIZE,
    });
    expect(result.success).toBe(true);
  });

  it('rejects sizes above the cap — the public page allocates per seat', () => {
    const result = createClassSchema.safeParse({
      ...base,
      minStudents: 100_000_000,
      maxStudents: 100_000_000,
    });
    expect(result.success).toBe(false);
  });
});

describe('updateTeacherSchema.pageSlug', () => {
  it('rejects reserved slugs on update, not just on signup', () => {
    expect(updateTeacherSchema.safeParse({ pageSlug: 'settings' }).success).toBe(false);
    expect(updateTeacherSchema.safeParse({ pageSlug: 'api' }).success).toBe(false);
    expect(updateTeacherSchema.safeParse({ pageSlug: 'my-yoga' }).success).toBe(true);
  });
});
