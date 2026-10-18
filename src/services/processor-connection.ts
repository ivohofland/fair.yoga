import { randomBytes } from 'node:crypto';
import { Prisma, type PrismaClient } from '@/lib/prisma-client';
import { hashToken } from '@/lib/auth/magic-link';
import { lockTeacherForNoKeyUpdate } from '@/lib/db-locks';
import { codedRefusal, type CodedRefusal } from '@/lib/api-error-codes';
import { MollieUnavailable, type MollieProfile, type TokenGrant } from '@/lib/mollie/client';
import { livePayoutIdentity, missingMollieScopes, MOLLIE_SCOPES, type LiveIdentity } from '@/lib/processor-liveness';
import type { AllowedMollieMethod } from '@/lib/processor-methods';
import { openToken, TokenCipherError } from '@/lib/processor-token-cipher';
import { logDegraded } from '@/lib/degradation';
import { log } from '@/lib/log';
import type { FireAndForget } from '@/lib/fire-and-forget';
import type { MollieDeps } from './mollie-deps';
import { getAccessToken, sealGrant } from './processor-token';
import { forgetOfferedMethods } from './processor-methods-cache';
import { listOfferedMethods } from './processor-methods-offer';

export { MOLLIE_SCOPES, type LiveIdentity } from '@/lib/processor-liveness';

export const OAUTH_STATE_TTL_MS = 10 * 60_000;

/** The attempt statuses whose webhooks may still arrive, so whose connection keeps its token. */
const UNFINISHED_ATTEMPT_STATUSES = ['open', 'pending', 'authorized'] as const;

/** The amount the settings section asks Mollie's methods for. */
const VIEW_AMOUNT = new Prisma.Decimal('10.00');

/** Where Mollie sends the teacher back after the consent screen. */
export function mollieRedirectUri(appUrl: string): string {
  return `${appUrl}/api/processor/mollie/callback`;
}

/** `org_…` and the id's last four characters. */
export function maskOrganizationId(id: string): string {
  return `org_…${id.slice(-4)}`;
}

/** `pfl_…` and the id's last four characters. */
export function maskProfileId(id: string): string {
  return `pfl_…${id.slice(-4)}`;
}

/**
 * The identity as a payout-change event shows it: the masked organization and
 * the profile's name in `profiles`, or its masked id when the list lacks it.
 */
export function payoutIdentityLabel(identity: LiveIdentity, profiles: readonly { id: string; name: string }[]): string {
  const name = profiles.find((p) => p.id === identity.profileId)?.name ?? maskProfileId(identity.profileId);
  return `${maskOrganizationId(identity.organizationId)} · ${name}`;
}

/**
 * Writes an `OAuthState` bound to the session and answers Mollie's authorize
 * URL. A teacher who already has a connection row, in any state, is
 * reconnecting, so the consent screen is forced: it shows the scopes again and
 * replaces the earlier authorization. On a first connect it would be an extra
 * screen for nothing.
 */
export async function startConnect(
  db: PrismaClient,
  deps: MollieDeps,
  input: { teacherId: string; sessionId: string; now?: Date },
): Promise<{ authorizeUrl: string }> {
  const now = input.now ?? new Date();
  const state = randomBytes(32).toString('hex');
  const existing = await db.processorConnection.findUnique({ where: { teacherId: input.teacherId }, select: { id: true } });
  await db.oAuthState.create({
    data: {
      stateHash: hashToken(state),
      teacherId: input.teacherId,
      sessionId: input.sessionId,
      expiresAt: new Date(now.getTime() + OAUTH_STATE_TTL_MS),
    },
  });
  const authorizeUrl = deps.client.authorizeUrl({
    redirectUri: mollieRedirectUri(deps.config.appUrl),
    state,
    scopes: MOLLIE_SCOPES,
    forcePrompt: existing !== null,
  });
  return { authorizeUrl };
}

export type CompleteConnectOutcome =
  | { kind: 'connected'; teacherId: string; eventId: string | null }
  | { kind: 'choose_profile'; teacherId: string }
  | { kind: 'refused'; refusal: Extract<CodedRefusal, { code: 'OAUTH_STATE_INVALID' }> }
  | { kind: 'unavailable' };

