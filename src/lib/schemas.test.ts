import { describe, it, expect } from 'vitest';
import {
  transitionClassSchema,
  magicLinkSendSchema,
  passkeyAuthVerifySchema,
  createClassSchema,
  updateClassSchema,
  updateClassTemplateSchema,
  updateTeacherSchema,
  updateStudentSchema,
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
  // Every schema that carries a redirect must wire in the same relativePath
  // guard — loosening any one of them reopens the open redirect after
  // that flow's sign-in.
  const parsers: Record<string, (redirect: string) => boolean> = {
    magicLinkSendSchema: (redirect) =>
      magicLinkSendSchema.safeParse({ email: 'a@b.test', redirect }).success,
    passkeyAuthVerifySchema: (redirect) =>
      passkeyAuthVerifySchema.safeParse({ response: {}, challengeId: 'x', redirect }).success,
  };

  for (const [name, parse] of Object.entries(parsers)) {
    describe(name, () => {
      it('accepts ordinary relative paths', () => {
        expect(parse('/')).toBe(true);
        expect(parse('/teacher-slug/book/abc?x=1')).toBe(true);
      });

      it('rejects absolute and protocol-relative URLs', () => {
        expect(parse('https://evil.com')).toBe(false);
        expect(parse('//evil.com')).toBe(false);
        expect(parse('')).toBe(false);
      });

      it('rejects backslash variants that browsers normalize to //', () => {
        // `/\evil.com` becomes `//evil.com` in every major browser.
        expect(parse('/\\evil.com')).toBe(false);
        expect(parse('/foo\\bar')).toBe(false);
      });
    });
  }

  it('redirect is optional in both schemas', () => {
    expect(magicLinkSendSchema.safeParse({ email: 'a@b.test' }).success).toBe(true);
    expect(
      passkeyAuthVerifySchema.safeParse({ response: {}, challengeId: 'x' }).success,
    ).toBe(true);
  });

  it('guards the raw helper against browser backslash normalization', () => {
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

describe('createClassSchema', () => {
  // #146. templateId was accepted here and written straight into
  // prisma.class.create with no ownership check. It is server-set —
  // class-generator.ts sets it when a template materialises an instance — so
  // the fix was to stop declaring it, not to validate it.
  //
  // A failure here is a decision, not a chore: adding a key means a client may
  // now set that column at creation time.
  it('accepts exactly the client-settable create field set', () => {
    expect(Object.keys(createClassSchema.shape).sort()).toEqual([
      'autoCancelCheck',
      'cancelDeadline',
      'classType',
      'date',
      'description',
      'durationMinutes',
      'maxStudents',
      'minRate',
      'minStudents',
      'roomCost',
      'startTime',
      'targetRate',
      'teacherRoomId',
    ]);
  });
});

describe('updateClassSchema', () => {
  it('accepts partial payloads — the undefined guards on refinements are load-bearing', () => {
    // A locked-class save omits all economic fields; dropping the
    // `=== undefined` guards would fail every such save.
    expect(updateClassSchema.safeParse({ description: 'Bring a mat.' }).success).toBe(true);
    expect(updateClassSchema.safeParse({ minRate: 30 }).success).toBe(true);
  });

  it('rejects economic inversions when both sides are present', () => {
    expect(updateClassSchema.safeParse({ minRate: 30, targetRate: 20 }).success).toBe(false);
    expect(updateClassSchema.safeParse({ minStudents: 8, maxStudents: 4 }).success).toBe(false);
  });

  it('rejects unknown fields — the schema is strict', () => {
    expect(updateClassSchema.safeParse({ status: 'completed' }).success).toBe(false);
  });

  // Guards the teacher-editable allowlist in class-lifecycle.ts from the one
  // drift its compile-time pins cannot see. Those pins compare the allowlist
  // against `keyof ClassUpdateData`, and that type re-adds `date` via an
  // intersection — so `date` is in `keyof` whether or not this schema declares
  // it, and dropping it here leaves both pins green. Reading the real schema
  // object catches it, and names the field.
  //
  // A failure here is a decision, not a chore: adding a key means granting
  // teachers write access to that column. Read the allowlist's doc comment
  // before updating this list.
  it('accepts exactly the teacher-editable field set', () => {
    expect(Object.keys(updateClassSchema.shape).sort()).toEqual([
      'classType',
      'date',
      'description',
      'durationMinutes',
      'maxStudents',
      'minRate',
      'minStudents',
      'roomCost',
      'startTime',
      'targetRate',
    ]);
  });
});

describe('updateClassTemplateSchema', () => {
  // Mirrors the updateClassSchema key-set test. Less load-bearing here —
  // ClassTemplateUpdateData is a straight z.infer with no intersection, so the
  // reverse pin has no blind spot to compensate for — but it fails naming the
  // field, and it guards against someone introducing an intersection later.
  //
  // A failure here is a decision, not a chore: adding a key grants teachers
  // write access to that column. Read the allowlist's doc comment in
  // class-template-lifecycle.ts before updating this list.
  it('accepts exactly the teacher-editable field set', () => {
    expect(Object.keys(updateClassTemplateSchema.shape).sort()).toEqual([
      'autoCancelCheck',
      'cancelDeadline',
      'classType',
      'dayOfWeek',
      'description',
      'durationMinutes',
      'maxStudents',
      'minRate',
      'minStudents',
      'roomCost',
      'startTime',
      'targetRate',
      'teacherRoomId',
    ]);
  });
});

describe('updateTeacherSchema.defaultTimezone', () => {
  it('accepts zones Intl can resolve', () => {
    expect(updateTeacherSchema.safeParse({ defaultTimezone: 'Europe/Amsterdam' }).success).toBe(true);
    expect(updateTeacherSchema.safeParse({ defaultTimezone: 'UTC' }).success).toBe(true);
  });

  it('accepts legacy aliases — the reason for the construct-probe over supportedValuesOf', () => {
    expect(updateTeacherSchema.safeParse({ defaultTimezone: 'Europe/Kiev' }).success).toBe(true);
  });

  it('rejects strings Intl cannot resolve', () => {
    expect(updateTeacherSchema.safeParse({ defaultTimezone: 'Not/AZone' }).success).toBe(false);
    expect(updateTeacherSchema.safeParse({ defaultTimezone: '' }).success).toBe(false);
  });
});

describe('updateStudentSchema.incomeTier', () => {
  it('accepts every tier in range', () => {
    for (const tier of [1, 2, 3, 4, 5]) {
      expect(updateStudentSchema.safeParse({ incomeTier: tier }).success).toBe(true);
    }
  });

  it('rejects out-of-range and non-integer tiers', () => {
    for (const bad of [0, 6, -1, 3.5]) {
      expect(updateStudentSchema.safeParse({ incomeTier: bad }).success).toBe(false);
    }
  });

  it('keeps a message that names the range', () => {
    // A literal union would say "invalid literal value" instead. The wire
    // type is narrowed with .refine precisely to keep this readable.
    const result = updateStudentSchema.safeParse({ incomeTier: 9 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('1-5');
    }
  });
});

describe('updateTeacherSchema.pageSlug', () => {
  it('rejects reserved slugs on update, not just on signup', () => {
    expect(updateTeacherSchema.safeParse({ pageSlug: 'settings' }).success).toBe(false);
    expect(updateTeacherSchema.safeParse({ pageSlug: 'api' }).success).toBe(false);
    expect(updateTeacherSchema.safeParse({ pageSlug: 'updates' }).success).toBe(false);
    expect(updateTeacherSchema.safeParse({ pageSlug: 'my-yoga' }).success).toBe(true);
  });
});
