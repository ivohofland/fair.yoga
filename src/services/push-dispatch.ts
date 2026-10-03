import type { PrismaClient, PushSubscription, RecipientType } from '@prisma/client';
import { log } from '@/lib/log';
import { diagnoseVapidConfig, type VapidConfigProblem } from '@/lib/push/config';
import { sendPush, type PushSendResult, type PushTarget } from '@/lib/push/send';
import { buildPushPayload, pushUrgency, shouldPush, type PushPayload, type PushRecipient, type PushUrgency } from '@/lib/push-policy';

/** A push older than this would describe a moment that has passed (a seat already claimed). */
export const PUSH_STALE_AFTER_MS = 15 * 60 * 1000;
export const PUSH_BATCH = 50;
/** Notifications in flight at once; each fans out to its recipient's devices in parallel. */
export const PUSH_WORKERS = 4;
/**
 * No notification is claimed once a tick has run this long. A tick therefore
 * ends within one send timeout of it, plus the database calls after its last
 * deadline check, which is what keeps the job under the scheduler's stall line (derivation in `docs/technical-architecture.md`,
 * Cron Jobs; pinned in `scheduler.test.ts`).
 */
export const PUSH_CLAIM_DEADLINE_MS = 10_000;

export type PushSender = (
  target: PushTarget,
  payload: PushPayload,
  urgency: PushUrgency,
) => Promise<PushSendResult>;

/** A `VAPID_*` problem that is a fault, not a choice: everything but an unset environment. */
export type MisconfiguredVapid = Exclude<VapidConfigProblem, 'unset'>;

export interface PushDispatchResult {
  retired: number;
  claimed: number;
  sent: number;
  gone: number;
  invalid: number;
  failed: number;
  /** Rows claimed while push was misconfigured (not merely unset): nobody could be told. */
  unsendable: number;
  /** Why `VAPID_*` is unusable, read on every tick whether or not it claimed a row; null when it is usable, unset, or a sender was injected. */
  misconfigured: MisconfiguredVapid | null;
}

let reportedUnconfigured = false;

interface ResolvedSender {
  sender: PushSender | null;
  /** Set when `VAPID_*` is set but unusable; an unset environment is a choice, not a fault. */
  misconfigured: MisconfiguredVapid | null;
}

function resolveSender(send: PushSender | null | undefined): ResolvedSender {
  if (send !== undefined) return { sender: send, misconfigured: null };
  const diagnosis = diagnoseVapidConfig();
  if (!diagnosis.ok) {
    reportUnconfigured(diagnosis.reason);
    return { sender: null, misconfigured: diagnosis.reason === 'unset' ? null : diagnosis.reason };
  }
  const { keys } = diagnosis;
  return { sender: (target, payload, urgency) => sendPush(target, payload, keys, { urgency }), misconfigured: null };
}

/**
 * Once per process. A deployment with no VAPID variable has chosen not to
 * offer push, so that is a warning; any other problem is a deployment that
 * meant to and cannot. Only the reason is logged, never a key.
 */
function reportUnconfigured(reason: VapidConfigProblem): void {
  if (reportedUnconfigured) return;
  reportedUnconfigured = true;
  if (reason === 'unset') {
    log.warn('push is not configured (VAPID_* unset); notifications are retired without sending');
  } else {
    log.error({ reason }, 'push is misconfigured (VAPID_*); notifications are retired without sending');
  }
}

export interface PushDispatchOptions {
  /** Omitted: the sender `VAPID_*` configures. `null`: no sender, so every claimed row is retired unsent. */
  send?: PushSender | null;
  /** Epoch milliseconds. The tick's one time source: the claim deadline, the staleness cutoff and every timestamp it writes derive from its first read. */
  clock?: () => number;
}

/**
 * The push layer's sweep. Reads only committed rows — a notification written
 * inside a transaction that rolls back is never seen — and claims each with a
 * compare-and-swap on `pushHandledAt` just before sending it, so concurrent
 * runs send once. Never writes `isRead` or `emailSent`
 * (docs/technical-architecture.md, Notification Dispatcher).
 */
