import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

function emailConfigured(): boolean {
  return Boolean(
    process.env.RESEND_API_KEY && process.env.RESEND_API_KEY !== 're_placeholder',
  );
}

export async function sendMagicLinkEmail(
  to: string,
  magicLink: string
): Promise<void> {
  if (!emailConfigured()) {
    // In production a missing key must fail loudly: logging the raw sign-in
    // link to stdout while telling the user "check your inbox" leaks auth
    // tokens into logs and silently breaks login.
    if (process.env.NODE_ENV === 'production') {
      throw new Error('RESEND_API_KEY is not configured — cannot send magic-link email');
    }
    console.log(`\n[DEV] Magic link for ${to}: ${magicLink}\n`);
    return;
  }

  const { error } = await resend.emails.send({
    from: process.env.EMAIL_FROM || 'noreply@fair.yoga',
    to,
    subject: 'Sign in to fair.yoga',
    html: `<p>Click <a href="${magicLink}">here</a> to sign in to fair.yoga.</p><p>This link expires in 15 minutes.</p>`,
  });

  // The Resend SDK reports API failures via { error }, it does not throw.
  if (error) {
    throw new Error(`Failed to send magic-link email: ${error.message}`);
  }
}
