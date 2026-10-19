import { describe, it, expect, beforeEach, afterAll, vi, onTestFinished } from 'vitest';
import { randomBytes } from 'node:crypto';

vi.mock('@/lib/degradation', () => ({ logDegraded: vi.fn() }));
vi.mock('./processor-methods-cache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./processor-methods-cache')>();
  return { ...actual, forgetOfferedMethods: vi.fn(actual.forgetOfferedMethods) };
});

import { Prisma, createPrismaClient } from '@/lib/prisma-client';
import { hashToken } from '@/lib/auth/magic-link';
import { hhmmToTime } from '@/lib/time-of-day';
import { MollieUnavailable, createMollieClient, type MollieClient, type MollieProfile, type TokenGrant } from '@/lib/mollie/client';
import { openToken } from '@/lib/processor-token-cipher';
import { maskOrganizationId, maskProfileId } from '@/lib/processor-liveness';
import { logDegraded } from '@/lib/degradation';
import { log } from '@/lib/log';
import { forgetOfferedMethods } from './processor-methods-cache';
import { sealGrant } from './processor-token';
import { uniqueSuffix } from '../../tests/helpers';
import { createClassFixture } from '../../tests/class-fixtures';
import type { MollieDeps } from './mollie-deps';
import {
  MOLLIE_SCOPES,
  OAUTH_STATE_TTL_MS,
  REVOKE_DEFER_CAP_MS,
  REVOKE_RETRY_MS,
  chooseProfile,
  isChoosableProfile,
  completeConnect,
  disconnect,
  payoutIdentityLabel,
  readConnectionView,
  revokeConnection,
  revokeDueConnection,
  startConnect,
} from './processor-connection';
import { revokeDueConnections } from './processor-revocation';
import { scopeSweep } from '../../tests/scoped-sweep';

const prisma = createPrismaClient();
const key = randomBytes(32);
const now = new Date();
const later = (ms: number) => new Date(now.getTime() + ms);

const ORG_A = { id: 'org_aaaa1111', name: 'Anna Yoga' };
const ORG_B = { id: 'org_bbbb2222', name: 'Other Org' };
const P1: MollieProfile = { id: 'pfl_one11111', name: 'Studio Anna', mode: 'live', status: 'verified', website: null };
const P2: MollieProfile = { id: 'pfl_two22222', name: 'Retreats', mode: 'live', status: 'verified', website: 'https://retreats.example' };
const P_UNVERIFIED: MollieProfile = { id: 'pfl_unve4444', name: 'Newcomer', mode: 'live', status: 'unverified', website: 'https://zwem.men' };
const P_TEST: MollieProfile = { id: 'pfl_test3333', name: 'Sandbox', mode: 'test', status: 'verified', website: null };
const OPTION_P1 = { id: P1.id, name: P1.name, website: null, choosable: true };
const OPTION_P2 = { id: P2.id, name: P2.name, website: 'https://retreats.example', choosable: true };
const FULL_GRANT: TokenGrant = { accessToken: 'access_1', refreshToken: 'refresh_1', expiresInSeconds: 3600, scopes: [...MOLLIE_SCOPES] };

const real = createMollieClient({ clientId: 'app_client', clientSecret: 'secret' });
type Fake = { [K in keyof MollieClient]: ReturnType<typeof vi.fn> };
const fake: Fake = {
  authorizeUrl: vi.fn(),
  exchangeCode: vi.fn(),
  refresh: vi.fn(),
  revoke: vi.fn(),
  organization: vi.fn(),
  profiles: vi.fn(),
  listMethods: vi.fn(),
  createPayment: vi.fn(),
  getPayment: vi.fn(),
  createRefund: vi.fn(),
};
const liveDeps: MollieDeps = {
  client: fake as unknown as MollieClient,
  config: { clientId: 'app_client', clientSecret: 'secret', tokenKey: key, testmode: false, appUrl: 'https://fair.yoga' },
};
const testDeps: MollieDeps = { ...liveDeps, config: { ...liveDeps.config, testmode: true } };

const teacherIds: string[] = [];
const accountIds: string[] = [];
const roomIds: string[] = [];
const studentIds: string[] = [];

type Fixture = { teacherId: string; accountId: string; sessionId: string };

async function newSession(accountId: string): Promise<string> {
  const id = hashToken(randomBytes(32).toString('hex'));
  await prisma.session.create({ data: { id, accountId, expiresAt: later(86_400_000) } });
  return id;
}

async function freshTeacher(): Promise<Fixture> {
  const s = uniqueSuffix();
  const email = `proc-conn-${s}@test.local`;
  const t = await prisma.teacher.create({
    data: { firstName: 'Con', lastName: 'Nect', email, bio: '', pageSlug: `proc-conn-${s}`, account: { create: { email } } },
    select: { id: true, accountId: true },
  });
  teacherIds.push(t.id);
  accountIds.push(t.accountId);
  return { teacherId: t.id, accountId: t.accountId, sessionId: await newSession(t.accountId) };
}

function stateOf(authorizeUrl: string): string {
  const state = new URL(authorizeUrl).searchParams.get('state');
  if (state === null) throw new Error('no state in the authorize URL');
  return state;
}

/** Mollie answers the next callback with this organization, profiles and grant. */
function mollieAnswers(org: { id: string; name: string }, profiles: MollieProfile[], grant: TokenGrant = FULL_GRANT): void {
  fake.exchangeCode.mockResolvedValue({ kind: 'granted', grant });
  fake.organization.mockResolvedValue(org);
  fake.profiles.mockResolvedValue(profiles);
}

/** A whole start-and-callback round trip for the fixture's session. */
async function connect(t: Fixture, org: { id: string; name: string }, profiles: MollieProfile[], deps: MollieDeps = liveDeps) {
  mollieAnswers(org, profiles);
  const { authorizeUrl } = await startConnect(prisma, deps, { teacherId: t.teacherId, sessionId: t.sessionId, now });
  return completeConnect(prisma, deps, { state: stateOf(authorizeUrl), code: 'code_x', sessionId: t.sessionId, now });
}

async function eventsOf(teacherId: string) {
  return prisma.payoutChangeEvent.findMany({
    where: { teacherId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, kind: true, before: true, after: true, identifierChanged: true },
  });
}

async function connectionOf(teacherId: string) {
  return prisma.processorConnection.findUniqueOrThrow({ where: { teacherId } });
}

/** A disconnected row that still holds its tokens, due for revocation at `revokeAfter`. */
async function seedDisconnected(teacherId: string, revokeAfter: Date) {
  return prisma.processorConnection.create({
    data: {
      teacherId, processor: 'mollie', organizationId: ORG_A.id, profileId: P1.id, scopes: [...MOLLIE_SCOPES], testmode: false,
      ...sealGrant({ ...FULL_GRANT, refreshToken: 'refresh_old' }, key, now),
      disconnectedAt: later(-60_000), revokeAfter,
    },
  });
}

