import { NextRequest } from 'next/server';
import { validateSession, getSessionToken } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { notificationBus, type NotificationEvent } from '@/lib/event-bus';

export const dynamic = 'force-dynamic';

/** Open SSE streams per user — a runaway tab loop must not hold the server. */
const MAX_STREAMS_PER_USER = 5;

declare global {
  // Global so every bundle context shares the same counters (mirrors the
  // scheduler-health registry pattern).
  var __fairYogaSseCounts: Map<string, number> | undefined;
}
const sseCounts = (globalThis.__fairYogaSseCounts ??= new Map<string, number>());

export async function GET(request: NextRequest) {
  const token = getSessionToken(request);
  if (!token) {
    return new Response('Unauthorized', { status: 401 });
  }
  const session = await validateSession(prisma, token);
  if (!session) {
    return new Response('Session expired', { status: 401 });
  }

  const userKey = `${session.userType}:${session.userId}`;
  if ((sseCounts.get(userKey) ?? 0) >= MAX_STREAMS_PER_USER) {
    // The client's backoff reconnect retries once other tabs close.
    return new Response('Too many open streams', { status: 429 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;

      // enqueue can race the client closing the connection (a keepalive tick
      // or bus event landing after close, before the abort listener runs) —
      // never let that take down the process.
      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          cleanup();
        }
      };

      const handler = (event: NotificationEvent) => {
        if (
          event.recipientId === session.userId &&
          event.recipientType === session.userType
        ) {
          send(`data: ${JSON.stringify(event.notification)}\n\n`);
        }
      };

      // Send periodic keepalive to prevent proxy timeouts
      const keepalive = setInterval(() => send(': keepalive\n\n'), 30000);

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(keepalive);
        notificationBus.offNotification(handler);
        const count = (sseCounts.get(userKey) ?? 1) - 1;
        if (count <= 0) sseCounts.delete(userKey);
        else sseCounts.set(userKey, count);
        try {
          controller.close();
        } catch {
          // already closed by the runtime
        }
      };

      // Send initial keepalive comment
      sseCounts.set(userKey, (sseCounts.get(userKey) ?? 0) + 1);
      send(': connected\n\n');
      notificationBus.onNotification(handler);

      // Cleanup on client disconnect
      request.signal.addEventListener('abort', cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
