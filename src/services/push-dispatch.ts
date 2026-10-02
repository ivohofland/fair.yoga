import type { PrismaClient, RecipientType } from '@prisma/client';
import { log } from '@/lib/log';
import { createConcurrencyLimit } from '@/lib/concurrency-limit';
import { readVapidConfig } from '@/lib/push/config';
import { sendPush, type PushOutcome, type PushTarget } from '@/lib/push/send';
import { buildPushPayload, pushUrgency, shouldPush, type PushPayload, type PushRecipient } from '@/lib/push-policy';

/** A push older than this would describe a moment that has passed (a seat already claimed). */
export const PUSH_STALE_AFTER_MS = 15 * 60 * 1000;
export const PUSH_BATCH = 50;
const SEND_CONCURRENCY = 4;

export type PushSender = (
  target: PushTarget,
  payload: PushPayload,
  urgency: 'high' | 'normal',
) => Promise<{ outcome: PushOutcome; status: number | null }>;

export interface PushDispatchResult {
  retired: number;
  claimed: number;
  sent: number;
  gone: number;
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
  const result: PushDispatchResult = { retired: 0, claimed: 0, sent: 0, gone: 0, failed: 0 };

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
  // through the one shared `limit` — collected here and awaited once after
  // the loop, rather than per notification, so a tick's sends share
  // concurrency instead of running one notification at a time.
  const tasks: Array<Promise<void>> = [];

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
      tasks.push(limit(async () => {
        let outcome: PushOutcome;
        let status: number | null;
        try {
          ({ outcome, status } = await sender(sub, payload, urgency));
        } catch (err) {
          // A stored key the sender cannot even encrypt against (a
          // malformed `p256dh`, for instance) never will — the same
          // standing as `gone`. Caught here, scoped to this subscription,
          // so one bad row cannot abort the rest of the tick's sends.
          result.failed += 1;
          log.warn({ notificationId: n.id, subscriptionId: sub.id, err }, 'push send threw; subscription removed');
          await db.pushSubscription.deleteMany({ where: { id: sub.id } });
          return;
        }
        if (outcome === 'delivered') {
          result.sent += 1;
          await db.pushSubscription.updateMany({ where: { id: sub.id }, data: { lastUsedAt: now } });
        } else if (outcome === 'gone') {
          result.gone += 1;
          await db.pushSubscription.deleteMany({ where: { id: sub.id } });
        } else {
          result.failed += 1;
          log.warn({ notificationId: n.id, subscriptionId: sub.id, status }, 'push send failed; not retried');
        }
      }));
    }
  }

  const settled = await Promise.allSettled(tasks);
  const firstRejected = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
  if (firstRejected) throw firstRejected.reason;

  return result;
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