let seededClasses = 0;

/** One `ProcessorPayment` on the teacher's connection, with the status and expiry given, each on its own day's class. */
async function seedAttempt(teacherId: string, connectionId: string, status: 'open' | 'pending' | 'paid', expiresAt: Date) {
  const s = uniqueSuffix();
  const studentEmail = `proc-conn-stu-${s}@test.local`;
  const student = await prisma.student.create({
    data: { firstName: 'Stu', lastName: 'Dent', email: studentEmail, claimedAt: now, account: { create: { email: studentEmail } } },
    select: { id: true, accountId: true },
  });
  studentIds.push(student.id);
  accountIds.push(student.accountId as string);
  const room = await prisma.room.create({
    data: { venueName: 'Conn Studio', address: `${s} St`, city: 'Amsterdam', postcode: '1000AA', roomName: 'Hall', maxCapacity: 20, createdById: teacherId },
  });
  roomIds.push(room.id);
  const teacherRoom = await prisma.teacherRoom.create({ data: { teacherId, roomId: room.id, capacityOverride: 15, rentalRate: 25 } });
  const cls = await createClassFixture(prisma, {
    teacherId, teacherRoomId: teacherRoom.id, classType: `Conn ${s}`, date: new Date(Date.UTC(2026, 5, 1 + seededClasses++)),
    startTime: hhmmToTime('09:00'), durationMinutes: 60, roomCost: 20, minRate: 10, targetRate: 20, minStudents: 1, maxStudents: 10,
    status: 'completed', effectiveTeacherRate: 10, totalStudents: 1, totalRevenue: 30, vatTotal: 0,
  });
  const registration = await prisma.registration.create({ data: { classId: cls.id, studentId: student.id, status: 'attended', tierAtBooking: 3 } });
  const payment = await prisma.payment.create({ data: { registrationId: registration.id, amount: 10, status: 'pending' } });
  return prisma.processorPayment.create({
    data: {
      paymentId: payment.id, connectionId, processorPaymentId: `tr_${s}`.replace(/-/g, ''), profileId: P1.id, testmode: false, method: 'ideal', status,
      amount: new Prisma.Decimal('10.00'), currency: 'EUR', expiresAt,
    },
  });
}

/** A paid attempt on the connection with one refund in `status`. */
async function seedRefund(teacherId: string, connectionId: string, status: 'pending' | 'processing' | 'refunded') {
  const attempt = await seedAttempt(teacherId, connectionId, 'paid', later(-60 * 60_000));
  return prisma.processorRefund.create({
    data: { attemptId: attempt.id, processorRefundId: `re_${uniqueSuffix()}`.replace(/-/g, ''), amount: new Prisma.Decimal('10.00'), status },
  });
}

beforeEach(() => {
  for (const fn of Object.values(fake)) fn.mockReset();
  fake.authorizeUrl.mockImplementation((input: Parameters<MollieClient['authorizeUrl']>[0]) => real.authorizeUrl(input));
  vi.mocked(logDegraded).mockClear();
  vi.mocked(forgetOfferedMethods).mockClear();
});

afterAll(async () => {
  await prisma.payment.deleteMany({ where: { registration: { studentId: { in: studentIds } } } });
  await prisma.registration.deleteMany({ where: { studentId: { in: studentIds } } });
  await prisma.calendarEntry.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.teacherRoom.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.room.deleteMany({ where: { id: { in: roomIds } } });
  await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
  await prisma.session.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.teacher.deleteMany({ where: { id: { in: teacherIds } } });
  await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  await prisma.$disconnect();
});

describe('masks and labels', () => {
  it('masks an organization and a profile id to their prefix and last four', () => {
    expect(maskOrganizationId('org_12345678')).toBe('org_…5678');
    expect(maskProfileId('pfl_abcdefgh')).toBe('pfl_…efgh');
  });
  it('labels an identity by its masked organization and the profile’s name, or its masked id when the list lacks it', () => {
    const identity = { organizationId: ORG_A.id, profileId: P1.id };
    expect(payoutIdentityLabel(identity, [P1, P2])).toBe('org_…1111 · Studio Anna');
    expect(payoutIdentityLabel(identity, [P2])).toBe('org_…1111 · pfl_…1111');
  });
});

