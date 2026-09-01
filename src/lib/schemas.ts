import { z } from 'zod';
import { isIncomeTier } from '@/lib/tiers';
import { isValidTimeZone } from '@/lib/iana-timezone';

// ---------------------------------------------------------------------------
// Shared field validators
// ---------------------------------------------------------------------------

/**
 * ISO calendar date (YYYY-MM-DD) that names a day that exists.
 *
 * Round-tripped, not `Number.isNaN`-checked. V8 rejects an out-of-range MONTH
 * (`2026-13-01` is `Invalid Date`) but silently NORMALISES an out-of-range
 * DAY: `new Date('2026-02-31')` is `2026-03-03`. So the NaN check validated
 * roughly the right shape and the wrong semantics — `PUT {"date":
 * "2026-02-31"}` answered 200 having moved the class to a day the caller
 * never sent, and reported that as success.
 *
 * This is `CalendarEntry.date` among others, the column
 * `waitlist-retention.ts` reads before it permanently deletes a class's
 * waitlist, so a silently rewritten value here is not a cosmetic wrong answer.
 */
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD')
  .refine((s) => {
    const parsed = new Date(s);
    if (Number.isNaN(parsed.getTime())) return false;
    // The string is already known to be `YYYY-MM-DD`, and `new Date` on that
    // form parses as UTC midnight, so `toISOString()` returns the same
    // calendar day it was given — unless the day was rolled forward.
    return parsed.toISOString().slice(0, 10) === s;
  }, 'Invalid date');

/** Wall-clock time, 00:00-23:59. */
const timeHHmm = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Must be HH:mm (00:00-23:59)');

/**
 * Every email that enters over HTTP, lowercased once (#170).
 *
 * Postgres compares these columns case-sensitively under `en_US.utf8`, and the
 * unique keys on Account/Teacher/Student are plain btree over the raw column —
 * so without this, `Foo@x.com` and `foo@x.com` are two distinct keys. That cost
 * a person their sign-in (the lookup misses and the route still answers "if an
 * account exists, a magic link has been sent") and could hand them a second
 * Account with their bookings split across both.
 *
 * Field-level, deliberately: an object-level `.transform()` would remove the
 * schema's `.shape` and blind the server-owned-field walk in `schemas.test.ts`.
 * A field-level one does not — measured against Zod 4.4.3, `.shape` stays
 * readable and the walk still sees every key.
 *
 * This normalises HTTP ingress only. Writers that bypass Zod — `prisma/seed.ts`,
 * `gdpr.ts`'s anonymisation, raw SQL — are not normalised, they are rejected by
 * the `*_email_lowercase_check` constraints. That asymmetry is intentional: a
 * writer that skips the schema layer should fail loudly, not be quietly fixed.
 *
 * Module-private, like `isoDate`, `timeHHmm` and `relativePath` elsewhere in
 * this file. Exporting it fails the server-owned-field walk in
 * `schemas.test.ts`, which requires every exported `ZodType` to have a
 * readable `.shape` — a field primitive has none. That walk is right to
 * refuse to guess, and nothing outside this file validates an email, so the
 * export bought nothing.
 */
const emailField = z.string().email().transform((s) => s.toLowerCase());

/**
 * Assert what every caller already guarantees (#170).
 *
 * Never fires in production: an address reaches these services either through
 * `emailField` above (HTTP) or straight out of a `*_email_lowercase_check`
 * column (Account, Student). A census at the time of writing found 8 call sites
 * and no ninth source — there is deliberately no email-change flow
 * (`Account`'s own docblock, `prisma/schema.prisma`).
 *
 * It exists for the ninth caller. These functions compare addresses with
 * case-SENSITIVE `findUnique` lookups, so an un-normalised argument does not
 * throw — it silently matches nothing. `notifyInvitee` is the sharp case: a miss
 * on `TeacherBlock` sends an invitation to the exact person who blocked that
 * teacher. This turns that silence into a stack trace.
 *
 * It asserts the invariant; it does not re-implement it. Normalising here would
 * put the rule in three places, which is what #170 set out to end.
 */
export function requireNormalised(email: string): string {
  if (email !== email.toLowerCase()) {
    throw new Error(
      `email reached this service un-normalised. Callers source it from ` +
        `emailField (HTTP) or a *_email_lowercase_check column (DB); a new ` +
        `caller must do the same.`,
    );
  }
  return email;
}

