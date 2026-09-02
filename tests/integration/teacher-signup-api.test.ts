import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BASE_URL, uniqueSuffix, freshIp, cookie, seedSession } from '../helpers';
import { createClassFixture } from '../class-fixtures';
import { mintSignupTicket, generateMagicLinkToken } from '@/lib/auth';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();
const freshEmail = `teacher-signup-${suffix}@test.local`;
const ticketEmail = `teacher-signup-ticket-${suffix}@test.local`;
const ticketSlug = `ticket-teacher-${suffix}`;
const spentEmail = `teacher-signup-spent-${suffix}@test.local`;
const clashEmail = `teacher-signup-clash-${suffix}@test.local`;
const recoveryEmail = `teacher-signup-recovery-${suffix}@test.local`;
const recoverySlug = `recovery-${suffix}`;
const verifyTeacherSignupEmail = `teacher-signup-verify-ticket-${suffix}@test.local`;
const verifySignInNoAccountEmail = `teacher-signup-verify-signin-${suffix}@test.local`;
const onboardingEmail = `teacher-signup-onboarding-${suffix}@test.local`;
const onboardingSlug = `onboarding-teacher-${suffix}`;
// #168 follow-up test's fixtures — an address per attempt, none of which
// ever gets an account (the route only ever mints a token).
const noIpEmails = Array.from(
  { length: 7 },
  (_, i) => `teacher-signup-no-ip-${i}-${suffix}@test.local`,
);
// #161 race test's fixtures — two distinct tickets so email can never be the
// colliding key, leaving pageSlug as the only one the race can land on.
const raceEmailA = `teacher-signup-race-a-${suffix}@test.local`;
const raceEmailB = `teacher-signup-race-b-${suffix}@test.local`;
const raceSlug = `race-teacher-profile-${suffix}`;
// #258's wiring: one address that sends a zone, one that sends none.
const tzDetectedEmail = `teacher-signup-tz-detected-${suffix}@test.local`;
const tzDetectedSlug = `tz-detected-${suffix}`;
const tzFallbackEmail = `teacher-signup-tz-fallback-${suffix}@test.local`;
const tzFallbackSlug = `tz-fallback-${suffix}`;
// Session mode: an account that already exists, has a student profile and no
// teacher, adding the second hat with no ticket anywhere.
const sessionModeEmail = `teacher-signup-session-mode-${suffix}@test.local`;
const sessionModeSlug = `session-mode-${suffix}`;
const alreadyTeacherSlug = `already-teacher-${suffix}`;
// A fully-settled teacher, built inline by its own test rather than in
// beforeAll — nothing else needs a teacher with a room and a class.
const shareSettledEmail = `teacher-signup-share-settled-${suffix}@test.local`;
const shareSettledSlug = `share-settled-${suffix}`;

// A live teacher+session fixture, needed by the slug-available "already
// taken" test and by every POST /api/account/onboarding test.
let onboardingTeacherId: string;
let onboardingAccountId: string;
let onboardingToken: string;

// The session-mode fixture. It carries a STUDENT deliberately: `validateSession`
// deletes any session whose account has no live profile, so an account with
// neither hat cannot hold one at all — a profile-less session is unrepresentable
// at runtime as well as in `SessionUser`, and a student is therefore the only
// caller session mode can ever have.
let sessionModeAccountId: string;
let sessionModeToken: string;

beforeAll(async () => {
  await prisma.$connect();
  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'Onboarding',
      lastName: 'Teacher',
      email: onboardingEmail,
      bio: '',
      pageSlug: onboardingSlug,
      account: { create: { email: onboardingEmail } },
    },
  });
  onboardingTeacherId = teacher.id;
  onboardingAccountId = teacher.accountId;
  onboardingToken = await seedSession(prisma, onboardingAccountId);

  const sessionModeAccount = await prisma.account.create({
    data: { email: sessionModeEmail },
    select: { id: true },
  });
  sessionModeAccountId = sessionModeAccount.id;
  await prisma.student.create({
    data: {
      firstName: 'Student',
      lastName: 'Turned Teacher',
      email: sessionModeEmail,
      claimedAt: new Date(),
      accountId: sessionModeAccountId,
    },
  });
  sessionModeToken = await seedSession(prisma, sessionModeAccountId);
});