describe('startConnect', () => {
  it('stores one hashed state bound to the session for ten minutes and asks for every scope without forcing the prompt', async () => {
    const t = await freshTeacher();
    const { authorizeUrl } = await startConnect(prisma, liveDeps, { teacherId: t.teacherId, sessionId: t.sessionId, now });
    const url = new URL(authorizeUrl);
    const state = stateOf(authorizeUrl);
    expect(url.searchParams.get('scope')).toBe(MOLLIE_SCOPES.join(' '));
    expect(url.searchParams.get('redirect_uri')).toBe('https://fair.yoga/api/processor/mollie/callback');
    const rows = await prisma.oAuthState.findMany({ where: { teacherId: t.teacherId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ stateHash: hashToken(state), sessionId: t.sessionId, expiresAt: later(OAUTH_STATE_TTL_MS) });
    expect(OAUTH_STATE_TTL_MS).toBe(10 * 60_000);
    expect(fake.authorizeUrl).toHaveBeenCalledWith(expect.objectContaining({ forcePrompt: false, state }));
  });

  it.each([
    ['live', { disconnectedAt: null }],
    ['live with missing scopes', { disconnectedAt: null, scopes: ['payments.read'] }],
    ['disconnected', { disconnectedAt: later(-1000) }],
  ] as const)('forces the prompt for a teacher whose connection is %s', async (_name, row) => {
    const t = await freshTeacher();
    await prisma.processorConnection.create({
      data: {
        teacherId: t.teacherId, processor: 'mollie', organizationId: ORG_A.id, profileId: P1.id, testmode: false,
        scopes: 'scopes' in row ? [...row.scopes] : [...MOLLIE_SCOPES], disconnectedAt: row.disconnectedAt,
        ...sealGrant(FULL_GRANT, key, now),
      },
    });
    await startConnect(prisma, liveDeps, { teacherId: t.teacherId, sessionId: t.sessionId, now });
    expect(fake.authorizeUrl).toHaveBeenCalledWith(expect.objectContaining({ forcePrompt: true }));
  });
});

describe('isChoosableProfile', () => {
  it.each([
    ['live', 'verified', true],
    ['live', 'unverified', false],
    ['test', 'unverified', true],
  ] as const)('in %s mode a %s profile is choosable: %s', (mode, status, expected) => {
    expect(isChoosableProfile({ status }, mode === 'test')).toBe(expected);
  });
});

describe('completeConnect', () => {
  it('with one profile connects it, seals the grant, records the connection and consumes the state', async () => {
    const t = await freshTeacher();
    const outcome = await connect(t, ORG_A, [P1]);
    const events = await eventsOf(t.teacherId);
    expect(outcome).toEqual({ kind: 'connected', teacherId: t.teacherId, eventId: events[0]?.id });
    const row = await connectionOf(t.teacherId);
    expect(row).toMatchObject({ organizationId: ORG_A.id, profileId: P1.id, scopes: [...MOLLIE_SCOPES], testmode: false, disconnectedAt: null });
    expect(openToken(row.accessToken!, key)).toBe('access_1');
    expect(openToken(row.refreshToken!, key)).toBe('refresh_1');
    expect(events).toEqual([
      { id: expect.any(String), kind: 'processor_connected', before: null, after: 'org_…1111 · Studio Anna', identifierChanged: null },
    ]);
    expect(await prisma.oAuthState.count({ where: { teacherId: t.teacherId } })).toBe(0);
    expect(fake.exchangeCode).toHaveBeenCalledWith('code_x', 'https://fair.yoga/api/processor/mollie/callback');
  });

  it('records test mode from the config', async () => {
    const t = await freshTeacher();
    await connect(t, ORG_A, [P1], testDeps);
    expect((await connectionOf(t.teacherId)).testmode).toBe(true);
  });

  it('in live mode offers live profiles only, so one live profile beside a test one is chosen outright', async () => {
    const t = await freshTeacher();
    const outcome = await connect(t, ORG_A, [P_TEST, P1]);
    expect(outcome.kind).toBe('connected');
    expect((await connectionOf(t.teacherId)).profileId).toBe(P1.id);
  });

  it('offers no blocked profile, in either mode', async () => {
    const blocked: MollieProfile = { ...P2, status: 'blocked' };
    const live = await freshTeacher();
    expect((await connect(live, ORG_A, [P1, blocked])).kind).toBe('connected');
    expect((await connectionOf(live.teacherId)).profileId).toBe(P1.id);
    const test = await freshTeacher();
    expect((await connect(test, ORG_A, [P1, blocked], testDeps)).kind).toBe('connected');
  });

  it('in test mode offers test profiles too, so the same list asks for a choice', async () => {
    const t = await freshTeacher();
    expect((await connect(t, ORG_A, [P_TEST, P1], testDeps)).kind).toBe('choose_profile');
  });

  it('in live mode lands on the picker when the only listed profile is unverified, and writes no event', async () => {
    const t = await freshTeacher();
    expect(await connect(t, ORG_A, [P_UNVERIFIED])).toEqual({ kind: 'choose_profile', teacherId: t.teacherId });
    expect((await connectionOf(t.teacherId)).profileId).toBeNull();
    expect(await eventsOf(t.teacherId)).toEqual([]);
  });

  it('in test mode still chooses the only listed profile when it is unverified', async () => {
    const t = await freshTeacher();
    expect((await connect(t, ORG_A, [P_UNVERIFIED], testDeps)).kind).toBe('connected');
    expect((await connectionOf(t.teacherId)).profileId).toBe(P_UNVERIFIED.id);
  });

  it('in live mode does not pick the one verified profile among several listed', async () => {
    const t = await freshTeacher();
    expect((await connect(t, ORG_A, [P1, P_UNVERIFIED])).kind).toBe('choose_profile');
    expect((await connectionOf(t.teacherId)).profileId).toBeNull();
  });

  it('reconnecting to the same organization does not keep a previous profile that is now unverified', async () => {
    const t = await freshTeacher();
    await connect(t, ORG_A, [P1, P2]);
    await chooseProfile(prisma, liveDeps, { teacherId: t.teacherId, profileId: P1.id });
    const before = await eventsOf(t.teacherId);
    expect((await connect(t, ORG_A, [{ ...P1, status: 'unverified' }, P2])).kind).toBe('choose_profile');
    expect((await connectionOf(t.teacherId)).profileId).toBeNull();
    expect(await eventsOf(t.teacherId)).toEqual(before);
  });

  it('with two profiles and no live identity before asks for a choice and writes no event', async () => {
    const t = await freshTeacher();
    expect(await connect(t, ORG_A, [P1, P2])).toEqual({ kind: 'choose_profile', teacherId: t.teacherId });
    expect((await connectionOf(t.teacherId)).profileId).toBeNull();
    expect(await eventsOf(t.teacherId)).toEqual([]);
  });

  it('with two profiles that no longer list the previous live one clears the profile, writes no event, and leaves the row not live', async () => {
    const t = await freshTeacher();
    await connect(t, ORG_A, [P1]);
    const before = await eventsOf(t.teacherId);
    const third: MollieProfile = { ...P2, id: 'pfl_thr33333', name: 'Third' };
    expect(await connect(t, ORG_A, [P2, third])).toEqual({ kind: 'choose_profile', teacherId: t.teacherId });
    expect((await connectionOf(t.teacherId)).profileId).toBeNull();
    expect(await eventsOf(t.teacherId)).toEqual(before);
  });

  it('with two profiles in a different organization clears the profile and writes no event', async () => {
    const t = await freshTeacher();
    await connect(t, ORG_A, [P1]);
    const before = await eventsOf(t.teacherId);
    expect((await connect(t, ORG_B, [P1, P2])).kind).toBe('choose_profile');
    expect(await connectionOf(t.teacherId)).toMatchObject({ organizationId: ORG_B.id, profileId: null });
    expect(await eventsOf(t.teacherId)).toEqual(before);
  });

  it('reconnecting to the same organization keeps the previous live profile among several, live, with no event', async () => {
    const t = await freshTeacher();
    await connect(t, ORG_A, [P1, P2]);
    const choice = await chooseProfile(prisma, liveDeps, { teacherId: t.teacherId, profileId: P2.id });
    expect(choice.kind).toBe('chosen');
    const before = await eventsOf(t.teacherId);
    expect(await connect(t, ORG_A, [P1, P2])).toEqual({ kind: 'connected', teacherId: t.teacherId, eventId: null });
    expect(await connectionOf(t.teacherId)).toMatchObject({ profileId: P2.id, disconnectedAt: null });
    expect(await eventsOf(t.teacherId)).toEqual(before);
  });

  it.each([
    ['unknown', async (t: Fixture) => ({ state: 'never-issued', sessionId: t.sessionId, at: now })],
    ['expired', async (t: Fixture) => {
      const { authorizeUrl } = await startConnect(prisma, liveDeps, { teacherId: t.teacherId, sessionId: t.sessionId, now });
      return { state: stateOf(authorizeUrl), sessionId: t.sessionId, at: later(OAUTH_STATE_TTL_MS) };
    }],
  ] as const)('refuses an %s state without calling Mollie', async (_name, arrange) => {
    const t = await freshTeacher();
    mollieAnswers(ORG_A, [P1]);
    const { state, sessionId, at } = await arrange(t);
    const outcome = await completeConnect(prisma, liveDeps, { state, code: 'code_x', sessionId, now: at });
    expect(outcome).toMatchObject({ kind: 'refused', refusal: { code: 'OAUTH_STATE_INVALID' } });
    expect(fake.exchangeCode).not.toHaveBeenCalled();
  });

  it('refuses a state bound to another session, without calling Mollie or burning the state', async () => {
    const t = await freshTeacher();
    const stranger = await newSession(t.accountId);
    mollieAnswers(ORG_A, [P1]);
    const { authorizeUrl } = await startConnect(prisma, liveDeps, { teacherId: t.teacherId, sessionId: t.sessionId, now });
    const outcome = await completeConnect(prisma, liveDeps, { state: stateOf(authorizeUrl), code: 'code_x', sessionId: stranger, now });
    expect(outcome).toMatchObject({ kind: 'refused', refusal: { code: 'OAUTH_STATE_INVALID' } });
    expect(fake.exchangeCode).not.toHaveBeenCalled();
    expect(await prisma.oAuthState.count({ where: { stateHash: hashToken(stateOf(authorizeUrl)) } })).toBe(1);
  });

  it('refuses a state the second time it is used', async () => {
    const t = await freshTeacher();
    mollieAnswers(ORG_A, [P1]);
    const { authorizeUrl } = await startConnect(prisma, liveDeps, { teacherId: t.teacherId, sessionId: t.sessionId, now });
    const input = { state: stateOf(authorizeUrl), code: 'code_x', sessionId: t.sessionId, now };
    expect((await completeConnect(prisma, liveDeps, input)).kind).toBe('connected');
    expect(await completeConnect(prisma, liveDeps, input)).toMatchObject({ kind: 'refused', refusal: { code: 'OAUTH_STATE_INVALID' } });
  });

  it('reconnecting to the same organization and profile while live writes no event', async () => {
    const t = await freshTeacher();
    await connect(t, ORG_A, [P1]);
    expect(await connect(t, ORG_A, [P1])).toEqual({ kind: 'connected', teacherId: t.teacherId, eventId: null });
    expect(await eventsOf(t.teacherId)).toHaveLength(1);
  });

  it('reconnecting to a different organization records the change, naming the old organization', async () => {
    const t = await freshTeacher();
    await connect(t, ORG_A, [P1]);
    const outcome = await connect(t, ORG_B, [P2]);
    const events = await eventsOf(t.teacherId);
    expect(outcome).toEqual({ kind: 'connected', teacherId: t.teacherId, eventId: events[1]?.id });
    expect(events[1]).toMatchObject({ kind: 'processor_changed', before: 'org_…1111 · pfl_…1111', after: 'org_…2222 · Retreats', identifierChanged: true });
  });

  it('reconnecting after a disconnect records a fresh connection and clears the disconnect', async () => {
    const t = await freshTeacher();
    await connect(t, ORG_A, [P1]);
    await disconnect(prisma, { teacherId: t.teacherId, now });
    await prisma.processorConnection.update({
      where: { teacherId: t.teacherId },
      data: { accessToken: null, refreshToken: null, accessTokenExpiresAt: null, revokedAt: now },
    });
    await connect(t, ORG_A, [P1]);
    const events = await eventsOf(t.teacherId);
    expect(events.map((e) => e.kind)).toEqual(['processor_connected', 'processor_disconnected', 'processor_connected']);
    expect(events[2]?.before).toBeNull();
    expect(await connectionOf(t.teacherId)).toMatchObject({ disconnectedAt: null, revokeAfter: null, revokedAt: null });
  });

  it('refuses an expired code without writing a connection', async () => {
    const t = await freshTeacher();
    fake.exchangeCode.mockResolvedValue({ kind: 'invalid_grant' });
    const { authorizeUrl } = await startConnect(prisma, liveDeps, { teacherId: t.teacherId, sessionId: t.sessionId, now });
    const outcome = await completeConnect(prisma, liveDeps, { state: stateOf(authorizeUrl), code: 'stale', sessionId: t.sessionId, now });
    expect(outcome).toMatchObject({ kind: 'refused', refusal: { code: 'OAUTH_STATE_INVALID' } });
    expect(await prisma.processorConnection.count({ where: { teacherId: t.teacherId } })).toBe(0);
  });

  it.each([
    ['the exchange', () => fake.exchangeCode.mockRejectedValue(new MollieUnavailable('down', 401)), { operation: 'exchangeCode', status: 401 }],
    ['the organization read', () => {
      fake.exchangeCode.mockResolvedValue({ kind: 'granted', grant: FULL_GRANT });
      fake.organization.mockRejectedValue(new MollieUnavailable('down', null));
    }, { operation: 'organization' }],
    ['the profiles read', () => {
      mollieAnswers(ORG_A, [P1]);
      fake.profiles.mockRejectedValue(new MollieUnavailable('down', 503));
    }, { operation: 'profiles', status: 503 }],
  ] as const)('answers unavailable, writes no connection and logs MOLLIE_UNAVAILABLE when Mollie fails %s', async (_name, arrange, context) => {
    const t = await freshTeacher();
    arrange();
    fake.revoke.mockResolvedValue(undefined);
    const { authorizeUrl } = await startConnect(prisma, liveDeps, { teacherId: t.teacherId, sessionId: t.sessionId, now });
    const outcome = await completeConnect(prisma, liveDeps, { state: stateOf(authorizeUrl), code: 'code_x', sessionId: t.sessionId, now });
    expect(outcome).toEqual({ kind: 'unavailable' });
    expect(await prisma.processorConnection.count({ where: { teacherId: t.teacherId } })).toBe(0);
    expect(vi.mocked(logDegraded).mock.calls).toEqual([['MOLLIE_UNAVAILABLE', context, expect.any(String), expect.any(MollieUnavailable)]]);
  });

  it.each([
    ['the organization read fails', () => fake.organization.mockRejectedValue(new MollieUnavailable('down', 503))],
    ['the profiles read fails', () => fake.profiles.mockRejectedValue(new MollieUnavailable('down', null))],
  ] as const)('revokes the grant it just exchanged when %s, since nothing stores it', async (_name, arrange) => {
    const t = await freshTeacher();
    mollieAnswers(ORG_A, [P1], { ...FULL_GRANT, refreshToken: 'refresh_dropped' });
    arrange();
    fake.revoke.mockResolvedValue(undefined);
    const { authorizeUrl } = await startConnect(prisma, liveDeps, { teacherId: t.teacherId, sessionId: t.sessionId, now });
    expect(await completeConnect(prisma, liveDeps, { state: stateOf(authorizeUrl), code: 'c', sessionId: t.sessionId, now })).toEqual({ kind: 'unavailable' });
    await vi.waitFor(() => expect(fake.revoke).toHaveBeenCalledWith('refresh_dropped'));
  });

  it('revokes the grant it just exchanged when the teacher was erased meanwhile', async () => {
    const t = await freshTeacher();
    mollieAnswers(ORG_A, [P1], { ...FULL_GRANT, refreshToken: 'refresh_orphan' });
    fake.revoke.mockResolvedValue(undefined);
    const { authorizeUrl } = await startConnect(prisma, liveDeps, { teacherId: t.teacherId, sessionId: t.sessionId, now });
    fake.organization.mockImplementation(async () => {
      await prisma.teacher.update({ where: { id: t.teacherId }, data: { deletedAt: now } });
      return ORG_A;
    });
    const outcome = await completeConnect(prisma, liveDeps, { state: stateOf(authorizeUrl), code: 'c', sessionId: t.sessionId, now });
    expect(outcome).toMatchObject({ kind: 'refused', refusal: { code: 'OAUTH_STATE_INVALID' } });
    expect(await prisma.processorConnection.count({ where: { teacherId: t.teacherId } })).toBe(0);
    await vi.waitFor(() => expect(fake.revoke).toHaveBeenCalledWith('refresh_orphan'));
  });

  it('revokes the grant a reconnect replaced, and never the one it stored', async () => {
    const t = await freshTeacher();
    await connect(t, ORG_A, [P1]);
    fake.revoke.mockResolvedValue(undefined);
    mollieAnswers(ORG_B, [P2], { ...FULL_GRANT, refreshToken: 'refresh_2' });
    const { authorizeUrl } = await startConnect(prisma, liveDeps, { teacherId: t.teacherId, sessionId: t.sessionId, now });
    await completeConnect(prisma, liveDeps, { state: stateOf(authorizeUrl), code: 'c', sessionId: t.sessionId, now });
    await vi.waitFor(() => expect(fake.revoke).toHaveBeenCalledWith('refresh_1'));
    expect(fake.revoke).not.toHaveBeenCalledWith('refresh_2');
    expect(openToken((await connectionOf(t.teacherId)).refreshToken!, key)).toBe('refresh_2');
  });

  it('revokes nothing when the replaced row was already revoked, or on a first connect', async () => {
    const t = await freshTeacher();
    await connect(t, ORG_A, [P1]);
    await disconnect(prisma, { teacherId: t.teacherId, now });
    await prisma.processorConnection.update({
      where: { teacherId: t.teacherId },
      data: { accessToken: null, refreshToken: null, accessTokenExpiresAt: null, revokedAt: now },
    });
    await connect(t, ORG_A, [P1]);
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.revoke).not.toHaveBeenCalled();
  });

  it('logs a failed revoke of a dropped grant and retries nothing', async () => {
    const t = await freshTeacher();
    await connect(t, ORG_A, [P1]);
    fake.revoke.mockRejectedValue(new MollieUnavailable('down', null));
    mollieAnswers(ORG_B, [P2], { ...FULL_GRANT, refreshToken: 'refresh_2' });
    const { authorizeUrl } = await startConnect(prisma, liveDeps, { teacherId: t.teacherId, sessionId: t.sessionId, now });
    await completeConnect(prisma, liveDeps, { state: stateOf(authorizeUrl), code: 'c', sessionId: t.sessionId, now });
    await vi.waitFor(() => {
      const call = vi.mocked(logDegraded).mock.calls.find(([code]) => code === 'MOLLIE_UNAVAILABLE');
      expect(call?.[1]).toEqual({ connectionId: expect.any(String), operation: 'revoke' });
    });
    expect(fake.revoke).toHaveBeenCalledTimes(1);
  });

  it('forgets the connection’s cached methods once the rewrite has committed', async () => {
    const t = await freshTeacher();
    await connect(t, ORG_A, [P1]);
    expect(forgetOfferedMethods).toHaveBeenCalledWith((await connectionOf(t.teacherId)).id);
  });
});