/**
 * Upper bound for min/max students. Generous for any real class, and a hard
 * ceiling for the price-estimate tables the public booking page renders per
 * seat — unbounded values would let anyone allocate absurd arrays there.
 */
export const MAX_CLASS_SIZE = 200;


// ============================================================================
// AUTH
// ============================================================================

// redirect must be a relative path — a full URL here would be an open redirect.
/**
 * Shared by the schema below and the verify-route runtime guard. Rejects
 * protocol-relative URLs (`//evil.com`) and their backslash variants
 * (`/\evil.com` — browsers normalize `\` to `/` before resolving).
 */
export function isSafeRelativePath(path: string): boolean {
  return path.startsWith('/') && !path.startsWith('//') && !path.includes('\\');
}

const relativePath = z.string().max(200).refine(isSafeRelativePath, 'Must be a relative path');

export const magicLinkSendSchema = z.object({
  email: emailField,
  redirect: relativePath.optional(),
});

export const studentSignupSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: emailField,
  redirect: relativePath.optional(),
});

export const magicLinkVerifySchema = z.object({
  token: z.string().min(1),
});

export const passkeyRegisterVerifySchema = z.object({
  response: z.record(z.string(), z.unknown()), // WebAuthn response is complex, validate shape loosely
});

export const passkeyAuthOptionsSchema = z.object({
  email: emailField.optional(),
});

export const passkeyAuthVerifySchema = z.object({
  response: z.record(z.string(), z.unknown()),
  challengeId: z.string().min(1),
  redirect: relativePath.optional(),
});

// ============================================================================
// TEACHERS
// ============================================================================

// App routes the public teacher page must never shadow. A static segment
// beats the `[slug]` dynamic one, so anything listed here would silently
// hide a teacher who had claimed it.
const RESERVED_SLUGS = new Set([
  'login', 'verify', 'signup', 'bookings', 'settings', 'schedule', 'students',
  'inbox', 'class', 'studio-class', 'api', 'health', 'admin', 'account', 'updates',
]);

/**
 * The public page address, `fair.yoga/<pageSlug>`.
 *
 * Exported because the signup form runs it in the browser: one definition
 * means the field cannot accept something the route then rejects.
 */
export const pageSlugField = z
  .string()
  .min(1)
  .regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens')
  .refine((s) => !RESERVED_SLUGS.has(s), 'This slug is reserved');

export const teacherSignupSchema = z.object({ email: emailField }).strict();

// #258: every teacher was hardcoded to Europe/Amsterdam and never asked.
// This is a correctness input, not a display preference — it decides the
// schedule window, both #249 past-start guards, auto-cancel, the completion
// sweep and the reporting cutoff. Optional here so a browser that cannot
// report one still signs up.
const detectedTimezoneField = z.string().refine(isValidTimeZone, 'Unknown timezone');

/**
 * Creates the teacher profile. No `email` field: it comes from the consumed
 * signup ticket or the live session, never from the body — the address must
 * be one the caller has proved they control.
 */
export const teacherProfileSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  bio: z.string().max(250),
  pageSlug: pageSlugField,
  defaultTimezone: detectedTimezoneField.optional(),
}).strict();

export const updateTeacherSchema = z.object({
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  photoUrl: z.string().url().nullable().optional(),
  bio: z.string().max(250).optional(),
  pageSlug: pageSlugField.optional(),
  defaultCurrency: z.string().optional(),
  defaultTimezone: z.string().refine(isValidTimeZone, 'Unknown timezone').optional(),
  defaultReminder: z.enum(['morning_of', 'evening_before', 'one_hour_before']).optional(),
  bankIban: z.string().nullable().optional(),
  bankAccountName: z.string().nullable().optional(),
}).strict();

/** `POST /api/account/onboarding`'s wire shape. */
export const onboardingSkipSchema = z.object({ step: z.enum(['profile', 'bank', 'share']) }).strict();

// ============================================================================
// STUDENTS
// ============================================================================

/**
 * The teacher's CRM contact form. `.strict()`, unlike the create schema it
 * replaces: an unknown key here should be a 400, not silently stripped —
 * this body is the only thing standing between a teacher and a row keyed
 * on someone else's email address.
 */
