import { describe, it, expect, vi, afterEach } from 'vitest';
import { elementsOf } from '../../../../../../tests/react-tree';
import { CompleteClassButton } from '@/components/class/complete-class-button';
import { ShareBookingLink } from '@/components/class/share-booking-link';
import { RefreshAt } from '@/components/class/refresh-at';
import { DonationsReceivedCard } from '@/components/class/donations-received-card';
import { PaymentChecklist } from '@/components/class/payment-checklist';

const { requireTeacherSession, findUnique, waitlistCount } = vi.hoisted(() => ({
  requireTeacherSession: vi.fn(),
  findUnique: vi.fn(),
  waitlistCount: vi.fn(async () => 0),
}));

vi.mock('@/lib/session', () => ({ requireTeacherSession }));
vi.mock('@/lib/db', () => ({
  prisma: { class: { findUnique }, waitlistEntry: { count: waitlistCount } },
}));

import ClassDetailPage from './page';

describe('ClassDetailPage', () => {
  it('gives Finish class the session\'s account, so it sends that account\'s queued attendance', async () => {
    requireTeacherSession.mockResolvedValue({
      sessionId: 's1',
      accountId: 'acct-1',
      teacherId: 'teacher-1',
      studentId: null,
      defaultTimezone: 'UTC',
    });
    // In progress since long ago, so Finish class is offered.
    findUnique.mockResolvedValue({
      id: 'c-9',
      status: 'in_progress',
      pricingMode: 'tiered',
      calendarEntry: {
        teacherId: 'teacher-1',
        cancelledAt: null,
        classType: 'Hatha',
        date: new Date('2026-01-05T00:00:00Z'),
        startTime: new Date('1970-01-01T10:00:00Z'),
        durationMinutes: 60,
        teacher: { defaultTimezone: 'UTC', pageSlug: 'teacher' },
      },
      registrations: [],
      _count: { waitlistEntries: 0 },
    });

    const tree = await ClassDetailPage({ params: Promise.resolve({ id: 'c-9' }) });

    const buttons = [...elementsOf(tree)].filter((el) => el.type === CompleteClassButton);
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.props).toMatchObject({ classId: 'c-9', ownerId: 'acct-1' });
  });

  describe('sharing the booking link', () => {
    const session = {
      sessionId: 's1',
      accountId: 'acct-1',
      teacherId: 'teacher-1',
      studentId: null,
      defaultTimezone: 'UTC',
    };
    const classOn = (status: string, date: string) => ({
      id: 'c-7',
      status,
      pricingMode: 'tiered',
      calendarEntry: {
        teacherId: 'teacher-1',
        cancelledAt: null,
        classType: 'Hatha',
        date: new Date(`${date}T00:00:00Z`),
        startTime: new Date('1970-01-01T10:00:00Z'),
        durationMinutes: 60,
        teacher: { defaultTimezone: 'UTC', pageSlug: 'anna' },
      },
      registrations: [],
      _count: { waitlistEntries: 0 },
    });
    const render = async () => {
      const tree = await ClassDetailPage({ params: Promise.resolve({ id: 'c-7' }) });
      const elements = [...elementsOf(tree)];
      return {
        shares: elements.filter((el) => el.type === ShareBookingLink),
        captions: elements.filter((el) => el.props && (el.props as { children?: unknown }).children === 'Publish to share the link'),
      };
    };

    it('offers the class booking link on an open class that has not started', async () => {
      requireTeacherSession.mockResolvedValue(session);
      findUnique.mockResolvedValue(classOn('open', '2099-01-05'));
      const { shares, captions } = await render();
      expect(shares).toHaveLength(1);
      expect(shares[0]?.props).toMatchObject({ path: '/anna/book/c-7', title: 'Book Hatha' });
      expect(captions).toHaveLength(0);
    });

    it('reloads an open class page at its start, when the share button goes', async () => {
      requireTeacherSession.mockResolvedValue(session);
      findUnique.mockResolvedValue(classOn('open', '2099-01-05'));
      const tree = await ClassDetailPage({ params: Promise.resolve({ id: 'c-7' }) });
      const refresh = [...elementsOf(tree)].filter((el) => el.type === RefreshAt);
      expect(refresh).toHaveLength(1);
      expect((refresh[0]?.props as { instants: string[] }).instants).toContain('2099-01-05T10:00:00.000Z');
    });

    it('asks a draft to be published first', async () => {
      requireTeacherSession.mockResolvedValue(session);
      findUnique.mockResolvedValue(classOn('draft', '2099-01-05'));
      const { shares, captions } = await render();
      expect(shares).toHaveLength(0);
      expect(captions).toHaveLength(1);
    });

    it('offers nothing on an open class whose start has passed', async () => {
      requireTeacherSession.mockResolvedValue(session);
      findUnique.mockResolvedValue(classOn('open', '2026-01-05'));
      const { shares, captions } = await render();
      expect(shares).toHaveLength(0);
      expect(captions).toHaveLength(0);
    });
  });

  describe('a donation class (#912)', () => {
    const session = {
      sessionId: 's1',
      accountId: 'acct-1',
      teacherId: 'teacher-1',
      studentId: null,
      defaultTimezone: 'UTC',
    };
    const donationClass = (status: string, registrationStatuses: string[]) => ({
      id: 'c-5',
      status,
      pricingMode: 'donation',
      roomCost: 30,
      vatPercent: 0,
      currency: 'EUR',
      donationTotal: status === 'completed' ? 84.5 : null,
      calendarEntry: {
        teacherId: 'teacher-1',
        cancelledAt: null,
        classType: 'Hatha',
        date: new Date('2026-01-05T00:00:00Z'),
        startTime: new Date('1970-01-01T10:00:00Z'),
        durationMinutes: 60,
        teacher: { defaultTimezone: 'UTC', pageSlug: 'anna' },
      },
      registrations: registrationStatuses.map((status, i) => ({
        id: `r-${i}`, studentId: `s-${i}`, status, tierAtBooking: 3, price: null, payment: null,
        student: { firstName: 'A', lastName: 'B', studentPrivacy: [] },
      })),
      _count: { waitlistEntries: 0 },
    });
    const texts = (tree: unknown) =>
      [...elementsOf(tree as Parameters<typeof elementsOf>[0])]
        .map((el) => (el.props as { children?: unknown } | null)?.children)
        .filter((c): c is string => typeof c === 'string');

    afterEach(() => vi.useRealTimers());

    it('captions the finish with the invitations, and gives the button the count of who came', async () => {
      // Finish is open (from 10:45), the automatic finish is not yet (11:15).
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-01-05T11:00:00Z') });
      requireTeacherSession.mockResolvedValue(session);
      findUnique.mockResolvedValue(donationClass('in_progress', ['attended', 'attended', 'no_show']));
      const tree = await ClassDetailPage({ params: Promise.resolve({ id: 'c-5' }) });
      expect(texts(tree)).toContain('Invitations to give go out at 11:15.');
      const button = [...elementsOf(tree)].find((el) => el.type === CompleteClassButton);
      expect(button?.props).toMatchObject({ pricingMode: 'donation', invitedCount: 2 });
    });

    it('never promises payment requests when no one came', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-01-05T11:00:00Z') });
      requireTeacherSession.mockResolvedValue(session);
      findUnique.mockResolvedValue(donationClass('in_progress', ['no_show']));
      const tree = await ClassDetailPage({ params: Promise.resolve({ id: 'c-5' }) });
      expect(texts(tree)).toContain('This class finishes automatically at 11:15.');
    });

    it('shows the donations received, and no payment checklist, once completed', async () => {
      requireTeacherSession.mockResolvedValue(session);
      findUnique.mockResolvedValue(donationClass('completed', ['attended']));
      const tree = await ClassDetailPage({ params: Promise.resolve({ id: 'c-5' }) });
      const elements = [...elementsOf(tree)];
      expect(elements.find((el) => el.type === DonationsReceivedCard)?.props).toMatchObject({
        classId: 'c-5', donationTotal: 84.5, vatPercent: 0, currency: 'EUR',
      });
      expect(elements.some((el) => el.type === PaymentChecklist)).toBe(false);
    });
  });
});
