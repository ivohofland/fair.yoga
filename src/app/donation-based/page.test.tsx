import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { GIVE_PAGE_HEADING } from '@/lib/give-page-copy';

const getSession = vi.fn();

vi.mock('@/lib/session', () => ({ getSession: () => getSession() }));

beforeEach(() => {
  getSession.mockReset();
  getSession.mockResolvedValue(null);
});

async function renderPage(): Promise<void> {
  const { default: DonationBasedPage } = await import('./page');
  render(await DonationBasedPage());
}

describe('/donation-based metadata', () => {
  it('is indexable under its own canonical', async () => {
    const { metadata } = await import('./page');
    expect(metadata.title).toEqual({ absolute: 'Donation-based yoga classes · fair.yoga' });
    expect(metadata.description).toBe(
      'Offer classes without a price. Students book as usual, and after class everyone who came is invited once to give what they can, straight to you.',
    );
    expect(metadata.alternates?.canonical).toBe('/donation-based');
    expect(metadata.openGraph).toBeUndefined();
    expect(metadata.robots).toBeUndefined();
  });
});

describe('/donation-based page', () => {
  it('has one h1 and never redirects a signed-in visitor', async () => {
    getSession.mockResolvedValue({ sessionId: 's', accountId: 'a', defaultTimezone: 'UTC', teacherId: 't', studentId: null });
    await renderPage();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getAllByRole('link', { name: 'Open the app' }).every((a) => a.getAttribute('href') === '/start')).toBe(true);
  });

  it('trails back home', async () => {
    await renderPage();
    const trail = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(trail.textContent).toContain('Donation-based classes');
    expect(trail.querySelector('a')?.getAttribute('href')).toBe('/');
  });

  it('shows the four steps, numbered', async () => {
    await renderPage();
    for (const t of ['Offer the class', 'Everyone is welcome', 'An open hand, once', 'Receive with thanks']) {
      expect(screen.getByText(t)).toBeTruthy();
    }
    expect(document.body.textContent).toContain('When you set up a class, or a recurring one, choose By donation. Students book, join the waitlist and walk in just as they would for any other class.');
    expect(document.body.textContent).toContain('No price appears anywhere, so nobody has to weigh whether they can afford to come.');
    expect(document.body.textContent).toContain('After class, everyone who came receives one quiet invitation to give, if and as they wish.');
    expect(document.body.textContent).toContain('Note what came in for the class as a whole, for your own records.');
  });

  it('makes the four promises', async () => {
    await renderPage();
    for (const t of ['No price on generosity', 'Asked once, never chased', 'Giving stays private', 'From hand to hand']) {
      expect(screen.getByText(t)).toBeTruthy();
    }
    expect(document.body.textContent).toContain('No suggested amount, no default. Even the QR code leaves the amount blank.');
    expect(document.body.textContent).toContain('One invitation after class. A reminder would turn a gift into a debt.');
    expect(document.body.textContent).toContain('You see what came in for the class, never who gave what.');
    expect(document.body.textContent).toContain('Gifts go straight to your own account or payment link. Nothing passes through fair.yoga.');
  });

  it('mirrors the give page inside a labelled, inert illustration', async () => {
    await renderPage();
    const phone = screen.getByRole('img', { name: /give page/i });
    expect(phone.textContent).toContain(GIVE_PAGE_HEADING);
    expect(phone.textContent).toContain('Slow flow · Tuesday, 3 Nov · with Anna Smith');
    expect(phone.textContent).toContain('Your bookings');
    expect(phone.querySelector('[inert]')).toBeTruthy();
    expect(phone.className).not.toMatch(/shadow/);
  });

  it('compares the two ways, linking to sliding scale', async () => {
    await renderPage();
    expect(screen.getByText('By donation')).toBeTruthy();
    expect(screen.getByRole('link', { name: /How sliding scale works/ }).getAttribute('href')).toBe('/sliding-scale');
    expect(document.body.textContent).toContain('You don’t have to choose one: you could offer some classes by donation and others on a sliding scale.');
  });

  it('answers the questions, the first open', async () => {
    await renderPage();
    for (const q of [
      'Can I suggest an amount?',
      'Do walk-ins receive the invitation too?',
      'Can I switch a class between donation and sliding scale?',
      'I take payments through Mollie. Can students give that way?',
      'What does fair.yoga take?',
    ]) {
      expect(screen.getByText(q)).toBeTruthy();
    }
    // One shared name: opening a question closes the others. The phone
    // illustration's method rows are details too, under their own name.
    const items = document.querySelectorAll('details[name="faq"]');
    expect(items).toHaveLength(5);
    expect(items[0]?.hasAttribute('open')).toBe(true);
    expect(items[1]?.hasAttribute('open')).toBe(false);
    expect(document.body.textContent).toContain(
      'Not yet: fair.yoga’s Mollie payments are for a set amount, and a gift has none. If Mollie is all you use, students are invited to give to you directly, however suits them. Add your bank details or a payment link alongside it, and they can give online too.',
    );
  });

  it('ends with a call to action to /signup, and never says dana', async () => {
    await renderPage();
    expect(screen.getByText('Offer your next class by donation')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Set up your first class' }).getAttribute('href')).toBe('/signup');
    expect(document.body.textContent?.toLowerCase()).not.toContain('dana');
  });
});