describe('chooseProfile', () => {
  it('on a row awaiting a profile sets it and records a connection', async () => {
    const t = await freshTeacher();
    await connect(t, ORG_A, [P1, P2]);
    const outcome = await chooseProfile(prisma, liveDeps, { teacherId: t.teacherId, profileId: P2.id });
    const events = await eventsOf(t.teacherId);
    expect(outcome).toEqual({ kind: 'chosen', eventId: events[0]?.id });
    expect((await connectionOf(t.teacherId)).profileId).toBe(P2.id);
    expect(events).toEqual([
      { id: expect.any(String), kind: 'processor_connected', before: null, after: payoutIdentityLabel({ organizationId: ORG_A.id, profileId: P2.id }, [P1, P2]), identifierChanged: null },
    ]);
  });

  it('on a live row switches the profile and records the change, naming the previous profile', async () => {
    const t = await freshTeacher();
    await connect(t, ORG_A, [P1, P2]);
    await chooseProfile(prisma, liveDeps, { teacherId: t.teacherId, profileId: P1.id });
    expect((await chooseProfile(prisma, liveDeps, { teacherId: t.teacherId, profileId: P2.id })).kind).toBe('chosen');
    const events = await eventsOf(t.teacherId);
    expect(events[1]).toMatchObject({ kind: 'processor_changed', before: 'org_…1111 · Studio Anna', after: 'org_…1111 · Retreats', identifierChanged: true });
  });

  it('answers unknown_profile for an id Mollie does not list, and writes nothing', async () => {
    const t = await freshTeacher();
    await connect(t, ORG_A, [P1, P2]);
    expect(await chooseProfile(prisma, liveDeps, { teacherId: t.teacherId, profileId: 'pfl_nope0000' })).toEqual({ kind: 'unknown_profile' });
    expect((await connectionOf(t.teacherId)).profileId).toBeNull();
    expect(await eventsOf(t.teacherId)).toEqual([]);
  });

  it('answers unverified_profile for a listed unverified profile in live mode, and writes nothing', async () => {
    const t = await freshTeacher();
    await connect(t, ORG_A, [P1, P_UNVERIFIED]);
    expect(await chooseProfile(prisma, liveDeps, { teacherId: t.teacherId, profileId: P_UNVERIFIED.id })).toEqual({ kind: 'unverified_profile' });
    expect((await connectionOf(t.teacherId)).profileId).toBeNull();
    expect(await eventsOf(t.teacherId)).toEqual([]);
  });

  it('answers unknown_profile for a test profile in live mode', async () => {
    const t = await freshTeacher();
    await connect(t, ORG_A, [P1, P2]);
    fake.profiles.mockResolvedValue([P1, P2, P_TEST]);
    expect(await chooseProfile(prisma, liveDeps, { teacherId: t.teacherId, profileId: P_TEST.id })).toEqual({ kind: 'unknown_profile' });
  });

  it('answers unchanged for the profile already set, and writes nothing', async () => {
    const t = await freshTeacher();
    await connect(t, ORG_A, [P1, P2]);
    await chooseProfile(prisma, liveDeps, { teacherId: t.teacherId, profileId: P1.id });
    expect(await chooseProfile(prisma, liveDeps, { teacherId: t.teacherId, profileId: P1.id })).toEqual({ kind: 'unchanged' });
    expect(await eventsOf(t.teacherId)).toHaveLength(1);
  });

  it('answers not_connected for a disconnected row, or none', async () => {
    const t = await freshTeacher();
    expect(await chooseProfile(prisma, liveDeps, { teacherId: t.teacherId, profileId: P1.id })).toEqual({ kind: 'not_connected' });
    await connect(t, ORG_A, [P1, P2]);
    await disconnect(prisma, { teacherId: t.teacherId, now });
    expect(await chooseProfile(prisma, liveDeps, { teacherId: t.teacherId, profileId: P1.id })).toEqual({ kind: 'not_connected' });
  });

  it('answers unavailable when Mollie cannot list the profiles', async () => {
    const t = await freshTeacher();
    await connect(t, ORG_A, [P1, P2]);
    fake.profiles.mockRejectedValue(new MollieUnavailable('down', 502));
    expect(await chooseProfile(prisma, liveDeps, { teacherId: t.teacherId, profileId: P1.id })).toEqual({ kind: 'unavailable' });
    expect(vi.mocked(logDegraded).mock.calls).toEqual([
      ['MOLLIE_UNAVAILABLE', { connectionId: (await connectionOf(t.teacherId)).id, operation: 'profiles', status: 502 }, expect.any(String), expect.any(MollieUnavailable)],
    ]);
  });
});