export const createInvitationSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().optional().default(''),
  email: emailField,
}).strict();

/**
 * `PUT /api/invitations/[id]` (#166). All fields optional — a teacher may
 * fix just a typo'd last name — and `.strict()` for the same reason as the
 * create schema above: an unknown key here is a 400, not a silent drop.
 */
export const updateInvitationSchema = z.object({
  firstName: z.string().min(1).optional(),
  lastName: z.string().optional(),
  email: emailField.optional(),
}).strict();

/**
 * `POST /api/invitations/[id]/respond` (#166). The student's only two
 * moves. `.strict()` for the same reason as the invitation schemas above:
 * an unknown key is a 400, not a silent drop.
 */
export const respondToInvitationSchema = z.object({
  response: z.enum(['accept', 'decline']),
}).strict();

export const updateStudentSchema = z.object({
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  phone: z.string().nullable().optional(),
  birthday: z.string().nullable().optional(), // ISO date string
  address: z.string().nullable().optional(),
  // `.refine` with a type predicate narrows the inferred type to IncomeTier
  // (verified by compiling both directions), so the wire type carries the
  // same constraint as the column and the engine. A literal union would
  // narrow too, but would replace this message with "invalid literal value".
  incomeTier: z.number().int().refine(isIncomeTier, {
    message: 'Income tier must be 1-5',
  }).optional(),
  reminderPref: z.enum(['eve', 'morning', 'one_hour', 'off']).optional(),
  emailNotifications: z.boolean().optional(),
}).strict();

export const updatePrivacySchema = z.object({
  teacherId: z.string().uuid(),
  shareFullName: z.boolean().optional(),
  shareEmail: z.boolean().optional(),
  sharePhone: z.boolean().optional(),
  shareBirthday: z.boolean().optional(),
  shareAddress: z.boolean().optional(),
  receiveComms: z.boolean().optional(),
}).strict();

export const studentListQuerySchema = z.object({
  search: z.string().optional().default(''),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(50).optional().default(20),
});

// ============================================================================
// ROOMS
// ============================================================================

export const createRoomSchema = z.object({
  venueName: z.string().min(1),
  address: z.string().min(1),
  city: z.string().min(1),
  postcode: z.string().min(1),
  floor: z.string().optional().default(''),
  roomName: z.string().optional().default(''),
  maxCapacity: z.number().int().positive(),
  equipment: z.array(z.string()).optional().default([]),
  notes: z.string().nullable().optional(),
  isPublic: z.boolean().optional().default(false),
});

export const updateRoomSchema = z.object({
  venueName: z.string().min(1).optional(),
  address: z.string().min(1).optional(),
  city: z.string().min(1).optional(),
  postcode: z.string().min(1).optional(),
  floor: z.string().optional(),
  roomName: z.string().optional(),
  maxCapacity: z.number().int().positive().optional(),
  equipment: z.array(z.string()).optional(),
  notes: z.string().nullable().optional(),
}).strict();

export const roomSearchQuerySchema = z.object({
  postcode: z.string().optional(),
  street: z.string().optional(),
});

// ============================================================================
// TEACHER ROOMS
// ============================================================================

export const createTeacherRoomSchema = z.object({
  roomId: z.string().uuid(),
  capacityOverride: z.number().int().positive(),
  rentalRate: z.number().nonnegative(),
  equipmentNotes: z.string().nullable().optional(),
});

export const updateTeacherRoomSchema = z.object({
  capacityOverride: z.number().int().positive().optional(),
  rentalRate: z.number().nonnegative().optional(),
  equipmentNotes: z.string().nullable().optional(),
}).strict();

// ============================================================================
// CLASSES
// ============================================================================

