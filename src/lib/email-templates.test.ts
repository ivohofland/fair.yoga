import { describe, it, expect, vi, afterEach } from 'vitest';
import { log } from '@/lib/log';
import {
  CLASS_REMINDER_EMAIL_FOOTER,
  escapeHtml,
  renderNotificationEmail,
  renderMagicLinkEmail,
  renderInvitationEmail,
  renderPasskeyAddedEmail,
  renderDegradationDigestEmail,
} from './email-templates';
import { STUDENT_INVITATION_PATH, STUDENT_BOOKINGS_PATH, TEACHER_INVITATION_PATH } from './notification-links';

describe('email templates', () => {
  it('uses the reminder footer, not the unread-fallback one, when given (#721)', () => {
    const { html } = renderNotificationEmail(
      { type: 'class_reminder', title: 'Class reminder', body: 'Flow on Wed 10 Jun at 18:00.', recipientType: 'student' },
      'https://fair.yoga',
      CLASS_REMINDER_EMAIL_FOOTER,
    );
    expect(html).toContain(CLASS_REMINDER_EMAIL_FOOTER);
    expect(html).not.toContain('when an in-app message goes unread');
  });

  it('keeps the unread-fallback footer by default', () => {
    const { html } = renderNotificationEmail({ type: 'announcement', title: 't', body: 'b' }, 'https://fair.yoga');
    expect(html).toContain('when an in-app message goes unread');
  });

  it('escapes HTML in notification titles and bodies', () => {
    const { html } = renderNotificationEmail({
      type: 'announcement',
      title: 'Hello <b>there</b>',
      body: `<script>alert('x')</script> & more`,
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('Hello &lt;b&gt;there&lt;/b&gt;');
    expect(html).toContain('&amp; more');
  });

  it('frames each notification type with its intro', () => {
    const { html, subject } = renderNotificationEmail({
      type: 'payment_request',
      title: 'Payment requested',
      body: 'Your price for Vinyasa is €12.50.',
      relatedClassId: 'class-1',
    });
    expect(subject).toBe('Payment requested');
    expect(html).toContain('here is your share');
    expect(html).toContain('€12.50');
  });

  // #434's two new types read almost identically ("Your booking was
  // cancelled." vs "Your teacher cancelled your booking.") and both key the
  // same `Record<NotificationType, string>` — a copy-paste swap of the two
  // values would still type-check and pass every other test here, so each
  // assertion also checks the OTHER type's intro is absent.
  it("frames a self-cancellation as the student's own action, not an alert", () => {
    const { html } = renderNotificationEmail({
      type: 'booking_cancelled',
      title: 'Booking cancelled',
      body: 'Your booking for Vinyasa on Mon 12 at 09:00 is cancelled.',
    });
    expect(html).toContain('Your booking was cancelled.');
    expect(html).not.toContain('Your teacher cancelled your booking.');
  });

  it("frames a teacher-removed booking as their action, not the student's own", () => {
    const { html } = renderNotificationEmail({
      type: 'booking_removed',
      title: 'Booking cancelled by your teacher',
      body: 'Your teacher cancelled your booking for Vinyasa on Mon 12 at 09:00.',
    });
    expect(html).toContain('Your teacher cancelled your booking.');
    expect(html).not.toContain('Your booking was cancelled.');
  });

  it('frames the same type for the teacher audience', () => {
    const teacher = renderNotificationEmail({
      type: 'booking_confirmed',
      title: 'New booking',
      body: 'Anna booked Vinyasa.',
      recipientType: 'teacher',
    });
    // Not "Your booking is confirmed" — the teacher didn't book anything.
    expect(teacher.html).toContain('A student booked your class.');

    const student = renderNotificationEmail({
      type: 'booking_confirmed',
      title: 'Booking confirmed',
      body: "You're booked for Vinyasa.",
      recipientType: 'student',
    });
    expect(student.html).toContain('Your booking is confirmed.');
  });

  it('wraps everything in the branded shell', () => {
    const { html } = renderNotificationEmail({
      type: 'reminder',
      title: 'Reminder',
      body: 'Class tomorrow.',
      relatedClassId: 'class-1',
    });
    expect(html).toContain('fair');
    expect(html).toContain('#1A5653'); // teal
    expect(html).toContain('#F7F4EF'); // cream
    expect(html).toContain('turn them off in your settings');
  });

  // #166 whole-branch review I5. The fallback email is what an invitee gets
  // when the in-app notification goes unread — which for someone who has
  // never heard of fair.yoga is the likely case. It carried no link at all,
  // so it told them a teacher wanted to connect and gave them nothing to do
  // about it.
  it('a student invitation fallback carries a link to the page that answers it', () => {
    const { html } = renderNotificationEmail(
      {
        type: 'teacher_invitation',
        title: 'A teacher would like to connect',
        body: 'Anna Teacher added you as a contact.',
        recipientType: 'student',
      },
      'https://example.test',
    );
    expect(html).toContain('href="https://example.test/account/privacy"');
  });

  // The link is per-type, not a blanket addition: a type with no student
  // destination gets none.
  it('adds no link to a notification type that has nowhere to send a student', () => {
    const { html } = renderNotificationEmail(
      { type: 'booking_cancelled', title: 'Cancelled', body: 'You cancelled Tuesday.', recipientType: 'student' },
      'https://example.test',
    );
    expect(html).not.toContain('href=');
  });

  it('gives a student payment request a Pay now button to its class’s pay page when the teacher has a payment method', () => {
    const { html } = renderNotificationEmail(
      {
        type: 'payment_request',
        title: 'Priced',
        body: '€5.75',
        recipientType: 'student',
        relatedClassId: 'class-9',
        teacherHasPaymentMethods: true,
      },
      'https://example.test',
    );
    expect(html).toContain('href="https://example.test/bookings/class-9/pay"');
    expect(html).toContain('Pay now');
  });

  it('gives a student payment reminder the same button when the teacher has a payment method', () => {
    const { html } = renderNotificationEmail(
      {
        type: 'reminder',
        title: 'Payment outstanding',
        body: '€5.75',
        recipientType: 'student',
        relatedClassId: 'class-9',
        teacherHasPaymentMethods: true,
      },
      'https://example.test',
    );
    expect(html).toContain('href="https://example.test/bookings/class-9/pay"');
  });

  // The body tells this student to pay the teacher directly; a button to a
  // page saying the same would only send them round.
  it.each(['payment_request', 'reminder'] as const)(
    'gives a student %s no button when the teacher has no payment method',
    (type) => {
      const { html } = renderNotificationEmail(
        { type, title: 'T', body: '€5.75', recipientType: 'student', relatedClassId: 'class-9', teacherHasPaymentMethods: false },
        'https://example.test',
      );
      expect(html).not.toContain('href=');
      expect(html).not.toContain('Pay now');
    },
  );

  it('gives a student payment notification no button when nobody said whether the teacher has a payment method', () => {
    const { html } = renderNotificationEmail(
      { type: 'payment_request', title: 'Priced', body: '€5.75', recipientType: 'student', relatedClassId: 'class-9' },
      'https://example.test',
    );
    expect(html).not.toContain('href=');
  });

  describe('a payment notification without a class', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('gets no button, and is recorded as PAYMENT_NOTIFICATION_WITHOUT_CLASS', () => {
      const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
      const { html } = renderNotificationEmail(
        {
          id: 'note-7',
          type: 'reminder',
          title: 'Payment outstanding',
          body: '€5.75',
          recipientType: 'student',
          relatedClassId: null,
          teacherHasPaymentMethods: true,
        },
        'https://example.test',
      );
      expect(html).not.toContain('href=');
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'PAYMENT_NOTIFICATION_WITHOUT_CLASS', notificationId: 'note-7', type: 'reminder' }),
        'payment notification has no related class; emailed without a Pay now button',
      );
    });

    it('records nothing for a payment notification that has its class', () => {
      const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
      renderNotificationEmail(
        { type: 'reminder', title: 'T', body: 'B', recipientType: 'student', relatedClassId: 'class-9', teacherHasPaymentMethods: true },
        'https://example.test',
      );
      expect(warn).not.toHaveBeenCalled();
    });

    it('records nothing for a teacher payment notification without a class', () => {
      const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
      renderNotificationEmail(
        { type: 'payment_request', title: 'T', body: 'B', recipientType: 'teacher', relatedClassId: null },
        'https://example.test',
      );
      expect(warn).not.toHaveBeenCalled();
    });
  });

  // Teachers receive payment_request too, and the pay page is a student route.
  // The flag is set so that a teacher falling through to the student branch
  // would get the button.
  it('keeps a teacher-audience payment request on the teacher branch: no Pay now', () => {
    const { html } = renderNotificationEmail(
      {
        type: 'payment_request',
        title: 'Class completed',
        body: 'Prices are out.',
        recipientType: 'teacher',
        relatedClassId: 'class-9',
        teacherHasPaymentMethods: true,
      },
      'https://example.test',
    );
    expect(html).not.toContain('/bookings/class-9/pay');
    expect(html).not.toContain('Pay now');
  });

  // #236 m5: an email meant to be acted on within a short grace or claim
  // window links to where the student acts on it.
  it('links a waitlist promotion to the student bookings page (#236)', () => {
    const { html } = renderNotificationEmail(
      {
        type: 'waitlist_promoted',
        title: 'You are in',
        body: 'A spot opened in Vinyasa and you moved off the waitlist.',
        recipientType: 'student',
      },
      'https://example.test',
    );
    expect(html).toContain(`href="https://example.test${STUDENT_BOOKINGS_PATH}"`);
  });

  it('links a spot-available broadcast to the student bookings page (#236)', () => {
    const { html } = renderNotificationEmail(
      {
        type: 'spot_available',
        title: 'A spot opened up',
        body: 'A spot opened in Vinyasa — first to claim it gets in.',
        recipientType: 'student',
      },
      'https://example.test',
    );
    expect(html).toContain(`href="https://example.test${STUDENT_BOOKINGS_PATH}"`);
  });

  it('gives a walk-in email a sign-in action', () => {
    const { html } = renderNotificationEmail(
      { type: 'walk_in_added', title: 't', body: 'b' },
      'https://example.test',
    );
    expect(html).toContain('href="https://example.test/login"');
    expect(html).toContain('Sign in');
  });

  it('magic-link email carries the link and the expiry note', () => {
    const { html, subject } = renderMagicLinkEmail('https://example.test/verify?token=abc');
    expect(subject).toBe('Sign in to fair.yoga');
    expect(html).toContain('https://example.test/verify?token=abc');
    expect(html).toContain('expires in 15 minutes');
  });

  it('escapeHtml handles all special characters', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });

  it('invitation email carries the teacher name and sign-in link', () => {
    const { html, subject } = renderInvitationEmail(
      'Anna Teacher',
      'https://example.test/login',
    );
    expect(subject).toContain('Anna Teacher');
    expect(html).toContain('Anna Teacher');
    expect(html).toContain('https://example.test/login');
  });

  it('invitation email escapes an HTML-bearing teacher name', () => {
    const { html } = renderInvitationEmail('<b>Anna</b>', 'https://example.test/login');
    expect(html).not.toContain('<b>Anna</b>');
    expect(html).toContain('&lt;b&gt;Anna&lt;/b&gt;');
  });

  it('invitation email carries no "welcome back" — same copy whether or not the address is already registered', () => {
    // notifyInvitee (services/invitations.ts) only ever calls this for an
    // address with neither a `Student` row nor a teacher account, but the
    // copy itself must not assume that — it is the one artifact of this
    // feature a recipient actually reads, and it must not leak whether
    // fair.yoga already knew their address.
    const { html } = renderInvitationEmail('Anna Teacher', 'https://example.test/login');
    expect(html.toLowerCase()).not.toContain('welcome back');
  });

  it('links a teacher-inbox invitation to the teacher invitations page (#172)', () => {
    const { html } = renderNotificationEmail(
      { type: 'teacher_invitation', title: 'A teacher would like to connect', body: 'Anna added you.', recipientType: 'teacher' },
      'https://example.test',
    );
    expect(html).toContain(`href="https://example.test${TEACHER_INVITATION_PATH}"`);
    expect(html).not.toContain(STUDENT_INVITATION_PATH);
  });

  it('still links a student invitation to the student page (#172)', () => {
    const { html } = renderNotificationEmail(
      { type: 'teacher_invitation', title: 'A teacher would like to connect', body: 'Anna added you.', recipientType: 'student' },
      'https://example.test',
    );
    expect(html).toContain(`href="https://example.test${STUDENT_INVITATION_PATH}"`);
    expect(html).not.toContain(TEACHER_INVITATION_PATH);
  });

  it('gives a teacher notification about a class no invitation link (#172)', () => {
    const { html } = renderNotificationEmail(
      { type: 'booking_confirmed', title: 'Anna booked', body: 'Tuesday Vinyasa.', recipientType: 'teacher' },
      'https://example.test',
    );
    expect(html).not.toContain(TEACHER_INVITATION_PATH);
    expect(html).not.toContain(STUDENT_INVITATION_PATH);
  });
});