afterAll(async () => {
  const ticketBackedEmails = [
    ticketEmail, spentEmail, clashEmail, recoveryEmail, raceEmailA, raceEmailB,
    tzDetectedEmail, tzFallbackEmail,
  ];
  await prisma.magicLinkToken.deleteMany({
    where: {
      email: {
        in: [
          freshEmail,
          ...ticketBackedEmails,
          ...noIpEmails,
          verifyTeacherSignupEmail,
          verifySignInNoAccountEmail,
        ],
      },
    },
  });

  const accounts = await prisma.account.findMany({
    where: { email: { in: ticketBackedEmails } },
    select: { id: true },
  });
  const accountIds = accounts.map((a) => a.id);
  await prisma.session.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.teacher.deleteMany({
    where: { email: { in: ticketBackedEmails } },
  });
  await prisma.account.deleteMany({ where: { id: { in: accountIds } } });

  // Both children before the account they hang off.
  await prisma.session.deleteMany({ where: { accountId: sessionModeAccountId } });
  await prisma.teacher.deleteMany({ where: { accountId: sessionModeAccountId } });
  await prisma.student.deleteMany({ where: { accountId: sessionModeAccountId } });
  await prisma.account.deleteMany({ where: { id: sessionModeAccountId } });

  await prisma.session.deleteMany({ where: { accountId: onboardingAccountId } });
  await prisma.teacher.deleteMany({ where: { id: onboardingTeacherId } });
  await prisma.account.deleteMany({ where: { id: onboardingAccountId } });

  await prisma.$disconnect();
});

