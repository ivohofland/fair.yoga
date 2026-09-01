import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { generateMagicLinkToken } from '@/lib/auth';
import { BASE_URL, uniqueSuffix, freshIp } from '../helpers';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

/**
 * Profile-attachment rules: an unauthenticated signup must never attach a
 * profile to an existing account (that requires an authenticated session),
 * and fresh signups create the account atomically with the profile.
 */

const takenEmail = `signup-taken-${suffix}@test.local`;
const teacherOnlyEmail = `signup-teacheronly-${suffix}@test.local`;
const unclaimedEmail = `signup-unclaimed-${suffix}@test.local`;

let takenStudentId: string;
let unclaimedStudentId: string;

beforeAll(async () => {
  await prisma.$connect();
  const student = await prisma.student.create({
    data: {
      firstName: 'Taken',
      lastName: 'Student',
      email: takenEmail,
      claimedAt: new Date(),
      account: { create: { email: takenEmail } },
    },
  });
  takenStudentId = student.id;

  const unclaimed = await prisma.student.create({
    data: { firstName: 'CRM', lastName: 'Contact', email: unclaimedEmail },
  });
  unclaimedStudentId = unclaimed.id;

  await prisma.teacher.create({
    data: {
      firstName: 'Solo',
      lastName: 'Teacher',
      email: teacherOnlyEmail,
      bio: 'Teacher-only fixtures',
      pageSlug: `signup-teacheronly-${suffix}`,
      account: { create: { email: teacherOnlyEmail } },
    },
  });
});

afterAll(async () => {
  await prisma.magicLinkToken.deleteMany({ where: { email: { contains: suffix } } });
  await prisma.teacher.deleteMany({ where: { email: { contains: suffix } } });
  await prisma.student.deleteMany({
    where: { id: { in: [takenStudentId, unclaimedStudentId] } },
  });
  await prisma.student.deleteMany({ where: { email: { contains: suffix } } });
  await prisma.account.deleteMany({ where: { email: { contains: suffix } } });
  await prisma.$disconnect();
});

describe('POST /api/auth/student-signup', () => {
  it('creates account + claimed student for a fresh email', async () => {
    const email = `signup-fresh-student-${suffix}@test.local`;
    const res = await fetch(`${BASE_URL}/api/auth/student-signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...freshIp() },
      body: JSON.stringify({ firstName: 'Fresh', lastName: 'Student', email }),
    });

    expect(res.status).toBe(200);
    const student = await prisma.student.findUnique({ where: { email } });
    expect(student).not.toBeNull();
    expect(student!.claimedAt).not.toBeNull();
    expect(student!.accountId).not.toBeNull();
    expect(await prisma.account.count({ where: { email } })).toBe(1);
  });

  it('does not create an account for an unclaimed CRM email — claim happens at verify', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/student-signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...freshIp() },
      body: JSON.stringify({ firstName: 'C', lastName: 'C', email: unclaimedEmail }),
    });

    expect(res.status).toBe(200);
    expect(await prisma.account.count({ where: { email: unclaimedEmail } })).toBe(0);
    const student = await prisma.student.findUnique({ where: { email: unclaimedEmail } });
    expect(student!.claimedAt).toBeNull();
  });

  it('does not attach a student profile to a teacher-only account either', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/student-signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...freshIp() },
      body: JSON.stringify({ firstName: 'T', lastName: 'T', email: teacherOnlyEmail }),
    });

    expect(res.status).toBe(200);
    expect(await prisma.student.count({ where: { email: teacherOnlyEmail } })).toBe(0);
  });

  it('does not attach a student profile to an existing account', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/student-signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...freshIp() },
      body: JSON.stringify({ firstName: 'T', lastName: 'T', email: takenEmail }),
    });

    // Same 200 as every other outcome — no account enumeration.
    expect(res.status).toBe(200);
    expect(await prisma.student.count({ where: { email: takenEmail } })).toBe(1);
    expect(await prisma.account.count({ where: { email: takenEmail } })).toBe(1);
  });

  /**
   * The route's two pre-checks are plain `findUnique`s, so under READ
   * COMMITTED two concurrent signups for one fresh address both pass them and
   * one loses on `Account.email`/`Student.email`. Unhandled, that P2002 comes
   * back as a 409 "Resource already exists" — a legitimate signup failed, and
   * an anonymous caller was just told the address is taken, which is exactly
   * what this route's identical 200 exists to prevent.
   *
   * A plain `Promise.all` cannot force that interleaving — it serialised in
   * Tasks 2-4 of this branch and would pass green against the bug, because the
   * second request would find the committed account, skip the create, and fall
   * straight through to the mint-and-send. (There is no `else` in that route —
   * every state that is not a fresh email simply falls past the guard.)
   * The row-lock lever those tasks used does not work either: the row does not
   * exist yet. The lever that does is an UNCOMMITTED HOLDER — a second client
   * inserts the same address inside an open transaction, both requests sail
   * past their pre-checks (uncommitted rows are invisible), both park on the
   * pending unique-index entry, and the holder then commits so both lose.
   *
   * That the surviving row is the HOLDER's is the proof the lever bit: if it
   * had not, one of the two requests would have created a `Race` row.
   */
  it('answers both halves of a concurrent signup identically, with no enumeration', async () => {
    const email = `signup-race-${suffix}@test.local`;
    const ip = freshIp(); // one bucket, shared: two requests, limit is 5/hr

    const holder = new PrismaClient();
    let release!: () => void;
    let holding!: Promise<unknown>;
    const released = new Promise<void>((r) => { release = r; });
    await new Promise<void>((parked, failed) => {
      holding = holder.$transaction(async (tx) => {
        await tx.student.create({
          data: {
            firstName: 'Holder', lastName: 'Signup', email,
            claimedAt: new Date(), account: { create: { email } },
          },
        });
        parked();
        await released;
      }, { timeout: 20_000 }).catch((err: unknown) => { failed(err); throw err; });
    });

    const post = () => fetch(`${BASE_URL}/api/auth/student-signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...ip },
      body: JSON.stringify({ firstName: 'Race', lastName: 'Signup', email }),
    });
    const both = Promise.all([post(), post()]);

    // Long enough that both requests have passed their pre-checks and parked
    // on the holder's pending index entry, short enough not to near a timeout.
    let settled = false;
    void both.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 1000));

    // The lever is asserted, not assumed. The `await` on the holder's insert
    // above proves the index entry exists; it does not prove either request
    // reached it. A request answered inside this second skipped the create on
    // a committed row and fell through to the send, and the surviving-row
    // check below would still read `['Holder']` — green, having raced nothing.
    //
    // One flag over a `Promise.all` of two proves at least one is still
    // parked, not both; the status pair below is what covers the other. The
    // rate limit cannot be the escape here — two requests against buckets of
    // 5/hr per IP and 3/15min per address.
    expect(settled).toBe(false);
    release();
    await holding;
    const [a, b] = await both;
    await holder.$disconnect();

    // The identical-response contract holds under a race too: a 409 here
    // would both fail a legitimate signup and reveal the address is taken.
    expect([a.status, b.status]).toEqual([200, 200]);

    // One row for the address, and it is the holder's — so both requests did
    // lose the insert race rather than serialising past it.
    const students = await prisma.student.findMany({ where: { email } });
    expect(students.map((s) => s.firstName)).toEqual(['Holder']);
  });
});