/**
 * The OAuth callback's work. The state is consumed only by the session it was
 * bound to, before Mollie is called, so a stranger holding the link can
 * neither use it nor burn it. The code is exchanged and the organization and
 * profiles read outside any transaction; then, under the teacher lock, the
 * connection is rewritten and its profile decided against the live identity
 * read just before the write (spec §1). An event is written only when the live
 * identity becomes a new pair; the caller delivers its notice after commit.
 */
export async function completeConnect(
  db: PrismaClient,
  deps: MollieDeps,
  input: { state: string; code: string; sessionId: string; now?: Date },
): Promise<CompleteConnectOutcome> {
  const now = input.now ?? new Date();
  const refused = {
    kind: 'refused',
    refusal: codedRefusal('OAUTH_STATE_INVALID', 'That Mollie sign-in link has expired. Start connecting again from Settings.'),
  } as const;
  const state = await db.oAuthState.findUnique({
    where: { stateHash: hashToken(input.state) },
    select: { id: true, teacherId: true, sessionId: true, expiresAt: true },
  });
  if (!state || state.sessionId !== input.sessionId || state.expiresAt <= now) return refused;
  const consumed = await db.oAuthState.deleteMany({ where: { id: state.id, sessionId: input.sessionId } });
  if (consumed.count !== 1) return refused;

  let grant: TokenGrant;
  try {
    const answer = await deps.client.exchangeCode(input.code, mollieRedirectUri(deps.config.appUrl));
    if (answer.kind === 'invalid_grant') return refused;
    grant = answer.grant;
  } catch (err) {
    if (err instanceof MollieUnavailable) return { kind: 'unavailable' };
    throw err;
  }

  // From here the grant is live at Mollie: every exit that does not store it revokes it.
  let stored = false;
  try {
    let org: { id: string; name: string };
    let profiles: MollieProfile[];
    try {
      org = await deps.client.organization(grant.accessToken);
      profiles = usableProfiles(await deps.client.profiles(grant.accessToken), deps.config.testmode);
    } catch (err) {
      if (err instanceof MollieUnavailable) return { kind: 'unavailable' };
      throw err;
    }

    const result = await db.$transaction(async (tx): Promise<ConnectWrite> => {
      if (!(await lockTeacherForNoKeyUpdate(tx, state.teacherId))) return { outcome: refused, connectionId: null, replacedRefresh: null };
      const previous = await tx.processorConnection.findUnique({
        where: { teacherId: state.teacherId },
        select: { id: true, organizationId: true, profileId: true, disconnectedAt: true, refreshToken: true, revokedAt: true },
      });
      const previousLive = livePayoutIdentity(previous);
      const replacedRefresh = previous === null ? null : unrevokedRefresh(previous, deps);
      const profile = initialProfile(profiles, org.id, previousLive);
      const data = {
        processor: 'mollie' as const,
        organizationId: org.id,
        profileId: profile?.id ?? null,
        scopes: grant.scopes,
        testmode: deps.config.testmode,
        ...sealGrant(grant, deps.config.tokenKey, now),
        connectedAt: now,
        disconnectedAt: null,
        revokeAfter: null,
        revokedAt: null,
      };
      const row = await tx.processorConnection.upsert({
        where: { teacherId: state.teacherId },
        create: { teacherId: state.teacherId, ...data },
        update: data,
        select: { id: true },
      });
      if (profile === null) {
        return { outcome: { kind: 'choose_profile', teacherId: state.teacherId }, connectionId: row.id, replacedRefresh };
      }
      const next: LiveIdentity = { organizationId: org.id, profileId: profile.id };
      const eventId = sameIdentity(previousLive, next) ? null : await writeIdentityEvent(tx, state.teacherId, previousLive, next, profiles);
      return { outcome: { kind: 'connected', teacherId: state.teacherId, eventId }, connectionId: row.id, replacedRefresh };
    });
    if (result.connectionId === null) return result.outcome;
    stored = true;
    forgetOfferedMethods(result.connectionId);
    if (result.replacedRefresh !== null && result.replacedRefresh !== grant.refreshToken) {
      revokeDroppedGrant(deps, result.replacedRefresh, result.connectionId);
    }
    return result.outcome;
  } finally {
    if (!stored) revokeDroppedGrant(deps, grant.refreshToken, null);
  }
}

/** What the callback's transaction wrote: the outcome, the row (null when nothing was written) and the replaced grant's refresh token. */
type ConnectWrite = { outcome: CompleteConnectOutcome; connectionId: string | null; replacedRefresh: string | null };