describe('disconnect', () => {
  it('with no open attempts disconnects now, records it, and says the grant can be revoked at once', async () => {
    const t = await freshTeacher();
    await connect(t, ORG_A, [P1]);
    const outcome = await disconnect(prisma, { teacherId: t.teacherId, now });
    const row = await connectionOf(t.teacherId);
    const events = await eventsOf(t.teacherId);
    expect(outcome).toEqual({ kind: 'disconnected', eventId: events[1]?.id, connectionId: row.id, revokeNow: true });
    expect(row).toMatchObject({ disconnectedAt: now, revokeAfter: now });
    expect(events[1]).toMatchObject({ kind: 'processor_disconnected', before: 'org_…1111', after: null });
    expect(await disconnect(prisma, { teacherId: t.teacherId, now })).toEqual({ kind: 'unchanged' });
  });

  it('of a row still awaiting its profile writes no event, since no payout identity was live', async () => {
    const t = await freshTeacher();
    await connect(t, ORG_A, [P1, P2]);
    const outcome = await disconnect(prisma, { teacherId: t.teacherId, now });
    expect(outcome).toMatchObject({ kind: 'disconnected', eventId: null, revokeNow: true });
    expect((await connectionOf(t.teacherId)).disconnectedAt).toEqual(now);
    expect(await eventsOf(t.teacherId)).toEqual([]);
  });

  it('with an open attempt defers the revoke until it expires, keeping the tokens', async () => {
    const t = await freshTeacher();
    await connect(t, ORG_A, [P1]);
    const expiry = later(15 * 60_000);
    const conn = await connectionOf(t.teacherId);
    await seedAttempt(t.teacherId, conn.id, 'open', expiry);
    await seedAttempt(t.teacherId, conn.id, 'paid', later(60 * 60_000));
    const outcome = await disconnect(prisma, { teacherId: t.teacherId, now });
    expect(outcome).toMatchObject({ kind: 'disconnected', revokeNow: false });
    const row = await connectionOf(t.teacherId);
    expect(row.revokeAfter).toEqual(expiry);
    expect(row.accessToken).not.toBeNull();
    expect(row.refreshToken).not.toBeNull();
  });

  it('with a refund still live at Mollie does not offer to revoke at once', async () => {
    const t = await freshTeacher();
    await connect(t, ORG_A, [P1]);
    await seedRefund(t.teacherId, (await connectionOf(t.teacherId)).id, 'pending');
    expect(await disconnect(prisma, { teacherId: t.teacherId, now })).toMatchObject({ kind: 'disconnected', revokeNow: false });
  });

  it('with a pending attempt past its expiry does not offer to revoke at once', async () => {
    const t = await freshTeacher();
    await connect(t, ORG_A, [P1]);
    await seedAttempt(t.teacherId, (await connectionOf(t.teacherId)).id, 'pending', later(-60 * 60_000));
    const outcome = await disconnect(prisma, { teacherId: t.teacherId, now });
    expect(outcome).toMatchObject({ kind: 'disconnected', revokeNow: false });
    expect((await connectionOf(t.teacherId)).revokeAfter).toEqual(now);
  });

  it('answers unchanged for a teacher with no connection, and teacher_gone for an erased one', async () => {
    const t = await freshTeacher();
    expect(await disconnect(prisma, { teacherId: t.teacherId, now })).toEqual({ kind: 'unchanged' });
    await prisma.teacher.update({ where: { id: t.teacherId }, data: { deletedAt: now } });
    expect(await disconnect(prisma, { teacherId: t.teacherId, now })).toEqual({ kind: 'teacher_gone' });
  });
});