export async function dispatchPushes(
  db: PrismaClient,
  { send, clock = Date.now }: PushDispatchOptions = {},
): Promise<Readonly<PushDispatchResult>> {
  const result: PushDispatchResult = { retired: 0, claimed: 0, sent: 0, gone: 0, invalid: 0, failed: 0, unsendable: 0, misconfigured: null };
  try {
    await runPushDispatch(db, send, new Date(clock()), clock, result);
  } catch (err: unknown) {
    // A tick that throws may have retired rows and sent some; its counts are
    // the only tick-level record of that.
    log.info({ ...result, faulted: true }, 'push dispatch tick');
    throw err;
  }
  if (result.failed + result.gone + result.invalid + result.retired + result.unsendable > 0) {
    log.info({ ...result }, 'push dispatch tick');
  }
  return result;
}

/** The tick's work, counting into `result` as it goes so a throw leaves the counts of what already happened. */
async function runPushDispatch(
  db: PrismaClient,
  send: PushSender | null | undefined,
  now: Date,
  clock: () => number,
  result: PushDispatchResult,
): Promise<void> {
  const claimDeadline = now.getTime() + PUSH_CLAIM_DEADLINE_MS;
  const { sender, misconfigured } = resolveSender(send);
  result.misconfigured = misconfigured;
  const cutoff = new Date(now.getTime() - PUSH_STALE_AFTER_MS);

  const retired = await db.notification.updateMany({
    where: { pushHandledAt: null, createdAt: { lte: cutoff } },
    data: { pushHandledAt: now },
  });
  result.retired = retired.count;

  const candidates = await db.notification.findMany({
    where: { pushHandledAt: null, createdAt: { gt: cutoff } },
    orderBy: { createdAt: 'asc' },
    take: PUSH_BATCH,
    select: { id: true, recipientType: true, recipientId: true, type: true, title: true, body: true },
  });

  const failures: TaskFailure[] = [];
  let next = 0;

  // Never rejects: a send's fault is carried as a RESOLVED `TaskFailure`
  // naming its notification and subscription, so nothing here can become a
  // process-level `unhandledRejection` while another worker still awaits. The
  // subscription write after a verdict is inside the same `try`, so a database
  // error there is reported as that send's fault.
  async function sendTo(
    notificationId: string,
    sub: PushSubscription,
    deliver: PushSender,
    payload: PushPayload,
    urgency: PushUrgency,
  ): Promise<TaskFailure | undefined> {
    try {
      // A throw here is a fault, not a verdict on the subscription: it
      // fails this tick and the row stays.
      const { outcome, status, cause, reason } = await deliver(sub, payload, urgency);
      switch (outcome) {
        case 'delivered':
          result.sent += 1;
          await db.pushSubscription.updateMany({ where: { id: sub.id }, data: { lastUsedAt: now } });
          return undefined;
        case 'gone':
          result.gone += 1;
          await db.pushSubscription.deleteMany({ where: { id: sub.id } });
          return undefined;
        case 'invalid':
          result.invalid += 1;
          await db.pushSubscription.deleteMany({ where: { id: sub.id } });
          return undefined;
        case 'failed':
          result.failed += 1;
          log.warn({ notificationId, subscriptionId: sub.id, status, cause, reason }, 'push send failed; not retried');
          return undefined;
        default: {
          const _exhaustive: never = outcome;
          throw new Error(`unhandled push outcome ${String(_exhaustive)}`);
        }
      }
    } catch (err: unknown) {
      return { err, notificationId, subscriptionId: sub.id };
    }
  }

  // A worker claims a notification only when it is about to send it, so a
  // row nobody reached before the deadline is still unclaimed and the next
  // tick takes it. A claimed row is never given back; it stays stamped whether
  // its sends run or a read after the claim throws and rejects the tick.
  async function worker(): Promise<void> {
    for (;;) {
      if (clock() >= claimDeadline) return;
      const n = candidates[next];
      next += 1;
      if (n === undefined) return;
      const claim = await db.notification.updateMany({
        where: { id: n.id, pushHandledAt: null },
        data: { pushHandledAt: now },
      });
      if (claim.count !== 1) continue;
      result.claimed += 1;
      if (!sender) {
        if (misconfigured !== null) result.unsendable += 1;
        continue;
      }

      const resolved = await resolveRecipient(db, n.recipientType, n.recipientId);
      if (!resolved || !shouldPush(resolved.recipient, n.type)) continue;

      const subscriptions = await db.pushSubscription.findMany({ where: { accountId: resolved.accountId } });
      const payload = buildPushPayload(n);
      const urgency = pushUrgency(n.recipientType, n.type);
      const outcomes = await Promise.all(subscriptions.map((sub) => sendTo(n.id, sub, sender, payload, urgency)));
      failures.push(...outcomes.filter(isTaskFailure));
    }
  }

  // Every worker is awaited whether another threw or not — a send must never
  // outlive its tick on either path. After one worker's own failure the others
  // keep claiming until the deadline or the end of the batch.
  const settled = await Promise.allSettled(Array.from({ length: PUSH_WORKERS }, () => worker()));
  const crashed = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
  const [firstCrash, ...otherCrashes] = crashed;
  if (firstCrash) {
    // A worker's own failure (a claim or a read) is the error that
    // propagates; every send fault is still logged.
    logTaskFailures(failures);
    for (const other of otherCrashes) log.error({ err: other.reason as unknown }, 'push dispatch worker failed');
    const reason: unknown = firstCrash.reason;
    throw reason;
  }

  const [firstFailure, ...otherFailures] = failures;
  if (firstFailure) {
    logTaskFailures(otherFailures);
    throw new PushSendFault(firstFailure.notificationId, firstFailure.subscriptionId, firstFailure.err);
  }
}

