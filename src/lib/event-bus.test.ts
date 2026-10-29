import { describe, it, expect, vi } from 'vitest';
import { notificationBus, type NotificationEvent } from './event-bus';

function makeEvent(
  overrides: Partial<NotificationEvent> = {}
): NotificationEvent {
  return {
    recipientId: 'user-1',
    recipientType: 'teacher',
    notification: {
      id: 'notif-1',
      type: 'booking_confirmed',
      title: 'New booking',
      body: 'A student booked your class',
      createdAt: new Date().toISOString(),
    },
    ...overrides,
  };
}

describe('NotificationBus', () => {
  it('emitNotification triggers handlers registered with onNotification', () => {
    const handler = vi.fn();
    notificationBus.onNotification(handler);

    const event = makeEvent();
    notificationBus.emitNotification(event);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(event);

    notificationBus.offNotification(handler);
  });

  it('offNotification removes the handler so it no longer receives events', () => {
    const handler = vi.fn();
    notificationBus.onNotification(handler);
    notificationBus.offNotification(handler);

    notificationBus.emitNotification(makeEvent());

    expect(handler).not.toHaveBeenCalled();
  });

  it('delivers all events to the bus regardless of recipientId (filtering is external)', () => {
    const handler = vi.fn();
    notificationBus.onNotification(handler);

    const event1 = makeEvent({ recipientId: 'user-1' });
    const event2 = makeEvent({ recipientId: 'user-2' });
    const event3 = makeEvent({
      recipientId: 'user-3',
      recipientType: 'student',
    });

    notificationBus.emitNotification(event1);
    notificationBus.emitNotification(event2);
    notificationBus.emitNotification(event3);

    expect(handler).toHaveBeenCalledTimes(3);
    expect(handler).toHaveBeenNthCalledWith(1, event1);
    expect(handler).toHaveBeenNthCalledWith(2, event2);
    expect(handler).toHaveBeenNthCalledWith(3, event3);

    notificationBus.offNotification(handler);
  });

  it('supports multiple concurrent handlers', () => {
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    notificationBus.onNotification(handler1);
    notificationBus.onNotification(handler2);

    const event = makeEvent();
    notificationBus.emitNotification(event);

    expect(handler1).toHaveBeenCalledOnce();
    expect(handler2).toHaveBeenCalledOnce();

    notificationBus.offNotification(handler1);
    notificationBus.offNotification(handler2);
  });
});

describe('NotificationBus across module copies', () => {
  it('a listener on one module copy hears an emit from a fresh copy', async () => {
    const first = await import('./event-bus');
    const handler = vi.fn();
    first.notificationBus.onNotification(handler);
    try {
      vi.resetModules();
      const second = await import('./event-bus');
      expect(second.notificationBus).not.toBe(first.notificationBus);

      const event = makeEvent();
      second.notificationBus.emitNotification(event);

      expect(handler).toHaveBeenCalledWith(event);
    } finally {
      first.notificationBus.offNotification(handler);
    }
  });

  it('the listener cap is applied once and survives re-evaluation', async () => {
    const first = await import('./event-bus');
    const handler = vi.fn();
    first.notificationBus.onNotification(handler);
    try {
      const before = first.notificationBus.listenerCount();
      vi.resetModules();
      const second = await import('./event-bus');

      expect(globalThis.__fairYogaNotificationBus?.getMaxListeners()).toBe(100);
      expect(second.notificationBus.listenerCount()).toBe(before);
    } finally {
      first.notificationBus.offNotification(handler);
    }
  });
});
