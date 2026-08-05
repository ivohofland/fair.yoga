import { describe, it, expect } from 'vitest';
import {
  escapeHtml,
  renderNotificationEmail,
  renderMagicLinkEmail,
  renderInvitationEmail,
} from './email-templates';

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
    // notifyInvitee (services/invitations.ts) only ever calls this for the
    // "no Student row" branch, but the copy itself must not assume that —
    // it is the one artifact of this feature a recipient actually reads,
    // and it must not leak whether fair.yoga already knew their address.
    const { html } = renderInvitationEmail('Anna Teacher', 'https://example.test/login');
    expect(html.toLowerCase()).not.toContain('welcome back');
  });
});
