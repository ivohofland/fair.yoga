import { EventEmitter } from 'events';

export interface NotificationEvent {
  recipientId: string;
  recipientType: 'teacher' | 'student';
  notification: {
    id: string;
    type: string;
    title: string;
    body: string;
    relatedClassId?: string;
    createdAt: string;
  };
}

declare global {
  // The scheduler (instrumentation entry) and the SSE route are separate
  // bundle entries; one emitter is what lets a scheduler notification reach a stream.
  var __fairYogaNotificationBus: EventEmitter | undefined;
}

const emitter = (globalThis.__fairYogaNotificationBus ??= (() => {
  const created = new EventEmitter();
  created.setMaxListeners(100); // Support up to 100 concurrent SSE connections
  return created;
})());

export const notificationBus = {
  emitNotification(event: NotificationEvent): void {
    emitter.emit('notification', event);
  },

  onNotification(handler: (event: NotificationEvent) => void): void {
    emitter.on('notification', handler);
  },

  offNotification(handler: (event: NotificationEvent) => void): void {
    emitter.off('notification', handler);
  },

  listenerCount(): number {
    return emitter.listenerCount('notification');
  },
};
