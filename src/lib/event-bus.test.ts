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