describe('POST /api/auth/teacher-signup', () => {
  it('creates no rows and mints a marked token', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/teacher-signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...freshIp() },
      body: JSON.stringify({ email: freshEmail }),
    });
    expect(res.status).toBe(200);

    expect(await prisma.account.findUnique({ where: { email: freshEmail } })).toBeNull();
    expect(await prisma.teacher.findUnique({ where: { email: freshEmail } })).toBeNull();

    const token = await prisma.magicLinkToken.findFirst({ where: { email: freshEmail } });
    expect(token?.purpose).toBe('teacher_signup');
  });

  // Losing the email is the only failure mode with no other recovery:
  // magic-link/send looks up Teacher-then-Student and an unfinished signup
  // has neither, so re-running /signup IS the recovery path.
  it('is re-runnable for an address it has already seen', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/teacher-signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...freshIp() },
      body: JSON.stringify({ email: freshEmail }),
    });
    expect(res.status).toBe(200);
  });

  it('rejects a body carrying anything but an email', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/teacher-signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...freshIp() },
      body: JSON.stringify({ email: freshEmail, pageSlug: 'sneaky' }),
    });
    expect(res.status).toBe(400);
  });

  /**
   * #168 follow-up: this route has no per-email backstop (an unclaimed email
   * is exactly what a legitimate signup submits), so its IP check used to
   * fail OPEN when `clientIp()` couldn't resolve an address — a broken
   * nginx config would silently remove all throttling. `checkIpRateLimit`
   * now routes every such caller into one shared bucket instead.
   *
   * That bucket (capacity 5/hour) is shared process-wide, not per-test, so a
   * prior run may have already spent part of it — hammering it 7 times
   * (more than its capacity) and asserting at least one 429 shows up holds
   * regardless of how much budget was already gone going in.
   */
  it('does not bypass the IP limit when neither x-forwarded-for nor x-real-ip is present', async () => {
    const statuses: number[] = [];
    let refusalMessage: string | undefined;
    for (let i = 0; i < noIpEmails.length; i++) {
      const res = await fetch(`${BASE_URL}/api/auth/teacher-signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }, // deliberately no IP header
        body: JSON.stringify({ email: noIpEmails[i] }),
      });
      statuses.push(res.status);
      if (res.status === 429 && !refusalMessage) {
        const body: { error?: { message?: string } } = await res.json();
        refusalMessage = body.error?.message;
      }
    }
    statuses.forEach((status) => expect([200, 429]).toContain(status));
    expect(statuses).toContain(429);
    // `respondRateLimited` used to hardcode invitation copy for every caller
    // — a signup refusal saying "Too many invitations" is the regression
    // this pins against.
    expect(refusalMessage).toMatch(/^Too many signup attempts\./);
    expect(refusalMessage).not.toMatch(/invitation/i);
  });
});

// Fix round 1, Finding 4: the verify route's new ticket-authorization branch
// (`!resolved && purpose === 'teacher_signup'`) had no test coverage —
// deleting the condition would leave the suite green. These two cases prove
// it actually gates on `purpose`, not merely on "no account".
describe('POST /api/auth/magic-link/verify — teacher-signup ticket branch', () => {
  it('mints a signup ticket for a teacher_signup token with no existing account', async () => {
    const token = await generateMagicLinkToken(prisma, verifyTeacherSignupEmail, {
      purpose: 'teacher_signup',
    });
    const res = await fetch(`${BASE_URL}/api/auth/magic-link/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...freshIp() },
      body: JSON.stringify({ token }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { redirectTo: string } };
    expect(body.data.redirectTo).toBe('/signup/profile');
    expect(res.headers.get('set-cookie')).toContain('fair_yoga_signup=');

    // The ticket defers account/teacher creation to
    // POST /api/account/teacher-profile — neither exists yet.
    expect(
      await prisma.account.findUnique({ where: { email: verifyTeacherSignupEmail } }),
    ).toBeNull();
  });

  it('still 400s a sign_in token for an address with no account, and sets no ticket', async () => {
    const token = await generateMagicLinkToken(prisma, verifySignInNoAccountEmail);
    const res = await fetch(`${BASE_URL}/api/auth/magic-link/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...freshIp() },
      body: JSON.stringify({ token }),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get('set-cookie') ?? '').not.toContain('fair_yoga_signup=');
  });
});

describe('POST /api/account/teacher-profile', () => {
  it('rejects a caller with neither ticket nor session', async () => {
    const res = await fetch(`${BASE_URL}/api/account/teacher-profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...freshIp() },
      body: JSON.stringify({
        firstName: 'No', lastName: 'Auth', bio: '', pageSlug: `no-auth-${suffix}`,
      }),
    });
    expect(res.status).toBe(401);
    expect(await prisma.teacher.findUnique({ where: { pageSlug: `no-auth-${suffix}` } })).toBeNull();
  });

  it('creates account, teacher and session from a ticket', async () => {
    const ticket = await mintSignupTicket(prisma, ticketEmail);
    const res = await fetch(`${BASE_URL}/api/account/teacher-profile`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `fair_yoga_signup=${ticket}`,
        ...freshIp(),
      },
      body: JSON.stringify({
        firstName: 'Anna', lastName: 'de Vries', bio: '', pageSlug: ticketSlug,
      }),
    });
    expect(res.status).toBe(201);
    expect(res.headers.get('set-cookie')).toContain('fair_yoga_session=');

    const teacher = await prisma.teacher.findUnique({ where: { pageSlug: ticketSlug } });
    expect(teacher?.email).toBe(ticketEmail);
    // The address comes from the ticket, never the body.
    expect(teacher?.bio).toBe('');
  });

  /**
   * #258's whole point, and untested until now: reverting the route's
   * `defaultTimezone ?? 'Europe/Amsterdam'` to the unconditional literal it
   * replaced left every tier green. `America/Los_Angeles` is chosen because
   * it is nowhere near the fallback — an assertion against a CET zone would
   * pass under both versions.
   */
  it('stores the timezone the browser detected', async () => {
    const ticket = await mintSignupTicket(prisma, tzDetectedEmail);
    const res = await fetch(`${BASE_URL}/api/account/teacher-profile`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `fair_yoga_signup=${ticket}`,
        ...freshIp(),
      },
      body: JSON.stringify({
        firstName: 'Zone', lastName: 'Detected', bio: '', pageSlug: tzDetectedSlug,
        defaultTimezone: 'America/Los_Angeles',
      }),
    });
    expect(res.status).toBe(201);

    const teacher = await prisma.teacher.findUnique({
      where: { pageSlug: tzDetectedSlug },
      select: { defaultTimezone: true },
    });
    expect(teacher?.defaultTimezone).toBe('America/Los_Angeles');
  });

  it('falls back to Europe/Amsterdam when the browser reported no timezone', async () => {
    const ticket = await mintSignupTicket(prisma, tzFallbackEmail);
    const res = await fetch(`${BASE_URL}/api/account/teacher-profile`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `fair_yoga_signup=${ticket}`,
        ...freshIp(),
      },
      body: JSON.stringify({
        firstName: 'Zone', lastName: 'Absent', bio: '', pageSlug: tzFallbackSlug,
      }),
    });
    expect(res.status).toBe(201);

    const teacher = await prisma.teacher.findUnique({
      where: { pageSlug: tzFallbackSlug },
      select: { defaultTimezone: true },
    });
    expect(teacher?.defaultTimezone).toBe('Europe/Amsterdam');
  });

  it('refuses a spent ticket', async () => {
    const ticket = await mintSignupTicket(prisma, spentEmail);
    const body = JSON.stringify({
      firstName: 'A', lastName: 'B', bio: '', pageSlug: `spent-${suffix}`,
    });
    const headers = {
      'Content-Type': 'application/json',
      Cookie: `fair_yoga_signup=${ticket}`,
      ...freshIp(),
    };
    await fetch(`${BASE_URL}/api/account/teacher-profile`, { method: 'POST', headers, body });
    const second = await fetch(`${BASE_URL}/api/account/teacher-profile`, {
      method: 'POST', headers,
      body: JSON.stringify({
        firstName: 'A', lastName: 'B', bio: '', pageSlug: `spent2-${suffix}`,
      }),
    });
    expect(second.status).toBe(401);
  });

  it('answers SLUG_TAKEN for an address someone already holds', async () => {
    const ticket = await mintSignupTicket(prisma, clashEmail);
    const res = await fetch(`${BASE_URL}/api/account/teacher-profile`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `fair_yoga_signup=${ticket}`,
        ...freshIp(),
      },
      body: JSON.stringify({
        firstName: 'A', lastName: 'B', bio: '', pageSlug: ticketSlug,
      }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('SLUG_TAKEN');
  });

  // Fix round 1, Finding 2: SLUG_TAKEN used to be a dead end — the ticket
  // was already spent by the time the conflict was known, and the client's
  // cookie kept naming a deleted token. The 409 now sets a fresh ticket;
  // this proves a retry using THAT cookie value (the realistic simulation of
  // what a browser does automatically on a Set-Cookie) actually succeeds.
  it('recovers from SLUG_TAKEN: the 409 sets a fresh ticket a retry can use', async () => {
    const ticket = await mintSignupTicket(prisma, recoveryEmail);
    const first = await fetch(`${BASE_URL}/api/account/teacher-profile`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `fair_yoga_signup=${ticket}`,
        ...freshIp(),
      },
      body: JSON.stringify({
        // ticketSlug is already taken — the earlier test in this block
        // created a teacher with it.
        firstName: 'A', lastName: 'B', bio: '', pageSlug: ticketSlug,
      }),
    });
    expect(first.status).toBe(409);
    expect((await first.json()).error.code).toBe('SLUG_TAKEN');

    const setCookieHeader = first.headers.get('set-cookie');
    const freshToken = /fair_yoga_signup=([^;]+)/.exec(setCookieHeader ?? '')?.[1];
    expect(freshToken).toBeTruthy();
    expect(freshToken).not.toBe(ticket);

    const second = await fetch(`${BASE_URL}/api/account/teacher-profile`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `fair_yoga_signup=${freshToken}`,
        ...freshIp(),
      },
      body: JSON.stringify({
        firstName: 'A', lastName: 'B', bio: '', pageSlug: recoverySlug,
      }),
    });
    expect(second.status).toBe(201);

    const teacher = await prisma.teacher.findUnique({ where: { pageSlug: recoverySlug } });
    expect(teacher?.email).toBe(recoveryEmail);
  });

  /**
   * #161: unhandled, a lost create answers with a code-less 409, collapsing
   * every conflict into one indistinguishable response — the profile form
   * can't render an inline error against a field it can't identify. This
   * route has no pre-check (unlike the old `POST /api/teachers`, which read
   * then wrote): every conflict, raced or not, resolves in the same catch
   * block, so a genuine race between two ticket-authorized calls is the
   * realistic case to prove.
   *
   * Two distinct tickets keep email out of play — `Teacher.email` and
   * `Teacher.accountId` cannot collide here — so pageSlug is the only key
   * the two calls can lose on, and this asserts the loser carries
   * `SLUG_TAKEN`, not a bare 409.
   */
  it('keeps its conflict codes apart under a race (#161): one 201, one SLUG_TAKEN', async () => {
    const [ticketA, ticketB] = await Promise.all([
      mintSignupTicket(prisma, raceEmailA),
      mintSignupTicket(prisma, raceEmailB),
    ]);

    const post = (ticket: string) =>
      fetch(`${BASE_URL}/api/account/teacher-profile`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `fair_yoga_signup=${ticket}`,
          ...freshIp(),
        },
        body: JSON.stringify({
          firstName: 'Race', lastName: 'Teacher', bio: '', pageSlug: raceSlug,
        }),
      });

    const [resA, resB] = await Promise.all([post(ticketA), post(ticketB)]);

    expect([resA.status, resB.status].sort()).toEqual([201, 409]);

    const loser = resA.status === 409 ? resA : resB;
    const body = (await loser.json()) as { error: { code?: string } };
    expect(body.error.code).toBe('SLUG_TAKEN');

    // One teacher, proof the loser lost the insert rather than double-writing.
    expect(await prisma.teacher.count({ where: { pageSlug: raceSlug } })).toBe(1);
  });
});

