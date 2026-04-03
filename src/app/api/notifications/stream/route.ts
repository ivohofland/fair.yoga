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
      // Send initial keepalive comment
      controller.enqueue(encoder.encode(': connected\n\n'));

      const handler = (event: NotificationEvent) => {
        if (
          event.recipientId === session.userId &&
          event.recipientType === session.userType
        ) {
          const data = JSON.stringify(event.notification);
          controller.enqueue(encoder.encode(`data: ${data}\n\n`));
        }
      };

      notificationBus.onNotification(handler);

      // Send periodic keepalive to prevent proxy timeouts
      const keepalive = setInterval(() => {
        controller.enqueue(encoder.encode(': keepalive\n\n'));
      }, 30000);

      // Cleanup on client disconnect
      request.signal.addEventListener('abort', () => {
        clearInterval(keepalive);
        notificationBus.offNotification(handler);
        controller.close();
      });
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