describe('POST /api/auth/magic-link/verify — the claim moment over HTTP', () => {
  it('claims an unclaimed CRM student: account, cookie, and /bookings landing', async () => {
    const token = await generateMagicLinkToken(prisma, unclaimedEmail);

    const res = await fetch(`${BASE_URL}/api/auth/magic-link/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toContain('fair_yoga_session=');
    const body = (await res.json()) as { data: { redirectTo: string } };
    expect(body.data.redirectTo).toBe('/bookings');

    const student = await prisma.student.findUniqueOrThrow({
      where: { id: unclaimedStudentId },
    });
    expect(student.claimedAt).not.toBeNull();
    expect(student.accountId).not.toBeNull();
  });
});

/**
 * `freshIp()` is what makes this suite re-runnable: a fresh bucket per request
 * means no per-IP limit is ever reached. That rests entirely on consecutive
 * calls differing, and nothing else in the repository would fail if they
 * stopped — the symptom is a 429 on the *second* full sweep, an hour of
 * confusion away from the cause. So assert it directly.
 *
 * 100,000 draws, and the count is the point — do not "optimise" it back down.
 * The implementation this one replaced drew its first octet once, at module
 * load (`const ipOctet = randomInt(256)`), then varied only the low two
 * octets per call (`` `10.${ipOctet}.${(n >> 8) & 0xff}.${n & 0xff}` ``) —
 * those two octets repeat every 2^16 = 65,536 calls, so with the octet fixed
 * it could never emit more than 65,536 distinct addresses. That ceiling was
 * invisible at 100 draws (n = 0..99 alone is already distinct) but caused a
 * real 429 during this branch's work. 100,000 exceeds 65,536, so it fails
 * against that implementation and pins the 2^24 (16.7M)-wide space the
 * helper's docblock claims.
 *
 * It costs no rate-limit budget and issues no HTTP: the addresses are computed
 * and counted in-process, never sent. That is also why this is the only test
 * safe to run under a temporary mutation of `freshIp()` — see the warning in
 * `tests/helpers.ts`.
 */
describe('freshIp', () => {
  it('yields a distinct address on every call', () => {
    const seen = new Set(Array.from({ length: 100_000 }, () => freshIp()['x-forwarded-for']));
    expect(seen.size).toBe(100_000);
  });

  it('is a private-range address, so one in a log is obviously synthetic', () => {
    expect(freshIp()['x-forwarded-for']).toMatch(/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
  });
});

/**
 * The only test that fails if the per-IP limiter is removed from
 * `POST /api/auth/student-signup`. Every other call site in the suite now sends
 * a fresh address (see `freshIp`), which is what keeps the suite re-runnable —
 * and which would otherwise leave this limiter with no coverage at all.
 *
 * One address for all six requests, deliberately: that is the bucket under
 * test. Six DISTINCT emails, also deliberately — the route's other budget is
 * per-email (3 per 15 min), and repeating an address would let that one produce
 * the 429 instead, which would keep this test green with the IP check deleted.
 */
describe('POST /api/auth/student-signup — per-IP budget', () => {
  it('refuses the sixth signup from one address within the hour', async () => {
    const ip = freshIp();
    const statuses: number[] = [];

    for (let i = 0; i < 6; i++) {
      const res = await fetch(`${BASE_URL}/api/auth/student-signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...ip },
        body: JSON.stringify({
          firstName: 'Burst',
          lastName: 'Signup',
          email: `signup-ip-burst-${i}-${suffix}@test.local`,
        }),
      });
      statuses.push(res.status);
    }

    expect(statuses.slice(0, 5)).toEqual(Array(5).fill(200));
    expect(statuses[5]).toBe(429);
  });
});