// #385 controller ruling: Steps 11-12 implement GET /api/teachers/slug-available
// and POST /api/account/onboarding with no preceding failing-test step. These
// two describe blocks close that gap, kept minimal and matched to what each
// route actually guards.
describe('GET /api/teachers/slug-available', () => {
  it('reports an available slug as available', async () => {
    const res = await fetch(
      `${BASE_URL}/api/teachers/slug-available?slug=slug-check-available-${suffix}`,
      { headers: { ...freshIp() } },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ available: true });
  });

  it('reports a slug already held by an existing teacher as unavailable', async () => {
    const res = await fetch(
      `${BASE_URL}/api/teachers/slug-available?slug=${onboardingSlug}`,
      { headers: { ...freshIp() } },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ available: false });
  });

  // Can't easily prove "no database read happened" from an HTTP test, so
  // this just asserts the response is correct — sufficient coverage here.
  it('reports a reserved slug as unavailable', async () => {
    const res = await fetch(
      `${BASE_URL}/api/teachers/slug-available?slug=signup`,
      { headers: { ...freshIp() } },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ available: false });
  });
});

describe('POST /api/account/onboarding', () => {
  it('is idempotent: skipping a step twice only adds it once', async () => {
    const first = await fetch(`${BASE_URL}/api/account/onboarding`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(onboardingToken), ...freshIp() },
      body: JSON.stringify({ step: 'profile' }),
    });
    expect(first.status).toBe(200);

    const second = await fetch(`${BASE_URL}/api/account/onboarding`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(onboardingToken), ...freshIp() },
      body: JSON.stringify({ step: 'profile' }),
    });
    expect(second.status).toBe(200);

    const teacher = await prisma.teacher.findUnique({
      where: { id: onboardingTeacherId },
      select: { skippedOnboarding: true },
    });
    expect(teacher?.skippedOnboarding.filter((s) => s === 'profile')).toHaveLength(1);
  });

  it('rejects an unauthenticated caller', async () => {
    const res = await fetch(`${BASE_URL}/api/account/onboarding`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...freshIp() },
      body: JSON.stringify({ step: 'bank' }),
    });
    expect(res.status).toBe(401);
  });

  /**
   * `onboardingSkipSchema` is `z.enum(OnboardingStep)`, derived from the
   * Prisma enum rather than a hand-copied literal list — but `room`/`class`
   * are still not members of `OnboardingStep` at all (they're the required
   * steps, which carry no Skip control), and `skippedOnboarding` is a
   * Postgres enum array — so if this schema ever stopped rejecting them, an
   * unknown step would reach Prisma and surface as a 500, not a 400.
   * Asserting the STATUS is what pins the zod enum as the thing that
   * refuses it.
   */
  it('rejects a step the skip schema does not name', async () => {
    const res = await fetch(`${BASE_URL}/api/account/onboarding`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(onboardingToken), ...freshIp() },
      body: JSON.stringify({ step: 'room' }),
    });
    expect(res.status).toBe(400);

    const teacher = await prisma.teacher.findUnique({
      where: { id: onboardingTeacherId },
      select: { skippedOnboarding: true },
    });
    expect(teacher?.skippedOnboarding).not.toContain('room');
  });

  /**
   * `step: 'share'` (dismissing the completion card) is the one step the
   * route itself gates, on top of the schema: `onboardingTeacherId`'s fixture
   * has an empty bio, no bank details, and no rooms or classes, so it is
   * about as unsettled as a teacher can be. The checklist UI would never
   * show a Dismiss button in this state, but the route must refuse the
   * request on its own — a UI conditional is not an authorization check.
   */
  it('refuses to dismiss the completion card while the checklist is unsettled', async () => {
    const res = await fetch(`${BASE_URL}/api/account/onboarding`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(onboardingToken), ...freshIp() },
      body: JSON.stringify({ step: 'share' }),
    });
    expect(res.status).toBe(409);

    const body: { error?: { code?: string } } = await res.json();
    expect(body.error?.code).toBe('ONBOARDING_NOT_SETTLED');

    const teacher = await prisma.teacher.findUnique({
      where: { id: onboardingTeacherId },
      select: { skippedOnboarding: true },
    });
    expect(teacher?.skippedOnboarding).not.toContain('share');
  });

  it('accepts step: share once every other step is settled', async () => {
    let accountId: string | undefined;
    let roomId: string | undefined;
    let teacherRoomId: string | undefined;
    let calendarEntryId: string | undefined;
    try {
      const teacher = await prisma.teacher.create({
        data: {
          firstName: 'Settled',
          lastName: 'Teacher',
          email: shareSettledEmail,
          bio: 'Yoga since 2009.',
          bankIban: 'NL00BANK0123456789',
          pageSlug: shareSettledSlug,
          account: { create: { email: shareSettledEmail } },
        },
      });
      accountId = teacher.accountId;

      const room = await prisma.room.create({
        data: {
          createdById: teacher.id,
          venueName: 'Studio', address: '1 Main St', city: 'Amsterdam', postcode: '1000AA',
          maxCapacity: 20,
        },
      });
      roomId = room.id;

      const teacherRoom = await prisma.teacherRoom.create({
        data: { teacherId: teacher.id, roomId: room.id, capacityOverride: 20, rentalRate: 10 },
      });
      teacherRoomId = teacherRoom.id;

      const { calendarEntry } = await createClassFixture(prisma, {
        teacherId: teacher.id,
        classType: 'Vinyasa',
        date: new Date('2026-10-01'),
        startTime: new Date('1970-01-01T09:00:00Z'),
        durationMinutes: 60,
        teacherRoomId: teacherRoom.id,
        roomCost: 10, minRate: 0, targetRate: 0, minStudents: 1, maxStudents: 10,
      });
      calendarEntryId = calendarEntry.id;

      const token = await seedSession(prisma, teacher.accountId);

      const res = await fetch(`${BASE_URL}/api/account/onboarding`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...cookie(token), ...freshIp() },
        body: JSON.stringify({ step: 'share' }),
      });
      expect(res.status).toBe(200);

      const updated = await prisma.teacher.findUnique({
        where: { id: teacher.id },
        select: { skippedOnboarding: true },
      });
      expect(updated?.skippedOnboarding).toContain('share');
    } finally {
      if (accountId) await prisma.session.deleteMany({ where: { accountId } });
      if (calendarEntryId) await prisma.class.deleteMany({ where: { calendarEntryId } });
      if (calendarEntryId) await prisma.calendarEntry.deleteMany({ where: { id: calendarEntryId } });
      if (teacherRoomId) await prisma.teacherRoom.deleteMany({ where: { id: teacherRoomId } });
      if (roomId) await prisma.room.deleteMany({ where: { id: roomId } });
      if (accountId) await prisma.teacher.deleteMany({ where: { accountId } });
      if (accountId) await prisma.account.deleteMany({ where: { id: accountId } });
    }
  });
});

