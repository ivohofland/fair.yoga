import { describe, it, expect } from 'vitest';
import { NotificationType } from '@prisma/client';
import {
  NOTIFICATION_RETENTION_DAYS,
  SHORT_RETENTION_DAYS,
  STANDARD_RETENTION_DAYS,
} from './notification-retention';

describe('NOTIFICATION_RETENTION_DAYS', () => {
  it('gives every NotificationType one of the two periods', () => {
    for (const type of Object.values(NotificationType)) {
      expect([SHORT_RETENTION_DAYS, STANDARD_RETENTION_DAYS]).toContain(
        NOTIFICATION_RETENTION_DAYS[type],
      );
    }
  });

  it('keeps spot_available briefly: it is useless once its claim window closes', () => {
    expect(NOTIFICATION_RETENTION_DAYS.spot_available).toBe(SHORT_RETENTION_DAYS);
  });

  it('keeps waitlist_promoted for the full period', () => {
    expect(NOTIFICATION_RETENTION_DAYS.waitlist_promoted).toBe(STANDARD_RETENTION_DAYS);
  });

  it('keeps reminder and payment_request for the full period', () => {
    expect(NOTIFICATION_RETENTION_DAYS.reminder).toBe(STANDARD_RETENTION_DAYS);
    expect(NOTIFICATION_RETENTION_DAYS.payment_request).toBe(STANDARD_RETENTION_DAYS);
  });
});