describe('revokeDueConnection', () => {
  it('revokes the refresh token at Mollie, then nulls the tokens and stamps revokedAt', async () => {
    const t = await freshTeacher();
    const c = await seedDisconnected(t.teacherId, now);
    fake.revoke.mockResolvedValue(undefined);
    expect(await revokeDueConnection(prisma, liveDeps, c.id, now)).toBe('revoked');
    expect(fake.revoke).toHaveBeenCalledWith('refresh_old');
    expect(await connectionOf(t.teacherId)).toMatchObject({ accessToken: null, refreshToken: null, accessTokenExpiresAt: null, revokedAt: now });
  });

  it('leaves the row as it was when Mollie fails, so a later revoke can retry', async () => {
    const t = await freshTeacher();
    const c = await seedDisconnected(t.teacherId, now);
    fake.revoke.mockRejectedValue(new MollieUnavailable('down', null));
    expect(await revokeDueConnection(prisma, liveDeps, c.id, now)).toBe('unavailable');
    const row = await connectionOf(t.teacherId);
    expect(row.revokedAt).toBeNull();
    expect(openToken(row.refreshToken!, key)).toBe('refresh_old');
    expect(vi.mocked(logDegraded).mock.calls.map(([code]) => code)).toContain('MOLLIE_UNAVAILABLE');
  });

  it('keeps the new grant of a reconnect that rewrote the row while the revoke was in flight', async () => {
    const t = await freshTeacher();
    const c = await seedDisconnected(t.teacherId, now);
    fake.revoke.mockImplementation(async () => {
      await prisma.processorConnection.update({
        where: { id: c.id },
        data: { ...sealGrant({ ...FULL_GRANT, refreshToken: 'refresh_new' }, key, now), disconnectedAt: null, revokeAfter: null, revokedAt: null },
      });
    });
    expect(await revokeDueConnection(prisma, liveDeps, c.id, now)).toBe('skipped');
    const row = await connectionOf(t.teacherId);
    expect(row).toMatchObject({ disconnectedAt: null, revokedAt: null });
    expect(openToken(row.refreshToken!, key)).toBe('refresh_new');
  });

  it('keeps the new grant of a reconnect that was disconnected again while the revoke was in flight', async () => {
    const t = await freshTeacher();
    const c = await seedDisconnected(t.teacherId, now);
    fake.revoke.mockImplementation(async () => {
      await prisma.processorConnection.update({
        where: { id: c.id },
        data: { ...sealGrant({ ...FULL_GRANT, refreshToken: 'refresh_new' }, key, now), disconnectedAt: now, revokeAfter: later(60_000), revokedAt: null },
      });
    });
    expect(await revokeDueConnection(prisma, liveDeps, c.id, now)).toBe('skipped');
    const row = await connectionOf(t.teacherId);
    expect(row.revokedAt).toBeNull();
    expect(openToken(row.refreshToken!, key)).toBe('refresh_new');
  });

  it('calls Mollie for nothing that is not disconnected, not yet due, or already revoked', async () => {
    const live = await freshTeacher();
    const liveRow = await prisma.processorConnection.create({
      data: { teacherId: live.teacherId, processor: 'mollie', organizationId: ORG_A.id, profileId: P1.id, scopes: [...MOLLIE_SCOPES], testmode: false, ...sealGrant(FULL_GRANT, key, now) },
    });
    const notDue = await freshTeacher();
    const notDueRow = await seedDisconnected(notDue.teacherId, later(60_000));
    expect(await revokeDueConnection(prisma, liveDeps, liveRow.id, now)).toBe('skipped');
    expect(await revokeDueConnection(prisma, liveDeps, notDueRow.id, now)).toBe('skipped');
    expect(fake.revoke).not.toHaveBeenCalled();
  });
});

