import { describe, it, expect } from 'vitest';
import {
  escapeHtml,
  renderNotificationEmail,
  renderMagicLinkEmail,
  renderInvitationEmail,
} from './email-templates';
import { STUDENT_INVITATION_PATH, STUDENT_BOOKINGS_PATH, TEACHER_INVITATION_PATH } from './notification-links';

describe('email templates', () => {
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

  // The link is per-type, not a blanket addition: every other type is about
  // a class, and the routes for those are teacher-only.
  it('adds no link to a notification type that has nowhere to send a student', () => {
    const { html } = renderNotificationEmail(
      { type: 'reminder', title: 'Reminder', body: 'Class tomorrow.', recipientType: 'student' },
      'https://example.test',
    );
    expect(html).not.toContain('href=');
  });

  // #236 m5: the one email built to be read inside a 15-minute grace (or a
  // 60-minute claim race) had nowhere to click.
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
