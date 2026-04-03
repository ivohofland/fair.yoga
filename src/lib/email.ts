import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

export async function sendMagicLinkEmail(
  to: string,
  magicLink: string
): Promise<void> {
  if (
    !process.env.RESEND_API_KEY ||
    process.env.RESEND_API_KEY === 're_placeholder'
  ) {
    console.log(`\n[DEV] Magic link for ${to}: ${magicLink}\n`);
    return;
  }

  await resend.emails.send({
    from: process.env.EMAIL_FROM || 'noreply@fair.yoga',
    to,
    subject: 'Sign in to fair.yoga',
    html: `<p>Click <a href="${magicLink}">here</a> to sign in to fair.yoga.</p><p>This link expires in 15 minutes.</p>`,
  });
}