export const createClassSchema = z.object({
  teacherRoomId: z.string().uuid(),
  classType: z.string().trim().min(1),
  description: z.string().nullable().optional(),
  date: isoDate,
  startTime: timeHHmm,
  durationMinutes: z.number().int().positive(),
  roomCost: z.number().nonnegative(),
  minRate: z.number(), // can be negative (teacher subsidizes)
  targetRate: z.number(),
  minStudents: z.number().int().positive().max(MAX_CLASS_SIZE),
  maxStudents: z.number().int().positive().max(MAX_CLASS_SIZE),
  cancelDeadline: z.enum(['HOURS_48', 'HOURS_24', 'HOURS_12', 'HOURS_6']).optional(),
  autoCancelCheck: z.enum(['HOURS_4', 'HOURS_2', 'HOURS_1']).optional(),
})
  .refine((d) => d.minStudents <= d.maxStudents, {
    message: 'minStudents cannot exceed maxStudents',
    path: ['minStudents'],
  })
  .refine((d) => d.minRate <= d.targetRate, {
    message: 'minRate cannot exceed targetRate',
    path: ['minRate'],
  })
  .refine((d) => d.minRate >= -d.roomCost, {
    message: 'minRate cannot subsidize more than the room cost — prices would go negative',
    path: ['minRate'],
  });

export const updateClassSchema = z.object({
  classType: z.string().trim().min(1).optional(),
  description: z.string().nullable().optional(),
  date: isoDate.optional(),
  startTime: timeHHmm.optional(),
  durationMinutes: z.number().int().positive().optional(),
  // Economic fields — only accepted when settings not locked (enforced by
  // updateClass in src/services/class-lifecycle.ts)
  roomCost: z.number().nonnegative().optional(),
  minRate: z.number().optional(),
  targetRate: z.number().optional(),
  minStudents: z.number().int().positive().max(MAX_CLASS_SIZE).optional(),
  maxStudents: z.number().int().positive().max(MAX_CLASS_SIZE).optional(),
}).strict()
  .refine((d) => d.minStudents === undefined || d.maxStudents === undefined || d.minStudents <= d.maxStudents, {
    message: 'minStudents cannot exceed maxStudents',
    path: ['minStudents'],
  })
  .refine((d) => d.minRate === undefined || d.targetRate === undefined || d.minRate <= d.targetRate, {
    message: 'minRate cannot exceed targetRate',
    path: ['minRate'],
  });

// 'completed' is deliberately absent: completion must go through
// POST /api/classes/[id]/complete so the pricing engine runs and
// payments + notifications are created. A bare status flip would
// silently skip billing.
//
// 'cancelled' is absent for a different reason (#327): it is not a
// `ClassStatus` at all any more. Cancellation writes
// `CalendarEntry.cancelledAt`, and the regular family reaches it through
// POST /api/classes/[id]/cancel — its own door, because it carries a duty of
// care the studio family's does not.
export const transitionClassSchema = z.object({
  status: z.enum(['draft', 'open', 'in_progress']),
});

// ============================================================================
// CLASS TEMPLATES
// ============================================================================

export const createClassTemplateSchema = z.object({
  teacherRoomId: z.string().uuid(),
  classType: z.string().trim().min(1),
  description: z.string().nullable().optional(),
  dayOfWeek: z.number().int().min(0).max(6),
  startTime: timeHHmm,
  durationMinutes: z.number().int().positive(),
  roomCost: z.number().nonnegative(),
  minRate: z.number(),
  targetRate: z.number(),
  minStudents: z.number().int().positive().max(MAX_CLASS_SIZE),
  maxStudents: z.number().int().positive().max(MAX_CLASS_SIZE),
  cancelDeadline: z.enum(['HOURS_48', 'HOURS_24', 'HOURS_12', 'HOURS_6']).optional(),
  autoCancelCheck: z.enum(['HOURS_4', 'HOURS_2', 'HOURS_1']).optional(),
})
  .refine((d) => d.minStudents <= d.maxStudents, {
    message: 'minStudents cannot exceed maxStudents',
    path: ['minStudents'],
  })
  .refine((d) => d.minRate <= d.targetRate, {
    message: 'minRate cannot exceed targetRate',
    path: ['minRate'],
  })
  .refine((d) => d.minRate >= -d.roomCost, {
    message: 'minRate cannot subsidize more than the room cost — prices would go negative',
    path: ['minRate'],
  });