/**
 * The second authorization the route accepts, and the one that had no UI door
 * until the final review found it: an account that already exists adds the
 * teacher hat on its SESSION, with no ticket anywhere. `/signup` redirects a
 * signed-in, teacherless visitor straight here; the unclaimed-CRM-contact
 * case reaches the same state a second way, since verification claims that
 * student and issues an ordinary session rather than a ticket.
 */
describe('POST /api/account/teacher-profile — session mode', () => {
  it('creates the teacher on the signed-in account, with no ticket', async () => {
    const res = await fetch(`${BASE_URL}/api/account/teacher-profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionModeToken), ...freshIp() },
      body: JSON.stringify({
        firstName: 'Student', lastName: 'Turned Teacher', bio: '', pageSlug: sessionModeSlug,
      }),
    });
    expect(res.status).toBe(201);

    const teacher = await prisma.teacher.findUnique({
      where: { pageSlug: sessionModeSlug },
      select: { accountId: true, email: true },
    });
    // One account, both hats — not a second account for the same person.
    expect(teacher?.accountId).toBe(sessionModeAccountId);
    // The address comes from the account, never the body.
    expect(teacher?.email).toBe(sessionModeEmail);

    // No new session: this caller already had one. Only the ticket branch
    // mints one, and it is the ticket test above that asserts the positive.
    expect(res.headers.get('set-cookie') ?? '').not.toContain('fair_yoga_session=');
  });

  it('answers ALREADY_TEACHER for a session that already has one', async () => {
    const res = await fetch(`${BASE_URL}/api/account/teacher-profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(onboardingToken), ...freshIp() },
      body: JSON.stringify({
        firstName: 'Second', lastName: 'Profile', bio: '', pageSlug: alreadyTeacherSlug,
      }),
    });
    expect(res.status).toBe(409);

    const body: { error?: { code?: string } } = await res.json();
    expect(body.error?.code).toBe('ALREADY_TEACHER');
    expect(
      await prisma.teacher.findUnique({ where: { pageSlug: alreadyTeacherSlug } }),
    ).toBeNull();
  });
});
