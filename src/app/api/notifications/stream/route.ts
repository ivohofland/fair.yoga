import { NextRequest } from 'next/server';
import { validateSession, getSessionToken } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { notificationBus, type NotificationEvent } from '@/lib/event-bus';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const token = getSessionToken(request);
  if (!token) {
    return new Response('Unauthorized', { status: 401 });
  }
  const session = await validateSession(prisma, token);
  if (!session) {
    return new Response('Session expired', { status: 401 });
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
        try {
          controller.close();
        } catch {
          // already closed by the runtime
        }
      };

      // Send initial keepalive comment
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
