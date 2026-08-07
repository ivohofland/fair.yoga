import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import * as schemas from './schemas';
import {
  transitionClassSchema,
  magicLinkSendSchema,
  passkeyAuthVerifySchema,
  createClassSchema,
  createStudioClassSchema,
  updateClassSchema,
  updateClassTemplateSchema,
  updateTeacherSchema,
  updateStudentSchema,
  isSafeRelativePath,
  MAX_CLASS_SIZE,
  requireNormalised,
} from './schemas';
import type { NoneOf } from './type-pins';

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
  // A failure here is a decision, not a chore: the handler now names every
  // field it writes, so a new key here is inert until the handler is edited
  // too — but it means a client may send that name, and it is one handler edit
  // away from being written.
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

describe('createStudioClassSchema', () => {
  // #148. templateId and studentCount reached prisma.studioClass.create through
  // a rest spread, so neither name appeared in the handler at all.
  it('accepts exactly the client-settable studio create field set', () => {
    expect(Object.keys(createStudioClassSchema.shape).sort()).toEqual([
      'classType',
      'date',
      'durationMinutes',
      'hourlyRate',
      'location',
      'startTime',
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

/**
 * Field names the server owns. A schema declaring one of these is saying a
 * client may set that column — which is occasionally right and usually a
 * defect, so every instance has to be named in EXPECTED below with a reason.
 *
 * This exists because the per-form pins in the two create wizards are opt-in: a
 * new route with a new form carries no protection until someone remembers to
 * write one. #146 and #148 were both server-set `templateId` reaching a Prisma
 * create from a request body — found 45 minutes apart by the same sweep, on two
 * routes that had no reason to be compared. This is the create-side counterpart
 * to `PlainUpdateForbiddenClassField` (`src/services/class-lifecycle.ts`).
 *
 * Scope: the guard below reads the top-level `.shape` keys of schemas exported
 * from `src/lib/schemas.ts` — every schema in this repo is declared there. A
 * server-owned name nested inside a sub-object (rather than a top-level key)
 * would not be seen by `Object.keys(shape)`.
 *
 * Curation: `SERVER_OWNED_FIELDS` below is hand-curated, not derived from the
 * Prisma schema. A newly added server-set column is not covered until someone
 * adds its name here — nothing pins this list against the full set of
 * server-set columns across the models it draws from.
 *
 * Out of scope entirely: client-supplied cross-tenant foreign keys such as
 * `classId`, `roomId` and `teacherRoomId`. Those are legitimately client-set on
 * eight schemas (createClassSchema, createClassTemplateSchema,
 * updateClassTemplateSchema, createTeacherRoomSchema, createRegistrationSchema,
 * createWaitlistSchema, claimWaitlistSchema, createAnnouncementSchema), so this
 * register doesn't — and shouldn't — name them. A new route that accepts one of
 * those with no ownership check would pass this guard.
 */
const SERVER_OWNED_FIELDS = [
  'accountId', 'archivedAt', 'cancelledAt', 'claimedAt', 'createdById',
  'effectiveTeacherRate', 'id', 'isArchived', 'isPublic', 'paidAt', 'photoUrl',
  'settingsLocked', 'status', 'studentId', 'teacherId', 'templateId',
  'tierAtBooking', 'tierSelectedAt', 'totalRevenue', 'totalStudents',
  'withdrawnCount',
] as const;

// Every name above must be a real column on one of the fourteen models in this
// union. Without this a typo would sit in the list protecting nothing while
// looking like protection. Fails naming the offender. A legitimate server-owned
// name that lives only on a model outside this union (e.g. TeacherStudent,
// Session) would fail this pin too — the fix there is to grow the union, not to
// delete the name.
//
// The union is deliberately wider than the names currently registered: a model
// missing here is an obstacle to *adding* a legitimate name later
// (WaitlistEntry.position, Notification.readAt), because the addition would
// fail this pin and read as a typo.
type AnyModelKey =
  | keyof Prisma.ClassUncheckedUpdateManyInput
  | keyof Prisma.StudioClassUncheckedUpdateManyInput
  | keyof Prisma.StudentUncheckedUpdateManyInput
  | keyof Prisma.TeacherUncheckedUpdateManyInput
  | keyof Prisma.RoomUncheckedUpdateManyInput
  | keyof Prisma.RegistrationUncheckedUpdateManyInput
  | keyof Prisma.PaymentUncheckedUpdateManyInput
  | keyof Prisma.ClassTemplateUncheckedUpdateManyInput
  | keyof Prisma.WaitlistEntryUncheckedUpdateManyInput
  | keyof Prisma.NotificationUncheckedUpdateManyInput
  | keyof Prisma.AnnouncementUncheckedUpdateManyInput
  | keyof Prisma.StudentPrivacyUncheckedUpdateManyInput
  | keyof Prisma.StudioClassTemplateUncheckedUpdateManyInput
  | keyof Prisma.TeacherRoomUncheckedUpdateManyInput;

const _serverOwnedNamesExist: NoneOf<
  Exclude<(typeof SERVER_OWNED_FIELDS)[number], AnyModelKey>
> = true;
void _serverOwnedNamesExist;

/**
 * Every schema that legitimately declares one, and why. Three of these are
 * known gaps rather than endorsements — they are recorded here, beside the
 * guard, so the next person to touch that schema reads the gap instead of
 * rediscovering it.
 */
const EXPECTED: Record<string, readonly string[]> = {
  // A teacher registers a student from their own roster; ownership is checked
  // in src/app/api/registrations/route.ts:87-92 (the TeacherStudent link is
  // looked up and a missing link 403s before the registration is created).
  createRegistrationSchema: ['studentId'],
  // Whether a newly created room is shared is legitimately the creator's call.
  createRoomSchema: ['isPublic'],
  // This schema *is* the state machine's input. 'completed' is deliberately
  // absent so completion must go through the route that runs pricing.
  transitionClassSchema: ['status'],
  // The student chooses which teacher's settings to change. The TeacherStudent
  // link is checked in the route as of this branch.
  updatePrivacySchema: ['teacherId'],
  // Attendance status on the teacher's own class.
  updateRegistrationSchema: ['status'],
  // KNOWN GAP: no form sends it, and flipping it true is a one-way door — the
  // room can then no longer be edited or deleted, and any teacher may attach.
  // Blocked on #73's isPublic product decision.
  updateRoomSchema: ['isPublic'],
  // KNOWN GAP: a client can backdate, forward-date or null a cancellation
  // timestamp. Ownership is checked, so the blast radius is the teacher's own
  // bookkeeping.
  updateStudioClassSchema: ['cancelledAt'],
  // KNOWN GAP: no form sends it and nothing renders it. Latent until someone
  // adds the <img>. Blocked on #46.
  updateTeacherSchema: ['photoUrl'],
};

describe('server-owned fields', () => {
  // The register is only as good as the list it walks, and the exact-equality
  // assertion below cannot see a name that is gone: ten of these appear in no
  // EXPECTED entry, so deleting one changes neither side of the comparison.
  // templateId — the field #146 and #148 are about — is one of them. This pin
  // is the only thing that makes shortening the list fail.
  it('is the curated list, changed deliberately', () => {
    expect([...SERVER_OWNED_FIELDS].sort()).toEqual([
      'accountId',
      'archivedAt',
      'cancelledAt',
      'claimedAt',
      'createdById',
      'effectiveTeacherRate',
      'id',
      'isArchived',
      'isPublic',
      'paidAt',
      'photoUrl',
      'settingsLocked',
      'status',
      'studentId',
      'teacherId',
      'templateId',
      'tierAtBooking',
      'tierSelectedAt',
      'totalRevenue',
      'totalStudents',
      'withdrawnCount',
    ]);
  });

  it('are declared only where EXPECTED says so, and everywhere it says so', () => {
    const actual: Record<string, string[]> = {};

    for (const [name, schema] of Object.entries(schemas)) {
      // Two different facts hide behind a missing `.shape`, and only one is
      // safe to skip: "this export is not a schema" (MAX_CLASS_SIZE,
      // isSafeRelativePath) versus "this export IS a schema whose top-level
      // keys I cannot read" (anything wrapped in .transform(), z.union or
      // z.array). Conflating them made this guard blind in exactly the way the
      // three guards this repo has shipped were blind — measured: three
      // exported schemas declaring teacherId, studentId and templateId behind
      // those wrappers left the suite fully green.
      if (!(schema instanceof z.ZodType)) continue;
      const shape = (schema as { shape?: Record<string, unknown> }).shape;
      expect(
        shape,
        `${name} is a schema whose top-level keys this register cannot read — unwrap it or extend the register`,
      ).toBeDefined();
      // Unreachable — the assertion above throws first. Present so the compiler
      // can narrow `shape` away from `undefined`.
      if (!shape) continue;
      const hits = Object.keys(shape)
        .filter((k) => (SERVER_OWNED_FIELDS as readonly string[]).includes(k))
        .sort();
      if (hits.length > 0) actual[name] = hits;
    }

    const expected = Object.fromEntries(
      Object.entries(EXPECTED).map(([k, v]) => [k, [...v].sort()]),
    );

    // Exact equality in both directions. A new declaration fails naming the
    // schema; deleting a legitimate one fails too, so an entry cannot be
    // silently dropped. That is all this pins: it compares key sets and field
    // arrays and never reads the `//` prose, so a reason can go stale — or a
    // pointer inside one can rot — with this test still green. Two of them did
    // exactly that on this branch, caught only by human review.
    expect(
      actual,
      'A schema declares a server-owned field. Either stop declaring it, or add it to EXPECTED with a reason. See the docblock above.',
    ).toEqual(expected);
  });
});

describe('email fields normalise', () => {
  // Exhaustive by construction: walks every export rather than a hand-kept
  // list, so a new schema with an `email` field is covered the moment it is
  // written. The roster assertion below is what makes adding one a deliberate
  // act rather than a silent opt-out.
  //
  // Asserts against `shape.email` — the field schema — not the parent object,
  // because parsing the parent would need valid values for every sibling
  // required field and would test those instead.
  const emailBearing: string[] = [];

  for (const [name, schema] of Object.entries(schemas)) {
    if (!(schema instanceof z.ZodType)) continue;
    const shape = (schema as { shape?: Record<string, unknown> }).shape;
    if (!shape || !('email' in shape)) continue;
    emailBearing.push(name);
  }

  it('covers exactly the six schemas that carry an address', () => {
    expect([...emailBearing].sort()).toEqual([
      'createInvitationSchema',
      'createTeacherSchema',
      'magicLinkSendSchema',
      'passkeyAuthOptionsSchema',
      'studentSignupSchema',
      'updateInvitationSchema',
    ]);
  });

  it.each(emailBearing)('%s lowercases its email field', (name) => {
    const schema = (schemas as Record<string, unknown>)[name];
    const shape = (schema as { shape: Record<string, unknown> }).shape;
    const field = shape.email as z.ZodType<unknown, unknown>;
    expect(field.parse('Mixed@Example.COM')).toBe('mixed@example.com');
  });
});

describe('requireNormalised', () => {
  // The only guard on this branch nobody has broken (#170 whole-branch
  // review, item 6) — three test files (`invitations.pending.test.ts`,
  // `invitations.revive.test.ts`, `invitations.notify.test.ts`) pattern-match
  // on `/un-normalised/` in the thrown message, so that message is
  // load-bearing and was otherwise unpinned by a direct test of its own.
  it('returns a lowercase address unchanged', () => {
    expect(requireNormalised('already-lower@example.com')).toBe('already-lower@example.com');
  });

  it('throws on a mixed-case address, matching /un-normalised/', () => {
    expect(() => requireNormalised('Mixed@Example.com')).toThrow(/un-normalised/);
  });
});