/**
 * The plaintext refresh token of a row whose grant has not been revoked, or
 * null when it is revoked or its token cannot be opened (logged).
 */
function unrevokedRefresh(row: { id: string; refreshToken: Uint8Array | null; revokedAt: Date | null }, deps: MollieDeps): string | null {
  if (row.revokedAt !== null || row.refreshToken === null) return null;
  try {
    return openToken(row.refreshToken, deps.config.tokenKey);
  } catch (err) {
    if (!(err instanceof TokenCipherError)) throw err;
    logDegraded('PROCESSOR_TOKEN_UNREADABLE', { connectionId: row.id }, 'replaced processor token could not be opened, so it was not revoked', err);
    return null;
  }
}

/**
 * Revokes at Mollie a grant no row holds any more, without waiting. A failure
 * is logged and not retried: nothing is left to retry from.
 */
function revokeDroppedGrant(deps: MollieDeps, refreshToken: string, connectionId: string | null): FireAndForget {
  void (async () => {
    try {
      await deps.client.revoke(refreshToken);
    } catch (err) {
      if (!(err instanceof MollieUnavailable)) throw err;
      logDegraded(
        'MOLLIE_UNAVAILABLE',
        { ...(connectionId === null ? {} : { connectionId }), operation: 'revoke', ...(err.status === null ? {} : { status: err.status }) },
        'Mollie could not revoke a grant fair.yoga no longer holds; it stays authorized at Mollie',
        err,
      );
    }
  })().catch((err: unknown) => {
    log.error({ err, connectionId }, 'revoking a dropped Mollie grant failed');
  });
}

/** Profiles that can take payments here: never a blocked one, and in live mode only live ones. */
function usableProfiles(profiles: readonly MollieProfile[], testmode: boolean): MollieProfile[] {
  return profiles.filter((p) => p.status !== 'blocked' && (testmode || p.mode === 'live'));
}

function sameIdentity(a: LiveIdentity | null, b: LiveIdentity): boolean {
  return a !== null && a.organizationId === b.organizationId && a.profileId === b.profileId;
}

/** The profile a callback lands on: the only one, or the previous live one when the organization is unchanged and still lists it. */
function initialProfile(profiles: readonly MollieProfile[], organizationId: string, previousLive: LiveIdentity | null): MollieProfile | null {
  if (profiles.length === 1) return profiles[0] ?? null;
  if (previousLive === null || previousLive.organizationId !== organizationId) return null;
  return profiles.find((p) => p.id === previousLive.profileId) ?? null;
}

/** Writes the event for a live identity that has just become `next`. */
async function writeIdentityEvent(
  tx: Prisma.TransactionClient,
  teacherId: string,
  previousLive: LiveIdentity | null,
  next: LiveIdentity,
  profiles: readonly MollieProfile[],
): Promise<string> {
  const event = await tx.payoutChangeEvent.create({
    data: {
      teacherId,
      kind: previousLive === null ? 'processor_connected' : 'processor_changed',
      before: previousLive === null ? null : payoutIdentityLabel(previousLive, profiles),
      after: payoutIdentityLabel(next, profiles),
      identifierChanged: previousLive === null ? null : true,
    },
    select: { id: true },
  });
  return event.id;
}

export type ChooseProfileOutcome =
  | { kind: 'chosen'; eventId: string }
  | { kind: 'unchanged' }
  | { kind: 'not_connected' }
  | { kind: 'unknown_profile' }
  | { kind: 'unavailable' };

/**
 * Sets the connection's profile from the picker, or switches it on a live
 * row. The profile list is fetched before the transaction, so no lock is held
 * across a Mollie call; under the teacher lock the row must still be the one
 * that list was fetched for, which refuses a choice that raced a disconnect
 * and reconnect.
 */