export const updateClassTemplateSchema = z.object({
  classType: z.string().trim().min(1).optional(),
  description: z.string().nullable().optional(),
  teacherRoomId: z.string().uuid().optional(),
  dayOfWeek: z.number().int().min(0).max(6).optional(),
  startTime: timeHHmm.optional(),
  durationMinutes: z.number().int().positive().optional(),
  roomCost: z.number().nonnegative().optional(),
  minRate: z.number().optional(),
  targetRate: z.number().optional(),
  minStudents: z.number().int().positive().max(MAX_CLASS_SIZE).optional(),
  maxStudents: z.number().int().positive().max(MAX_CLASS_SIZE).optional(),
  cancelDeadline: z.enum(['HOURS_48', 'HOURS_24', 'HOURS_12', 'HOURS_6']).optional(),
  autoCancelCheck: z.enum(['HOURS_4', 'HOURS_2', 'HOURS_1']).optional(),
}).strict()
  .refine((d) => d.minStudents === undefined || d.maxStudents === undefined || d.minStudents <= d.maxStudents, {
    message: 'minStudents cannot exceed maxStudents',
    path: ['minStudents'],
  })
  .refine((d) => d.minRate === undefined || d.targetRate === undefined || d.minRate <= d.targetRate, {
    message: 'minRate cannot exceed targetRate',
    path: ['minRate'],
  });

// ============================================================================
// STUDIO CLASS TEMPLATES
// ============================================================================

export const createStudioClassTemplateSchema = z.object({
  classType: z.string().trim().min(1),
  dayOfWeek: z.number().int().min(0).max(6),
  startTime: timeHHmm,
  durationMinutes: z.number().int().positive(),
  location: z.string().trim().min(1),
  hourlyRate: z.number().nonnegative(),
});

export const updateStudioClassTemplateSchema = z.object({
  classType: z.string().trim().min(1).optional(),
  dayOfWeek: z.number().int().min(0).max(6).optional(),
  startTime: timeHHmm.optional(),
  durationMinutes: z.number().int().positive().optional(),
  location: z.string().trim().min(1).optional(),
  hourlyRate: z.number().nonnegative().optional(),
}).strict();

// ============================================================================
// STUDIO CLASSES
// ============================================================================

export const createStudioClassSchema = z.object({
  classType: z.string().trim().min(1),
  date: isoDate,
  startTime: timeHHmm,
  durationMinutes: z.number().int().positive(),
  location: z.string().trim().min(1),
  hourlyRate: z.number().nonnegative(),
});

export const updateStudioClassSchema = z.object({
  studentCount: z.number().int().nonnegative().nullable().optional(),
  classType: z.string().trim().min(1).optional(),
  location: z.string().trim().min(1).optional(),
  date: isoDate.optional(),
  startTime: timeHHmm.optional(),
  durationMinutes: z.number().int().positive().optional(),
  hourlyRate: z.number().nonnegative().optional(),
  cancelledAt: z.string().datetime().nullable().optional(),
}).strict();

// ============================================================================
// REGISTRATIONS
// ============================================================================

export const createRegistrationSchema = z.object({
  classId: z.string().uuid(),
  studentId: z.string().uuid().optional(), // optional for student self-registration
});

export const updateRegistrationSchema = z.object({
  status: z.enum(['attended', 'no_show', 'late_cancel']),
});

// ============================================================================
// WAITLIST
// ============================================================================

export const createWaitlistSchema = z.object({
  classId: z.string().uuid(),
});

export const claimWaitlistSchema = z.object({
  classId: z.string().uuid(),
});

// ============================================================================
// PAYMENTS
// ============================================================================

export const markPaidSchema = z.object({
  method: z.string().min(1),
});

// ============================================================================
// NOTIFICATIONS & ANNOUNCEMENTS
// ============================================================================

export const createAnnouncementSchema = z.object({
  classId: z.string().uuid().optional(),
  message: z.string().min(1),
});

// ============================================================================
// TOGGLE STATE (PATCH query params)
// ============================================================================

/**
 * The state a PATCH toggle should reach. Required, and deliberately not
 * defaulted: a request that omits it is a 400, not a toggle. Falling back to
 * toggling would leave the #98 behaviour reachable for any caller that forgets
 * the parameter — which is how one defect came to exist in six places.
 *
 * `state`, not `to`: `to` is already a date-range bound on `GET /api/classes`.
 */
export const templateStateQuerySchema = z.object({
  state: z.enum(['active', 'paused', 'archived', 'unarchived']),
});

/** The archive-only subset, for routes with no active/paused axis. */
export const archiveStateQuerySchema = z.object({
  state: z.enum(['archived', 'unarchived']),
});