describe('revokeDueConnection while Mollie still owes a webhook', () => {
  async function disconnectedWith(arrange: (teacherId: string, connectionId: string) => Promise<unknown>, disconnectedAt = later(-60_000)) {
    const t = await freshTeacher();
    const c = await seedDisconnected(t.teacherId, now);
    await prisma.processorConnection.update({ where: { id: c.id }, data: { disconnectedAt } });
    await arrange(t.teacherId, c.id);
    return { t, c };
  }

  it.each(['pending', 'processing'] as const)('defers for a %s refund: no Mollie call, tokens kept, asked again a day on', async (status) => {
    const { t, c } = await disconnectedWith((teacherId, id) => seedRefund(teacherId, id, status));
    expect(await revokeDueConnection(prisma, liveDeps, c.id, now)).toBe('deferred');
    expect(fake.revoke).not.toHaveBeenCalled();
    const row = await connectionOf(t.teacherId);
    expect(row.revokedAt).toBeNull();
    expect(openToken(row.refreshToken!, key)).toBe('refresh_old');
    expect(row.revokeAfter).toEqual(new Date(now.getTime() + REVOKE_RETRY_MS));
  });

  it('defers for a pending attempt past its expiry', async () => {
    const { c } = await disconnectedWith((teacherId, id) => seedAttempt(teacherId, id, 'pending', later(-60 * 60_000)));
    expect(await revokeDueConnection(prisma, liveDeps, c.id, now)).toBe('deferred');
    expect(fake.revoke).not.toHaveBeenCalled();
  });

  it('revokes once the refund has finished', async () => {
    let refundId = '';
    const { t, c } = await disconnectedWith(async (teacherId, id) => {
      refundId = (await seedRefund(teacherId, id, 'pending')).id;
    });
    expect(await revokeDueConnection(prisma, liveDeps, c.id, now)).toBe('deferred');
    await prisma.processorRefund.update({ where: { id: refundId }, data: { status: 'refunded' } });
    fake.revoke.mockResolvedValue('revoked');
    const dayOn = new Date(now.getTime() + REVOKE_RETRY_MS);
    expect(await revokeDueConnection(prisma, liveDeps, c.id, dayOn)).toBe('revoked');
    expect((await connectionOf(t.teacherId)).revokedAt).toEqual(dayOn);
  });

  it('revokes regardless past the 30-day cap, and logs what was still live', async () => {
    const warn = vi.spyOn(log, 'warn');
    onTestFinished(() => warn.mockRestore());
    const { t, c } = await disconnectedWith(
      (teacherId, id) => seedRefund(teacherId, id, 'processing'),
      new Date(now.getTime() - REVOKE_DEFER_CAP_MS - 60_000),
    );
    fake.revoke.mockResolvedValue('revoked');
    expect(await revokeDueConnection(prisma, liveDeps, c.id, now)).toBe('revoked');
    expect((await connectionOf(t.teacherId)).revokedAt).toEqual(now);
    expect(warn).toHaveBeenCalledWith({ connectionId: c.id, attempts: 0, refunds: 1 }, expect.any(String));
  });

  it('keeps the tokens and defers when a refund turns live while Mollie is called', async () => {
    const t = await freshTeacher();
    const c = await seedDisconnected(t.teacherId, now);
    fake.revoke.mockImplementation(async () => {
      await seedRefund(t.teacherId, c.id, 'pending');
      return 'revoked';
    });
    expect(await revokeDueConnection(prisma, liveDeps, c.id, now)).toBe('deferred');
    const row = await connectionOf(t.teacherId);
    expect(row.revokedAt).toBeNull();
    expect(row.refreshToken).not.toBeNull();
  });

  it('counts a deferral as skipped in the sweep, which then does not throw', async () => {
    const { c } = await disconnectedWith((teacherId, id) => seedRefund(teacherId, id, 'pending'));
    const s = scopeSweep(prisma, { ProcessorConnection: { id: { in: [c.id] } } });
    expect(await revokeDueConnections(s.db, now, liveDeps)).toEqual({ revoked: 0, failed: 0, skipped: 1 });
  });
});

