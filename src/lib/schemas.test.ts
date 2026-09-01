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
  createRoomSchema,
  updateClassSchema,
  updateClassTemplateSchema,
  updateStudioClassTemplateSchema,
  updateTeacherSchema,
  updateStudentSchema,
  isSafeRelativePath,
  MAX_CLASS_SIZE,
  requireNormalised,
  pageSlugField,
} from './schemas';
import type { NoneOf } from './type-pins';

describe('transitionClassSchema', () => {
  it('accepts legal manual transitions', () => {
    for (const status of ['draft', 'open', 'in_progress']) {
      expect(transitionClassSchema.safeParse({ status }).success).toBe(true);
    }
  });

  it("rejects 'cancelled' — it is not a status, and has a door of its own", () => {
    // #327. Cancellation is `CalendarEntry.cancelledAt`, reached through
    // `POST /api/classes/[id]/cancel`; there is no target status to transition
    // to, and accepting the word here would name a value `ClassStatus` does
    // not have.
    expect(transitionClassSchema.safeParse({ status: 'cancelled' }).success).toBe(false);
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

describe('isoDate (via updateClassSchema.date)', () => {
  /**
   * The rolled-over calendar date. `new Date('2026-02-31')` is NOT
   * `Invalid Date` — V8 rejects an out-of-range MONTH and silently NORMALISES
   * an out-of-range DAY, so it parses as 2026-03-03. The previous
   * `!Number.isNaN(getTime())` refine therefore accepted it, and
   * `PUT /api/classes/[id]` answered 200 having moved the class three days
   * past the date the caller sent, reporting that as success.
   *
   * `CalendarEntry.date` is the column `reapClosedWaitlistEntries` reads before
   * permanently deletes a class's waitlist, so a silently rewritten value here
   * is not a cosmetic wrong answer — it is a date nobody chose deciding what
   * gets deleted.
   *
   * February is not the only case and the table says so: 31 April, 31 June and
   * 31 November roll the same way, and the leap-year pair is included because
   * a naive "day <= 31" check would pass 2026-02-29 while the calendar does
   * not — and 2028 is a leap year, so the same string is legal two years
   * later. Any implementation that special-cases lengths rather than
   * round-tripping fails at least one row here.
   */
  it.each([
    ['2026-02-31', 'February has no 31st'],
    ['2026-02-30', 'nor a 30th'],
    ['2026-02-29', '2026 is not a leap year'],
    ['2026-04-31', 'April has 30 days'],
    ['2026-06-31', 'June has 30 days'],
    ['2026-11-31', 'November has 30 days'],
  ])('rejects %s — %s', (date) => {
    expect(updateClassSchema.safeParse({ date }).success).toBe(false);
  });

  it.each([
    ['2026-02-28', 'the last real day of a non-leap February'],
    ['2028-02-29', 'a real leap day'],
    ['2026-01-31', 'a genuine 31st'],
    ['2026-12-31', 'the last day of a year'],
  ])('still accepts %s — %s', (date) => {
    expect(updateClassSchema.safeParse({ date }).success).toBe(true);
  });

  /**
   * The regex conjunct, which the round-trip alone does not cover: a
   * `Date`-parseable string in another format would round-trip to a different
   * string and be rejected for the wrong reason, so both halves are pinned
   * rather than one standing in for the other.
   */
  it.each(['2026-6-01', '06/01/2026', '2026-06-01T00:00:00Z', 'tomorrow'])(
    'rejects %s — not YYYY-MM-DD',
    (date) => {
      expect(updateClassSchema.safeParse({ date }).success).toBe(false);
    },
  );
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

describe('updateStudioClassTemplateSchema', () => {
  // Mirrors the updateClassTemplateSchema key-set test above, and exists for
  // the reason #114 measured: `.strict()` means an undeclared key is a 400, so
  // the ONLY way a forbidden column reaches `studioClassTemplate.update` is by
  // being declared here. A failure below is therefore a decision, not a chore.
  //
  // Read `PlainUpdateForbiddenStudioTemplateField`'s doc comment in
  // `studio-class-template-lifecycle.ts` before adding a key. Adding one that
  // names a column on that list is refused by a compile-time pin, not by this
  // test — this test is what makes an *authorized* addition deliberate.
  it('accepts exactly the teacher-editable field set', () => {
    expect(Object.keys(updateStudioClassTemplateSchema.shape).sort()).toEqual([
      'classType',
      'dayOfWeek',
      'durationMinutes',
      'hourlyRate',
      'location',
      'startTime',
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

describe('pageSlugField', () => {
  it('accepts lowercase alphanumeric with hyphens', () => {
    expect(pageSlugField.parse('anna-devries')).toBe('anna-devries');
  });

  it('rejects uppercase and spaces', () => {
    expect(() => pageSlugField.parse('Anna DeVries')).toThrow();
  });

  // 'signup' is new here: a static /signup route shadows any teacher who
  // claimed it, because a static segment beats the [slug] dynamic one.
  it.each(['signup', 'login', 'schedule', 'api'])('rejects the reserved slug %s', (slug) => {
    expect(() => pageSlugField.parse(slug)).toThrow('This slug is reserved');
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
 *
 * `isActive`, `createdAt` and `updatedAt` were added by #114. `isActive` is the
 * one with teeth: it exists on exactly two models (`ClassTemplate`,
 * `StudioClassTemplate`), and on both a plain `PUT` flipping it would bypass
 * the transaction-and-generate path `PATCH` owns. Both template families now
 * also refuse it at compile time, so this is the generalisation — it covers
 * every schema in the repo, including ones nobody has written yet. Measured
 * when added: no exported schema declared any of the three, so none needed an
 * EXPECTED entry.
 *
 * `createdAt` and `updatedAt` are a different kind of entry from every other
 * name here, and that is worth stating rather than leaving to be noticed.
 * The other twenty-two encode AUTHORIZATION — a client must not set this
 * column. These two encode PRISMA HYGIENE. They are also the two most widely
 * present columns in the schema and the two likeliest in this repo to arrive
 * later as a legitimate top-level request key: a keyset-pagination cursor, a
 * date-range filter, an optimistic-concurrency token. Each such arrival gets
 * repaired by an EXPECTED entry — which is the reflexive grant this register
 * is criticised for inviting, in the very docblock of
 * `PlainUpdateForbiddenStudioTemplateField`. Kept because nothing declares
 * them today and the cost of the first legitimate one is a reviewed EXPECTED
 * line, not a silent hole; recorded because that trade is real and runs the
 * other way from `isActive`'s.
 */
const SERVER_OWNED_FIELDS = [
  'accountId', 'archivedAt', 'cancelledAt', 'claimedAt', 'createdAt',
  'createdById', 'date', 'effectiveTeacherRate', 'id', 'isActive', 'isArchived',
  'isPublic', 'kind', 'paidAt', 'photoUrl', 'scheduleRuleId', 'settingsLocked',
  'status', 'studentId', 'teacherId', 'tierAtBooking',
  'tierSelectedAt', 'totalRevenue', 'totalStudents', 'updatedAt',
  'withdrawnCount',
] as const;

// Every name above must be a real column on one of the models in this union.
// Without this a typo would sit in the list protecting nothing while looking
// like protection. Fails naming the offender. A legitimate server-owned name
// that lives only on a model outside this union (e.g. TeacherStudent,
// Session) would fail this pin too — the fix there is to grow the union, not to
// delete the name.
//
// The union is deliberately wider than the names currently registered: a model
// missing here is an obstacle to *adding* a legitimate name later
// (WaitlistEntry.position, Notification.readAt), because the addition would
// fail this pin and read as a typo.
//
// `ScheduleRule` (issue 298) is what makes `isActive`/`isArchived`/
// `archivedAt`/`withdrawnCount`/`teacherId` still real columns here: all five
// left `ClassTemplate`/`StudioClassTemplate` for it.
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
  | keyof Prisma.TeacherRoomUncheckedUpdateManyInput
  | keyof Prisma.ScheduleRuleUncheckedUpdateManyInput
  | keyof Prisma.CalendarEntryUncheckedUpdateManyInput;

const _serverOwnedNamesExist: NoneOf<
  Exclude<(typeof SERVER_OWNED_FIELDS)[number], AnyModelKey>
> = true;
void _serverOwnedNamesExist;

/**
 * Every schema that legitimately declares one, and why. Some are marked
 * KNOWN GAP rather than endorsements — they are recorded here, beside the
 * guard, so the next person to touch that schema reads the gap instead of
 * rediscovering it.
 */
const EXPECTED: Record<string, readonly string[]> = {
  // The client books the class onto a calendar day. `date` is `@db.Date`:
  // the schema validates the YYYY-MM-DD string, and the create handler passes
  // it through `new Date(...)` (UTC midnight) before Prisma sees it.
  createClassSchema: ['date'],
  // A teacher registers a student from their own roster; ownership is checked
  // in src/app/api/registrations/route.ts:87-92 (the TeacherStudent link is
  // looked up and a missing link 403s before the registration is created).
  createRegistrationSchema: ['studentId'],
  // Whether a newly created room is shared is legitimately the creator's call.
  createRoomSchema: ['isPublic'],
  // A manual studio row is booked onto a calendar day, same shape as the
  // class family above: validated as a string, handed to Prisma as UTC
  // midnight by the create route.
  createStudioClassSchema: ['date'],
  // This schema *is* the state machine's input. 'completed' is deliberately
  // absent so completion must go through the route that runs pricing.
  transitionClassSchema: ['status'],
  // Admitted with #194's edit screen: moving a class to another day is the
  // point of the screen. Same transform as its create twin — the route turns
  // the validated string into a Date before the service write.
  updateClassSchema: ['date'],
  // The student chooses which teacher's settings to change. The TeacherStudent
  // link is checked in the route as of this branch.
  updatePrivacySchema: ['teacherId'],
  // Attendance status on the teacher's own class.
  updateRegistrationSchema: ['status'],
  // KNOWN GAP: a client can backdate or null a cancellation timestamp (forward-
  // dating is clamped to now by the route; issue 277). Ownership is checked, so
  // the blast radius is the teacher's own bookkeeping.
  //
  // Both names here are TRANSFORMED SERVER-SIDE: each arrives over HTTP as a
  // string and becomes a Date only inside the PUT route
  // (`cancelledAt ? new Date(Math.min(new Date(cancelledAt).getTime(), now.getTime())) : null`; `new Date(dateString)`),
  // which is why neither can be validated at rest against the column. `date`
  // joined under #276/D2, gated there to manual, not-yet-past rows.
  updateStudioClassSchema: ['cancelledAt', 'date'],
  // KNOWN GAP: no form sends it and nothing renders it. Latent until someone
  // adds the <img>. Blocked on #46.
  updateTeacherSchema: ['photoUrl'],
};

// Exports that are ZodType but not ZodObject — a single field's validator,
// shared so the client runs the same rule the server does. No top-level keys
// to hide a server-owned name behind, so the loop below skips them by name
// instead of by shape: a schema that starts here and gains an object shape
// later must be removed from this set for the loop to see it again.
const FIELD_VALIDATOR_EXPORTS = new Set(['pageSlugField']);

describe('server-owned fields', () => {
  // The register is only as good as the list it walks, and the exact-equality
  // assertion below cannot see a name that is gone: several of these appear in
  // no EXPECTED entry, so deleting one changes neither side of the comparison.
  // This pin is the only thing that makes shortening the list fail — and it
  // did its job in #327, which dropped `templateId` (the field #146 and #148
  // are about) from the register because the column left the schema with
  // `Class.templateId`/`StudioClass.templateId`. `scheduleRuleId` is what a
  // client must not set now, and it was already here.
  it('is the curated list, changed deliberately', () => {
    expect([...SERVER_OWNED_FIELDS].sort()).toEqual([
      'accountId',
      'archivedAt',
      'cancelledAt',
      'claimedAt',
      'createdAt',
      'createdById',
      'date',
      'effectiveTeacherRate',
      'id',
      'isActive',
      'isArchived',
      'isPublic',
      'kind',
      'paidAt',
      'photoUrl',
      'scheduleRuleId',
      'settingsLocked',
      'status',
      'studentId',
      'teacherId',
      'tierAtBooking',
      'tierSelectedAt',
      'totalRevenue',
      'totalStudents',
      'updatedAt',
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
      // those wrappers left the suite fully green. (`templateId` is no longer
      // a column anywhere; the measurement is a record of what the blindness
      // cost, not a claim about today's register.)
      if (!(schema instanceof z.ZodType)) continue;
      if (FIELD_VALIDATOR_EXPORTS.has(name)) continue;
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

  it('covers exactly the schemas that carry an address', () => {
    expect([...emailBearing].sort()).toEqual([
      'createInvitationSchema',
      'createTeacherSchema',
      'magicLinkSendSchema',
      'passkeyAuthOptionsSchema',
      'studentSignupSchema',
      'teacherSignupSchema',
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

// #73. The schema default and the column default (Task 1) are belt and
// braces, and they mask each other: with the column defaulting false,
// removing this default changes nothing observable through the API. So each
// is tested at its own level — this one here, the column in
// tests/integration/room-default-privacy.test.ts. A single end-to-end
// assertion would pass with either layer removed and certify neither.
describe('createRoomSchema isPublic default', () => {
  it('defaults a room to private when the field is omitted', () => {
    const parsed = createRoomSchema.parse({
      venueName: 'Somewhere',
      address: 'Street 1',
      city: 'Amsterdam',
      postcode: '1234AB',
      maxCapacity: 10,
    });
    expect(parsed.isPublic).toBe(false);
  });

  it('still honours an explicit true', () => {
    const parsed = createRoomSchema.parse({
      venueName: 'Somewhere',
      address: 'Street 1',
      city: 'Amsterdam',
      postcode: '1234AB',
      maxCapacity: 10,
      isPublic: true,
    });
    expect(parsed.isPublic).toBe(true);
  });
});

describe('classType and location whitespace trimming and validation (#311)', () => {
  const classTypeSchemas = [
    'createClassSchema',
    'updateClassSchema',
    'createClassTemplateSchema',
    'updateClassTemplateSchema',
    'createStudioClassTemplateSchema',
    'updateStudioClassTemplateSchema',
    'createStudioClassSchema',
    'updateStudioClassSchema',
  ] as const;

  const locationSchemas = [
    'createStudioClassTemplateSchema',
    'updateStudioClassTemplateSchema',
    'createStudioClassSchema',
    'updateStudioClassSchema',
  ] as const;

  it('covers exactly the eight schemas carrying classType', () => {
    const discovered: string[] = [];
    for (const [name, schema] of Object.entries(schemas)) {
      if (!(schema instanceof z.ZodType)) continue;
      const shape =
        (schema as { shape?: Record<string, unknown> }).shape ??
        (schema as { _def?: { schema?: { shape?: Record<string, unknown> } } })._def?.schema?.shape;
      if (!shape || !('classType' in shape)) continue;
      discovered.push(name);
    }
    expect(discovered.sort()).toEqual([...classTypeSchemas].sort());
  });

  it('covers exactly the four schemas carrying studio location', () => {
    const discovered: string[] = [];
    for (const [name, schema] of Object.entries(schemas)) {
      if (!(schema instanceof z.ZodType)) continue;
      const shape =
        (schema as { shape?: Record<string, unknown> }).shape ??
        (schema as { _def?: { schema?: { shape?: Record<string, unknown> } } })._def?.schema?.shape;
      if (!shape || !('location' in shape)) continue;
      discovered.push(name);
    }
    expect(discovered.sort()).toEqual([...locationSchemas].sort());
  });

  it.each(classTypeSchemas)('%s rejects empty and whitespace-only classType', (name) => {
    const schema = (schemas as Record<string, unknown>)[name] as z.ZodType;
    const shape =
      (schema as { shape?: Record<string, z.ZodType> }).shape ??
      (schema as { _def?: { schema?: { shape?: Record<string, z.ZodType> } } })._def?.schema?.shape;
    const field = shape?.classType;
    expect(field).toBeDefined();
    expect(field!.safeParse('').success).toBe(false);
    expect(field!.safeParse('   ').success).toBe(false);
    expect(field!.safeParse('\t\n  ').success).toBe(false);
  });

  it.each(classTypeSchemas)('%s trims padded classType before validation and storage', (name) => {
    const schema = (schemas as Record<string, unknown>)[name] as z.ZodType;
    const shape =
      (schema as { shape?: Record<string, z.ZodType> }).shape ??
      (schema as { _def?: { schema?: { shape?: Record<string, z.ZodType> } } })._def?.schema?.shape;
    const field = shape?.classType;
    expect(field).toBeDefined();
    expect(field!.parse('  Vinyasa Flow  ')).toBe('Vinyasa Flow');
  });

  it.each(locationSchemas)('%s rejects empty and whitespace-only location', (name) => {
    const schema = (schemas as Record<string, unknown>)[name] as z.ZodType;
    const shape =
      (schema as { shape?: Record<string, z.ZodType> }).shape ??
      (schema as { _def?: { schema?: { shape?: Record<string, z.ZodType> } } })._def?.schema?.shape;
    const field = shape?.location;
    expect(field).toBeDefined();
    expect(field!.safeParse('').success).toBe(false);
    expect(field!.safeParse('   ').success).toBe(false);
    expect(field!.safeParse('\t\n  ').success).toBe(false);
  });

  it.each(locationSchemas)('%s trims padded location before validation and storage', (name) => {
    const schema = (schemas as Record<string, unknown>)[name] as z.ZodType;
    const shape =
      (schema as { shape?: Record<string, z.ZodType> }).shape ??
      (schema as { _def?: { schema?: { shape?: Record<string, z.ZodType> } } })._def?.schema?.shape;
    const field = shape?.location;
    expect(field).toBeDefined();
    expect(field!.parse('  Studio Centrum  ')).toBe('Studio Centrum');
  });
});