describe('renderDegradationDigestEmail', () => {
  const entry = {
    code: 'INCOME_TIER_OUT_OF_RANGE',
    description: 'A stored income tier was outside 1–5.',
    firstSeenAt: new Date('2026-10-01T08:00:00.000Z'),
    lastSeenAt: new Date('2026-10-02T09:30:00.000Z'),
    occurrences: 12,
    sample: { tier: 9, studentId: 's-1' },
  };

  it('names the code in the subject for one event and the number for several', () => {
    expect(renderDegradationDigestEmail([entry]).subject).toContain('INCOME_TIER_OUT_OF_RANGE');
    expect(renderDegradationDigestEmail([entry, { ...entry, code: 'B' }]).subject).toContain('2');
  });

  it('shows the code, description, both times, the count and the sample', () => {
    const { html } = renderDegradationDigestEmail([entry]);
    expect(html).toContain('INCOME_TIER_OUT_OF_RANGE');
    expect(html).toContain('A stored income tier was outside 1–5.');
    expect(html).toContain('2026-10-01T08:00:00.000Z');
    expect(html).toContain('2026-10-02T09:30:00.000Z');
    expect(html).toContain('12');
    expect(html).toContain('studentId');
    expect(html).toContain('s-1');
  });

  it('escapes every interpolated value', () => {
    const { html } = renderDegradationDigestEmail([
      { ...entry, description: '<script>x</script>', sample: { timeZone: '"><img src=x>' } },
    ]);
    expect(html).not.toContain('<script>x</script>');
    expect(html).not.toContain('<img src=x>');
    expect(html).toContain('&lt;script&gt;');
  });
  describe('passkey-added email', () => {
    const addedAt = new Date('2026-10-06T14:03:00Z');

    it('says a passkey was added, when, and where to revoke it', () => {
      const { subject, html } = renderPasskeyAddedEmail(addedAt);
      expect(subject).toContain('passkey');
      expect(html).toContain('6 Oct 2026, 14:03 UTC');
      expect(html).toContain('sign out everywhere');
      expect(html).toContain('remove');
    });

    it('points teachers to Settings → Profile and students to Account', () => {
      const { html } = renderPasskeyAddedEmail(addedAt);
      expect(html).toContain('Settings → Profile');
      expect(html).toContain('Account');
      expect(html).not.toContain('open Settings');
    });

    it('carries no link, so there is no token to forward or phish with', () => {
      const { html } = renderPasskeyAddedEmail(addedAt);
      expect(html).not.toContain('<a ');
      expect(html).not.toContain('href');
    });
  });
});