describe('revokeDueConnection when Mollie answers 4xx', () => {
  it('counts a 400 (Mollie holds no grant for the token) as revoked, with a warning', async () => {
    const warn = vi.spyOn(log, 'warn');
    onTestFinished(() => warn.mockRestore());
    const t = await freshTeacher();
    const c = await seedDisconnected(t.teacherId, now);
    fake.revoke.mockResolvedValue('invalid_token');
    expect(await revokeDueConnection(prisma, liveDeps, c.id, now)).toBe('revoked');
    expect((await connectionOf(t.teacherId)).revokedAt).toEqual(now);
    expect(warn).toHaveBeenCalledWith({ connectionId: c.id }, expect.any(String));
  });

  it('past the 30-day cap forgets the tokens of a grant Mollie cannot revoke', async () => {
    const t = await freshTeacher();
    const c = await seedDisconnected(t.teacherId, now);
    await prisma.processorConnection.update({ where: { id: c.id }, data: { disconnectedAt: new Date(now.getTime() - REVOKE_DEFER_CAP_MS - 60_000) } });
    fake.revoke.mockRejectedValue(new MollieUnavailable('down', 503));
    expect(await revokeDueConnection(prisma, liveDeps, c.id, now)).toBe('revoked');
    expect(await connectionOf(t.teacherId)).toMatchObject({ refreshToken: null, revokedAt: now });
  });

  it.each([401, 403])('leaves the row due and logs at error for a %i (fair.yoga’s client credentials)', async (status) => {
    const error = vi.spyOn(log, 'error');
    onTestFinished(() => error.mockRestore());
    const t = await freshTeacher();
    const c = await seedDisconnected(t.teacherId, now);
    fake.revoke.mockRejectedValue(new MollieUnavailable(`Mollie answered ${status}`, status));
    expect(await revokeDueConnection(prisma, liveDeps, c.id, now)).toBe('unavailable');
    expect((await connectionOf(t.teacherId)).revokedAt).toBeNull();
    expect(error).toHaveBeenCalledWith({ connectionId: c.id, status }, expect.any(String));
    expect(logDegraded).not.toHaveBeenCalled();
  });
});

describe('revokeConnection', () => {
  it('revokes in the background', async () => {
    const t = await freshTeacher();
    const c = await seedDisconnected(t.teacherId, later(-1000));
    fake.revoke.mockResolvedValue(undefined);
    revokeConnection(prisma, liveDeps, c.id);
    await vi.waitFor(async () => expect((await connectionOf(t.teacherId)).revokedAt).not.toBeNull());
  });
});

describe('readConnectionView', () => {
  beforeEach(() => {
    fake.listMethods.mockResolvedValue({ kind: 'methods', methods: ['ideal', 'klarna', 'wero'].map((id) => ({ id, description: null })) });
  });

  it('is none without a connection, or after a disconnect', async () => {
    const t = await freshTeacher();
    expect(await readConnectionView(prisma, liveDeps, t.teacherId)).toEqual({ kind: 'none' });
    await connect(t, ORG_A, [P1]);
    await disconnect(prisma, { teacherId: t.teacherId, now });
    expect(await readConnectionView(prisma, liveDeps, t.teacherId)).toEqual({ kind: 'none' });
  });

  it('lists the listed profiles of a row awaiting one', async () => {
    const t = await freshTeacher();
    await connect(t, ORG_A, [P1, P2]);
    expect(await readConnectionView(prisma, liveDeps, t.teacherId)).toEqual({
      kind: 'choose_profile', profiles: [OPTION_P1, OPTION_P2],
    });
  });

  it('lists an unverified profile as not choosable with its website, and leaves a blocked one out', async () => {
    const t = await freshTeacher();
    await connect(t, ORG_A, [P1, P_UNVERIFIED]);
    fake.profiles.mockResolvedValue([P1, P_UNVERIFIED, { ...P2, status: 'blocked' }]);
    expect(await readConnectionView(prisma, liveDeps, t.teacherId)).toEqual({
      kind: 'choose_profile',
      profiles: [OPTION_P1, { id: P_UNVERIFIED.id, name: P_UNVERIFIED.name, website: 'https://zwem.men', choosable: false }],
    });
  });

  it('describes a live connection with the methods students see and the ones left out', async () => {
    const t = await freshTeacher();
    await connect(t, ORG_A, [P1, P2]);
    await chooseProfile(prisma, liveDeps, { teacherId: t.teacherId, profileId: P1.id });
    expect(await readConnectionView(prisma, liveDeps, t.teacherId)).toEqual({
      kind: 'connected', organizationName: ORG_A.name, profileId: P1.id, profileName: P1.name, testmode: false,
      profiles: [OPTION_P1, OPTION_P2],
      offered: ['ideal', 'wero'], excluded: [{ id: 'klarna', description: null }], takesPayments: true,
    });
    expect(fake.listMethods).toHaveBeenCalledWith('access_1', { profileId: P1.id, amount: { value: '10.00', currency: 'EUR' }, testmode: false });
  });

  it('asks for a reconnect and lists no methods for a narrower grant', async () => {
    const t = await freshTeacher();
    mollieAnswers(ORG_A, [P1], { ...FULL_GRANT, scopes: ['payments.read', 'profiles.read', 'organizations.read'] });
    const { authorizeUrl } = await startConnect(prisma, liveDeps, { teacherId: t.teacherId, sessionId: t.sessionId, now });
    await completeConnect(prisma, liveDeps, { state: stateOf(authorizeUrl), code: 'c', sessionId: t.sessionId, now });
    const view = await readConnectionView(prisma, liveDeps, t.teacherId);
    expect(view).toMatchObject({ kind: 'connected', offered: [], excluded: [], takesPayments: false });
    expect(fake.listMethods).not.toHaveBeenCalled();
  });

  it('asks for a reconnect and lists no methods for a connection made in the other mode than the server now runs in', async () => {
    const t = await freshTeacher();
    await connect(t, ORG_A, [P1], testDeps);
    const view = await readConnectionView(prisma, liveDeps, t.teacherId);
    expect(view).toMatchObject({ kind: 'connected', testmode: true, offered: [], excluded: [], takesPayments: false });
    expect(fake.listMethods).not.toHaveBeenCalled();
  });

  it.each([
    ['the organization', () => fake.organization.mockRejectedValue(new MollieUnavailable('down', 503)), { operation: 'organization', status: 503 }],
    ['the profiles', () => fake.profiles.mockRejectedValue(new MollieUnavailable('down', null)), { operation: 'profiles' }],
    ['both reads, logging once for the organization', () => {
      fake.organization.mockRejectedValue(new MollieUnavailable('down', 500));
      fake.profiles.mockRejectedValue(new MollieUnavailable('down', 502));
    }, { operation: 'organization', status: 500 }],
  ] as const)('is unavailable and logs MOLLIE_UNAVAILABLE once when Mollie cannot answer %s', async (_name, arrange, context) => {
    const t = await freshTeacher();
    await connect(t, ORG_A, [P1]);
    vi.mocked(logDegraded).mockClear();
    arrange();
    expect(await readConnectionView(prisma, liveDeps, t.teacherId)).toEqual({ kind: 'unavailable' });
    expect(vi.mocked(logDegraded).mock.calls).toEqual([
      ['MOLLIE_UNAVAILABLE', { connectionId: (await connectionOf(t.teacherId)).id, ...context }, expect.any(String), expect.any(MollieUnavailable)],
    ]);
  });

  it('rethrows a failure that is not Mollie being unavailable', async () => {
    const t = await freshTeacher();
    await connect(t, ORG_A, [P1]);
    fake.profiles.mockRejectedValue(new TypeError('bug'));
    await expect(readConnectionView(prisma, liveDeps, t.teacherId)).rejects.toThrow('bug');
  });
});