interface TaskFailure {
  err: unknown;
  notificationId: string;
  subscriptionId: string;
}

/** What a rejected send task is rethrown as, so the ids it names reach the caller, not just the log. */
export class PushSendFault extends Error {
  constructor(
    public readonly notificationId: string,
    public readonly subscriptionId: string,
    cause: unknown,
  ) {
    super(`push send failed for notification ${notificationId}, subscription ${subscriptionId}`, { cause });
    this.name = 'PushSendFault';
  }
}

function isTaskFailure(value: TaskFailure | undefined): value is TaskFailure {
  return value !== undefined;
}

function logTaskFailures(failures: readonly TaskFailure[]): void {
  for (const { err, notificationId, subscriptionId } of failures) {
    log.error({ err, notificationId, subscriptionId }, 'push send task failed');
  }
}

async function resolveRecipient(
  db: PrismaClient,
  recipientType: RecipientType,
  recipientId: string,
): Promise<{ accountId: string; recipient: PushRecipient } | null> {
  if (recipientType === 'student') {
    const s = await db.student.findFirst({
      where: { id: recipientId, deletedAt: null },
      select: {
        accountId: true, pushWaitlist: true, pushClassChanges: true, pushPayments: true,
        pushClassReminders: true, pushAnnouncements: true, pushInvitations: true,
      },
    });
    if (!s?.accountId) return null;
    const { accountId, ...prefs } = s;
    return { accountId, recipient: { audience: 'student', prefs } };
  }
  const t = await db.teacher.findFirst({
    where: { id: recipientId, deletedAt: null },
    select: {
      accountId: true, pushAutoCancelled: true, pushBookings: true, pushClassCompleted: true,
      pushClassReminders: true, pushInvitations: true,
    },
  });
  if (!t) return null;
  const { accountId, ...prefs } = t;
  return { accountId, recipient: { audience: 'teacher', prefs } };
}