export async function chooseProfile(
  db: PrismaClient,
  deps: MollieDeps,
  input: { teacherId: string; profileId: string },
): Promise<ChooseProfileOutcome> {
  const row = await db.processorConnection.findUnique({ where: { teacherId: input.teacherId }, select: { id: true, disconnectedAt: true } });
  if (row === null || row.disconnectedAt !== null) return { kind: 'not_connected' };
  const token = await getAccessToken(db, deps, row.id);
  if (token.kind === 'disconnected') return { kind: 'not_connected' };
  if (token.kind === 'unavailable') return { kind: 'unavailable' };
  let profiles: MollieProfile[];
  try {
    profiles = usableProfiles(await deps.client.profiles(token.accessToken), deps.config.testmode);
  } catch (err) {
    if (err instanceof MollieUnavailable) return { kind: 'unavailable' };
    throw err;
  }
  if (!profiles.some((p) => p.id === input.profileId)) return { kind: 'unknown_profile' };

  const outcome = await db.$transaction(async (tx): Promise<ChooseProfileOutcome> => {
    if (!(await lockTeacherForNoKeyUpdate(tx, input.teacherId))) return { kind: 'not_connected' };
    const current = await tx.processorConnection.findUnique({
      where: { teacherId: input.teacherId },
      select: { id: true, organizationId: true, profileId: true, disconnectedAt: true },
    });
    if (current === null || current.disconnectedAt !== null || current.id !== row.id) return { kind: 'not_connected' };
    if (current.profileId === input.profileId) return { kind: 'unchanged' };
    await tx.processorConnection.update({ where: { id: current.id }, data: { profileId: input.profileId } });
    const next: LiveIdentity = { organizationId: current.organizationId, profileId: input.profileId };
    return { kind: 'chosen', eventId: await writeIdentityEvent(tx, input.teacherId, livePayoutIdentity(current), next, profiles) };
  });
  if (outcome.kind === 'chosen') forgetOfferedMethods(row.id);
  return outcome;
}

export type DisconnectOutcome =
  | { kind: 'disconnected'; eventId: string; connectionId: string; revokeNow: boolean }
  | { kind: 'unchanged' }
  | { kind: 'teacher_gone' };

/**
 * Stamps `disconnectedAt`, so the connection stops being live
 * (`livePayoutIdentity`), and records it. The grant is not revoked here: an
 * attempt that may still hear from its webhook needs a token, so `revokeAfter`
 * is the latest expiry among those, or now when there are none, and
 * `revokeNow` says the caller may revoke straight after commit.
 */
export async function disconnect(db: PrismaClient, input: { teacherId: string; now?: Date }): Promise<DisconnectOutcome> {
  const now = input.now ?? new Date();
  return db.$transaction(async (tx): Promise<DisconnectOutcome> => {
    if (!(await lockTeacherForNoKeyUpdate(tx, input.teacherId))) return { kind: 'teacher_gone' };
    const row = await tx.processorConnection.findUnique({
      where: { teacherId: input.teacherId },
      select: { id: true, organizationId: true, disconnectedAt: true },
    });
    if (row === null || row.disconnectedAt !== null) return { kind: 'unchanged' };
    const unfinished = await tx.processorPayment.aggregate({
      where: { connectionId: row.id, status: { in: [...UNFINISHED_ATTEMPT_STATUSES] }, expiresAt: { gt: now } },
      _max: { expiresAt: true },
    });
    const revokeAfter = unfinished._max.expiresAt ?? now;
    await tx.processorConnection.update({ where: { id: row.id }, data: { disconnectedAt: now, revokeAfter } });
    const event = await tx.payoutChangeEvent.create({
      data: { teacherId: input.teacherId, kind: 'processor_disconnected', before: maskOrganizationId(row.organizationId), after: null },
      select: { id: true },
    });
    return { kind: 'disconnected', eventId: event.id, connectionId: row.id, revokeNow: revokeAfter <= now };
  });
}

export type RevokeOutcome = 'revoked' | 'skipped' | 'unavailable';

/**
 * Revokes a disconnected connection's grant at Mollie once `revokeAfter` has
 * passed, then nulls its tokens and stamps `revokedAt`. The write lands only
 * while the row still holds the refresh token that was revoked and is still
 * disconnected, so a reconnect that rewrote the row while Mollie was being
 * called keeps its new grant (`skipped`). No transaction is open across the
 * call. A failure leaves the row as it was (`unavailable`), still due for a
 * later revoke.
 */
