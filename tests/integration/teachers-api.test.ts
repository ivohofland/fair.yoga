import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BASE_URL, cookie, uniqueSuffix, seedSession, freshIp } from '../helpers';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

let teacherId: string;
let teacherAccountId: string;
let teacherToken: string;
let otherTeacherId: string;

async function putTeacher(
  id: string,
  body: Record<string, unknown>,
  token?: string,
): Promise<Response> {
  return fetch(`${BASE_URL}/api/teachers/${id}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? cookie(token) : {}),
    },
    body: JSON.stringify(body),
  });
}

describe('PUT /api/teachers/[id]', () => {
  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Settings',
        lastName: 'Teacher',
        email: `settings-teacher-${suffix}@test.local`,
        account: { create: { email: `settings-teacher-${suffix}@test.local` } },
        bio: 'Teacher settings tests',
        pageSlug: `settings-teacher-${suffix}`,
      },
    });
    teacherId = teacher.id;
    teacherAccountId = teacher.accountId;

    const other = await prisma.teacher.create({
      data: {
        firstName: 'Other',
        lastName: 'Teacher',
        email: `settings-other-${suffix}@test.local`,
        account: { create: { email: `settings-other-${suffix}@test.local` } },
        bio: 'Ownership fixture',
        pageSlug: `settings-other-${suffix}`,
      },
    });
    otherTeacherId = other.id;

    teacherToken = await seedSession(prisma, teacherAccountId);
  });

  afterAll(async () => {
    if (teacherAccountId) {
      await prisma.session.deleteMany({ where: { accountId: teacherAccountId } });
    }
    if (teacherId) await prisma.teacher.delete({ where: { id: teacherId } });
    if (otherTeacherId) await prisma.teacher.delete({ where: { id: otherTeacherId } });
    await prisma.account.deleteMany({
      where: {
        email: {
          in: [
            `settings-teacher-${suffix}@test.local`,
            `settings-other-${suffix}@test.local`,
          ],
        },
      },
    });
    await prisma.$disconnect();
  });

  it('updates and persists valid settings — resubmitting the own slug is not a conflict', async () => {
    const res = await putTeacher(
      teacherId,
      {
        bio: 'Updated bio',
        defaultTimezone: 'Europe/London',
        // The unchanged own slug must pass the conflict check: losing the
        // existing.id !== id exclusion would 409 every settings save.
        pageSlug: `settings-teacher-${suffix}`,
      },
      teacherToken,
    );
    expect(res.status).toBe(200);

    const persisted = await prisma.teacher.findUniqueOrThrow({ where: { id: teacherId } });
    expect(persisted.bio).toBe('Updated bio');
    expect(persisted.defaultTimezone).toBe('Europe/London');
  });

  it('rejects unknown fields — the schema is strict', async () => {
    const res = await putTeacher(teacherId, { role: 'admin' }, teacherToken);
    expect(res.status).toBe(400);
  });

  it('rejects a timezone Intl cannot resolve', async () => {
    const before = await prisma.teacher.findUniqueOrThrow({ where: { id: teacherId } });

    const res = await putTeacher(teacherId, { defaultTimezone: 'Not/AZone' }, teacherToken);
    expect(res.status).toBe(400);

    const after = await prisma.teacher.findUniqueOrThrow({ where: { id: teacherId } });
    expect(after).toEqual(before);
  });

  it("rejects updating another teacher's profile", async () => {
    const res = await putTeacher(otherTeacherId, { bio: 'Hijacked' }, teacherToken);
    expect(res.status).toBe(403);

    const persisted = await prisma.teacher.findUniqueOrThrow({ where: { id: otherTeacherId } });
    expect(persisted.bio).toBe('Ownership fixture');
  });

  it('rejects an unauthenticated request', async () => {
    const res = await putTeacher(teacherId, { bio: 'Anonymous' });
    expect(res.status).toBe(401);
  });

  it("rejects claiming another teacher's page slug with the SLUG_TAKEN code", async () => {
    const res = await putTeacher(
      teacherId,
      { pageSlug: `settings-other-${suffix}` },
      teacherToken,
    );
    expect(res.status).toBe(409);
    // The code pins the deliberate pre-check: the P2002 fallback also
    // returns 409, but without SLUG_TAKEN the settings form can't render
    // its inline error.
    const json = (await res.json()) as { error: { code?: string } };
    expect(json.error.code).toBe('SLUG_TAKEN');
  });

  it("rejects reading another teacher's profile — the raw row carries bank details", async () => {
    const res = await fetch(`${BASE_URL}/api/teachers/${otherTeacherId}`, {
      headers: cookie(teacherToken),
    });
    expect(res.status).toBe(403);
  });
});

/**
 * Both pre-checks at `:34` and `:39` are plain reads, so a concurrent signup
 * passes them and loses on the create. Unhandled, either collision answers
 * 409 with NO `code`, collapsing `EMAIL_TAKEN` and `SLUG_TAKEN` into one
 * indistinguishable response — and the settings form points at a field it
 * can no longer identify (#161).
 *
 * Three unique keys are reachable here, not two: `Account.email` and
 * `Teacher.email` both report `meta.target` `['email']`, and one predicate
 * covers both because they mean the same thing to the caller. See the spec.
 *
 * A fresh IP per request — this route is rate-limited to 3/hour per IP.
 */
describe('POST /api/teachers keeps its conflict codes apart under a race (#161)', () => {
  const raceEmail = `race-teacher-${suffix}@test.local`;
  const raceSlug = `race-slug-${suffix}`;
  const holderSlugEmail = `race-holder-${suffix}@test.local`;

  afterAll(async () => {
    const emails = [
      raceEmail,
      holderSlugEmail,
      `race-slug-req-${suffix}@test.local`,
      `sequential-teacher-1-${suffix}@test.local`,
      `sequential-teacher-2-${suffix}@test.local`,
    ];
    await prisma.teacher.deleteMany({ where: { email: { in: emails } } });
    await prisma.account.deleteMany({ where: { email: { in: emails } } });
  });

  const signup = (body: Record<string, unknown>) =>
    fetch(`${BASE_URL}/api/teachers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...freshIp() },
      body: JSON.stringify(body),
    });

  it('returns 409 EMAIL_TAKEN when the create loses on the email key', async () => {
    const holder = new PrismaClient();
    let release!: () => void;
    let holding!: Promise<unknown>;
    const released = new Promise<void>((r) => { release = r; });

    await new Promise<void>((parked, failed) => {
      holding = holder.$transaction(async (tx) => {
        await tx.account.create({ data: { email: raceEmail } });
        parked();
        await released;
      }, { timeout: 20_000 }).catch((err: unknown) => { failed(err); throw err; });
    });

    const pending = signup({
      firstName: 'Race',
      lastName: 'Email',
      email: raceEmail,
      pageSlug: `race-email-slug-${suffix}`,
      bio: 'Race bio',
    });

    let settled = false;
    void pending.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 1000));
    // Without this, a fast answer means the request 409'd off its own
    // pre-check and raced nothing — see teacher-rooms-api.test.ts for the
    // full argument.
    expect(settled).toBe(false);

    release();
    await holding;
    const res = await pending;
    await holder.$disconnect();

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code?: string; message: string } };
    expect(body.error.code).toBe('EMAIL_TAKEN');
    expect(body.error.message).toBe('Email already in use');

    // One account, and it is the holder's — proof the request lost the
    // insert rather than serialising past it.
    expect(await prisma.account.count({ where: { email: raceEmail } })).toBe(1);
  });

  it('returns 409 SLUG_TAKEN when the create loses on the page slug key', async () => {
    const holder = new PrismaClient();
    let release!: () => void;
    let holding!: Promise<unknown>;
    const released = new Promise<void>((r) => { release = r; });

    // A whole Teacher, not a bare row: `Teacher.accountId` is non-null, so the
    // holder must mint its own account. Its email differs from the request's,
    // so `pageSlug` is the only key the request can lose on.
    await new Promise<void>((parked, failed) => {
      holding = holder.$transaction(async (tx) => {
        await tx.teacher.create({
          data: {
            firstName: 'Holder',
            lastName: 'Slug',
            email: holderSlugEmail,
            bio: '',
            pageSlug: raceSlug,
            defaultCurrency: 'EUR',
            defaultTimezone: 'Europe/Amsterdam',
            account: { create: { email: holderSlugEmail } },
          },
        });
        parked();
        await released;
      }, { timeout: 20_000 }).catch((err: unknown) => { failed(err); throw err; });
    });

    const pending = signup({
      firstName: 'Race',
      lastName: 'Slug',
      email: `race-slug-req-${suffix}@test.local`,
      pageSlug: raceSlug,
      bio: 'Race bio',
    });

    let settled = false;
    void pending.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 1000));
    // Without this, a fast answer means the request 409'd off its own
    // pre-check and raced nothing — see teacher-rooms-api.test.ts for the
    // full argument.
    expect(settled).toBe(false);

    release();
    await holding;
    const res = await pending;
    await holder.$disconnect();

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code?: string; message: string } };
    expect(body.error.code).toBe('SLUG_TAKEN');
    expect(body.error.message).toBe('Page slug already in use');

    // One teacher, and it is the holder's — proof the request lost the
    // insert rather than serialising past it.
    expect(await prisma.teacher.count({ where: { pageSlug: raceSlug } })).toBe(1);
  });

  it('returns 409 SLUG_TAKEN for an ordinary sequential duplicate, not just the raced one', async () => {
    // The race test above exercises `existingSlug`'s 409 only through its
    // catch-block twin (`isUniqueConflictOn` after a lost create). This test
    // exercises the pre-check itself — no race, just a second signup against
    // an already-taken slug — so a drift between the two independently
    // declared 409s (status/code/message) fails here even when nothing races.
    const sequentialSlug = `sequential-slug-${suffix}`;
    const firstEmail = `sequential-teacher-1-${suffix}@test.local`;
    const secondEmail = `sequential-teacher-2-${suffix}@test.local`;

    const first = await signup({
      firstName: 'Sequential',
      lastName: 'First',
      email: firstEmail,
      pageSlug: sequentialSlug,
      bio: 'Sequential bio',
    });
    expect(first.status).toBe(201);

    const res = await signup({
      firstName: 'Sequential',
      lastName: 'Second',
      email: secondEmail,
      pageSlug: sequentialSlug,
      bio: 'Sequential bio',
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code?: string; message: string } };
    expect(body.error.code).toBe('SLUG_TAKEN');
    expect(body.error.message).toBe('Page slug already in use');
  });
});
