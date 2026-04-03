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

class NotificationBus extends EventEmitter {
  emitNotification(event: NotificationEvent): void {
    this.emit('notification', event);
  }

  onNotification(handler: (event: NotificationEvent) => void): void {
    this.on('notification', handler);
  }

  offNotification(handler: (event: NotificationEvent) => void): void {
    this.off('notification', handler);
  }
}

export const notificationBus = new NotificationBus();
notificationBus.setMaxListeners(100); // Support up to 100 concurrent SSE connections