export async function revokeDueConnection(
  db: PrismaClient,
  deps: MollieDeps,
  connectionId: string,
  now: Date = new Date(),
): Promise<RevokeOutcome> {
  const row = await db.processorConnection.findFirst({
    where: { id: connectionId, revokedAt: null, disconnectedAt: { not: null }, revokeAfter: { lte: now } },
    select: { refreshToken: true },
  });
  if (row === null || row.refreshToken === null) return 'skipped';
  const sealedRefresh = row.refreshToken;
  let refresh: string;
  try {
    refresh = openToken(sealedRefresh, deps.config.tokenKey);
  } catch (err) {
    if (!(err instanceof TokenCipherError)) throw err;
    logDegraded('PROCESSOR_TOKEN_UNREADABLE', { connectionId }, 'stored processor token could not be opened for revocation', err);
    return 'unavailable';
  }
  try {
    await deps.client.revoke(refresh);
  } catch (err) {
    if (!(err instanceof MollieUnavailable)) throw err;
    logDegraded(
      'MOLLIE_UNAVAILABLE',
      { connectionId, operation: 'revoke', ...(err.status === null ? {} : { status: err.status }) },
      'Mollie could not revoke a disconnected grant; the row stays due for a later revoke',
      err,
    );
    return 'unavailable';
  }
  const { count } = await db.processorConnection.updateMany({
    where: { id: connectionId, revokedAt: null, disconnectedAt: { not: null }, refreshToken: sealedRefresh },
    data: { accessToken: null, refreshToken: null, accessTokenExpiresAt: null, revokedAt: now },
  });
  return count === 1 ? 'revoked' : 'skipped';
}

/** `revokeDueConnection`, started and not awaited: the disconnect's response does not wait on Mollie. */
export function revokeConnection(db: PrismaClient, deps: MollieDeps, connectionId: string): FireAndForget {
  void (async () => {
    await revokeDueConnection(db, deps, connectionId);
  })().catch((err: unknown) => {
    log.error({ err, connectionId }, 'processor revoke failed');
  });
}

export type ConnectionView =
  | { kind: 'none' }
  | { kind: 'choose_profile'; profiles: { id: string; name: string }[] }
  | {
      kind: 'connected';
      organizationName: string;
      profileId: string;
      profileName: string;
      testmode: boolean;
      profiles: { id: string; name: string }[];
      offered: AllowedMollieMethod[];
      excluded: string[];
      missingScopes: string[];
    }
  | { kind: 'unavailable' };

/**
 * What the settings section shows. A row that is disconnected, or absent, is
 * `none`. A connection whose grant lacks a requested scope lists no methods:
 * it takes no payments until the teacher reconnects.
 */
export async function readConnectionView(db: PrismaClient, deps: MollieDeps, teacherId: string): Promise<ConnectionView> {
  const row = await db.processorConnection.findUnique({
    where: { teacherId },
    select: {
      id: true,
      profileId: true,
      disconnectedAt: true,
      scopes: true,
      testmode: true,
      teacher: { select: { currency: true } },
    },
  });
  if (row === null || row.disconnectedAt !== null) return { kind: 'none' };
  const token = await getAccessToken(db, deps, row.id);
  if (token.kind === 'disconnected') return { kind: 'none' };
  if (token.kind === 'unavailable') return { kind: 'unavailable' };

  let org: { id: string; name: string };
  let profiles: { id: string; name: string }[];
  try {
    const [o, p] = await Promise.all([deps.client.organization(token.accessToken), deps.client.profiles(token.accessToken)]);
    org = o;
    profiles = usableProfiles(p, deps.config.testmode).map(({ id, name }) => ({ id, name }));
  } catch (err) {
    if (err instanceof MollieUnavailable) return { kind: 'unavailable' };
    throw err;
  }
  if (row.profileId === null) return { kind: 'choose_profile', profiles };

  const profileId = row.profileId;
  const missingScopes = missingMollieScopes(row.scopes);
  const base = {
    kind: 'connected' as const,
    organizationName: org.name,
    profileId,
    profileName: profiles.find((p) => p.id === profileId)?.name ?? maskProfileId(profileId),
    testmode: row.testmode,
    profiles,
    missingScopes,
  };
  if (missingScopes.length > 0) return { ...base, offered: [], excluded: [] };
  const methods = await listOfferedMethods(db, deps, { id: row.id, profileId, testmode: row.testmode }, VIEW_AMOUNT, row.teacher.currency);
  if (methods.kind === 'unavailable') return { kind: 'unavailable' };
  return { ...base, offered: methods.offered, excluded: methods.excluded };
}
