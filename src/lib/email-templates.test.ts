import { describe, it, expect } from 'vitest';
import {
  escapeHtml,
  renderNotificationEmail,
  renderMagicLinkEmail,
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

  it('magic-link email carries the link and the expiry note', () => {
    const { html, subject } = renderMagicLinkEmail('https://example.test/verify?token=abc');
    expect(subject).toBe('Sign in to fair.yoga');
    expect(html).toContain('https://example.test/verify?token=abc');
    expect(html).toContain('expires in 15 minutes');
  });

  it('escapeHtml handles all special characters', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });
});
