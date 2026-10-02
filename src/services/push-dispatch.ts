import type { PrismaClient, RecipientType } from '@prisma/client';
import { log } from '@/lib/log';
import { createConcurrencyLimit } from '@/lib/concurrency-limit';
import { readVapidConfig } from '@/lib/push/config';
import { sendPush, type PushSendResult, type PushTarget } from '@/lib/push/send';
import { buildPushPayload, pushUrgency, shouldPush, type PushPayload, type PushRecipient } from '@/lib/push-policy';

/** A push older than this would describe a moment that has passed (a seat already claimed). */
export const PUSH_STALE_AFTER_MS = 15 * 60 * 1000;
export const PUSH_BATCH = 50;
const SEND_CONCURRENCY = 4;

export type PushSender = (
  target: PushTarget,
  payload: PushPayload,
  urgency: 'high' | 'normal',
) => Promise<PushSendResult>;

export interface PushDispatchResult {
  retired: number;
  claimed: number;
  sent: number;
  gone: number;
  invalid: number;
  failed: number;
}

let warnedUnconfigured = false;

function defaultSender(): PushSender | null {
  const keys = readVapidConfig();
  if (!keys) return null;
  return (target, payload, urgency) => sendPush(target, payload, keys, { urgency });
}

/**
 * The push layer's sweep. Reads only committed rows — a notification written
 * inside a transaction that rolls back is never seen — and claims each with a
 * compare-and-swap on `pushHandledAt`, so overlapping ticks send once. Never
 * writes `isRead` or `emailSent` (docs/technical-architecture.md, Notification
 * Dispatcher).
 */
export async function dispatchPushes(
  db: PrismaClient,
  send: PushSender | null | undefined = undefined,
  now: Date = new Date(),
): Promise<PushDispatchResult> {
  const usingDefaultSender = send === undefined;
  const sender = usingDefaultSender ? defaultSender() : send;
  if (usingDefaultSender && !sender && !warnedUnconfigured) {
    warnedUnconfigured = true;
    log.warn('push is not configured (VAPID_* unset or malformed); notifications are retired without sending');
  }
  const cutoff = new Date(now.getTime() - PUSH_STALE_AFTER_MS);
  const result: PushDispatchResult = { retired: 0, claimed: 0, sent: 0, gone: 0, invalid: 0, failed: 0 };

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

  const limit = createConcurrencyLimit(SEND_CONCURRENCY);
  // Every subscription's send, across every notification in this batch,
  // through the one shared `limit` — collected here and awaited once in
  // the `finally` below, rather than per notification, so a tick's sends
  // share concurrency instead of running one notification at a time.
  //
  // Each task is wrapped with `.then(() => undefined, (err) => …)` at the
  // moment it is pushed, before the loop does anything else — a plain
  // rejected promise gets its first handler only when something later
  // awaits it, and the claim loop below keeps awaiting the DB (the next
  // notification's claim, `resolveRecipient`, `pushSubscription.findMany`)
  // in the meantime, so an early task rejecting there would have no
  // handler attached yet: a process-level `unhandledRejection`. Wrapping
  // immediately means a task's outcome is always carried as its RESOLVED
  // value instead — `undefined` on success, a `TaskFailure` naming the
  // notification and subscription on failure — so the wrapped promise
  // itself never rejects at all.
  const tasks: Array<Promise<TaskFailure | undefined>> = [];
  let taskResults: Array<TaskFailure | undefined> = [];
  let loopCompleted = false;

  try {
    for (const n of candidates) {
      const claim = await db.notification.updateMany({
        where: { id: n.id, pushHandledAt: null },
        data: { pushHandledAt: now },
      });
      if (claim.count !== 1) continue;
      result.claimed += 1;
      if (!sender) continue;

      const resolved = await resolveRecipient(db, n.recipientType, n.recipientId);
      if (!resolved || !shouldPush(resolved.recipient, n.type)) continue;

      const subscriptions = await db.pushSubscription.findMany({ where: { accountId: resolved.accountId } });
      const payload = buildPushPayload(n);
      const urgency = pushUrgency(n.recipientType, n.type);
      for (const sub of subscriptions) {
        tasks.push(
          limit(async () => {
            // A throw here is a fault, not a verdict on the subscription:
            // it rejects this task and the tick, and the row stays.
            const { outcome, status, cause, reason } = await sender(sub, payload, urgency);
            switch (outcome) {
              case 'delivered':
                result.sent += 1;
                await db.pushSubscription.updateMany({ where: { id: sub.id }, data: { lastUsedAt: now } });
                return;
              case 'gone':
                result.gone += 1;
                await db.pushSubscription.deleteMany({ where: { id: sub.id } });
                return;
              case 'invalid':
                result.invalid += 1;
                await db.pushSubscription.deleteMany({ where: { id: sub.id } });
                return;
              case 'failed':
                result.failed += 1;
                log.warn({ notificationId: n.id, subscriptionId: sub.id, status, cause, reason }, 'push send failed; not retried');
                return;
              default: {
                const _exhaustive: never = outcome;
                throw new Error(`unhandled push outcome ${String(_exhaustive)}`);
              }
            }
          }).then(
            () => undefined,
            (err: unknown): TaskFailure => ({ err, notificationId: n.id, subscriptionId: sub.id }),
          ),
        );
      }
    }
    loopCompleted = true;
  } finally {
    // Awaited whether the loop above threw or returned — a send must never
    // outlive this tick on either path. If the loop threw, its error is the
    // one that propagates once this `finally` completes, so every task
    // failure is logged here instead; execution never reaches the lines below.
    taskResults = await Promise.all(tasks);
    if (!loopCompleted) logTaskFailures(taskResults.filter(isTaskFailure));
  }

  const [firstFailure, ...otherFailures] = taskResults.filter(isTaskFailure);
  if (firstFailure) {
    logTaskFailures(otherFailures);
    throw firstFailure.err;
  }

  if (result.failed + result.gone + result.invalid + result.retired > 0) {
    log.info({ ...result }, 'push dispatch tick');
  }
  return result;
}

interface TaskFailure {
  err: unknown;
  notificationId: string;
  subscriptionId: string;
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
