import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { getSession } from '@/lib/session';
import { Card } from '@/components/ui/card';
import { Wordmark } from '@/components/layout/wordmark';
import { LandingPricingDemo } from '@/components/landing/landing-pricing-demo';

const REPO_URL = 'https://github.com/ivohofland/fair.yoga';
const CONTACT_HREF = 'mailto:hello@fair.yoga';

const PRIMARY_LINK =
  'inline-flex items-center justify-center text-center bg-teal text-cream hover:bg-teal-hover active:bg-teal-pressed rounded-pill px-6 min-h-12 font-semibold text-base no-underline';

const VALUES = [
  {
    title: 'You earn your rate',
    body: 'Set a minimum and a target. Every price is worked out to pay you between the two.',
  },
  {
    title: 'Prices you can stand behind',
    body: 'See exactly what each class size means before you publish — no surprises, no discounts to manage.',
  },
  {
    title: 'No one priced out',
    body: 'The lowest tier keeps the practice within reach for people on a tight budget.',
  },
] as const;

const PROMISES = [
  {
    lead: 'Your students are yours.',
    body: 'Your contacts and relationships stay with you — not a platform’s list to be marketed to.',
  },
  {
    lead: 'Students pay you directly.',
    body: 'The app works out the price; the money goes straight from student to you. We’re never in the middle of your income.',
  },
  {
    lead: 'Bill after class, not before.',
    body: 'Prices settle once the class has happened, based on who registered. No upfront packages, no lock-in.',
  },
  {
    lead: 'Works alongside what you already have.',
    body: 'It sits next to your website, your studio work, your existing following — it doesn’t replace them.',
  },
  {
    lead: 'Private by default.',
    body: 'We collect as little as possible, and the most private settings are the ones already switched on.',
  },
] as const;

const YAMAS = [
  { name: 'Satya', gloss: 'truthfulness', body: 'Income tiers are self-reported. We trust, we don’t verify.' },
  { name: 'Asteya', gloss: 'non-stealing', body: 'No one is priced out of practice, and no one takes a cut of your work.' },
  { name: 'Aparigraha', gloss: 'non-hoarding', body: 'We hold as little of your data as we can, and the platform stays free.' },
  { name: 'Ahimsa', gloss: 'non-harm', body: 'The math never squeezes one side to favour the other — student, teacher, or studio.' },
] as const;

const STEPS = ['Profile', 'How students pay', 'Room', 'Class', 'Share'] as const;

function Section({
  id,
  kicker,
  title,
  children,
}: {
  id?: string;
  kicker: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="py-8">
      <p className="type-caption mb-1.5">{kicker}</p>
      <h2 className="type-title mb-4">{title}</h2>
      {children}
    </section>
  );
}

/**
 * The public front door. A signed-in visitor is sent to their own home
 * instead, so a bookmarked `/` still opens the app.
 */
export default async function LandingPage() {
  const session = await getSession();
  if (session?.teacherId) redirect('/schedule');
  if (session?.studentId) redirect('/bookings');

  return (
    <div className="flex flex-col">
      <nav aria-label="Site" className="flex items-center justify-between gap-4 pb-6">
        <Wordmark />
        <Link href="/login" className="type-label text-teal inline-flex items-center min-h-11">
          Sign in
        </Link>
      </nav>

      <header className="pt-6 pb-10">
        <p className="type-label mb-4">Making the economics of yoga fair for everyone involved</p>
        <h1 className="type-display text-ink mb-5">
          <em className="text-teal">Look around the room.</em> Do the people on the mats look like
          your neighbourhood?
        </h1>
        <p className="type-body mb-7">
          For most of us, the honest answer is no — not because we want it that way, but because
          price quietly decides who gets to walk in. This is a free toolkit for independent teachers
          who’d rather it didn’t: everyone pays what they can, you still earn a living, and no one
          takes a cut.
        </p>
        <div className="flex flex-col sm:flex-row sm:items-center gap-4">
          <Link href="/signup" className={PRIMARY_LINK}>
            Set up your first class
          </Link>
          <Link href="#pricing" className="type-body text-center sm:text-left">
            See how the pricing works <span aria-hidden="true">↓</span>
          </Link>
        </div>
        <p className="type-caption mt-4">Free forever · No commission · Bring your own students</p>
      </header>

      <Section
        kicker="The problem"
        title="Somewhere along the way, teaching became a business you never signed up for"
      >
        <p className="type-body mb-3.5">
          Rooms cost more every year. Set your price low and you can’t cover rent. Set it higher and
          you watch the people who need the practice most quietly drift away. Between room rent,
          booking fees, and platform commissions, the two people who matter — you and your students
          — are the ones left short.
        </p>
        <p className="type-body">
          It isn’t that anyone’s doing it wrong. It’s that the numbers were never built to be fair to
          both sides at once.
        </p>
      </Section>

      <Section kicker="A different starting point" title="A free toolkit for independent teachers">
        <p className="type-body mb-3.5">
          You bring your own students. It handles the scheduling, the pricing, who’s paid and who
          hasn’t, and the admin that eats your evenings. It isn’t a marketplace and isn’t a directory
          — no one browses for a cheaper teacher, and no one takes a percentage of what you earn.
        </p>
        <p className="type-body font-semibold text-ink mb-5">It’s free, and it stays free.</p>
        <p className="type-caption mb-2.5">The only thing we ask in return</p>
        <p className="type-title italic">Let people pay according to what they can afford.</p>
      </Section>

      <Section id="pricing" kicker="How it works" title="Fair pricing, worked out for you">
        <p className="type-body mb-6">
          Everyone books the same class. Behind the scenes, each student pays a little more or a
          little less depending on what they can afford — but the highest earner never pays more
          than about twice the lowest. You set the room cost and what you’d like to earn; the app
          calculates every price and shows its work. Nothing hidden, nothing to haggle over.
        </p>
        <LandingPricingDemo />
        <div className="grid gap-3 sm:grid-cols-3 mt-6">
          {VALUES.map((v) => (
            <Card key={v.title}>
              <h3 className="type-subtitle mb-1.5">{v.title}</h3>
              <p className="type-body">{v.body}</p>
            </Card>
          ))}
        </div>
      </Section>

      <Section kicker="Your practice, your rules" title="It’s your practice. It stays yours.">
        <ul className="flex flex-col">
          {PROMISES.map((p) => (
            <li key={p.lead} className="type-body py-4 border-b border-border last:border-b-0">
              <strong className="font-semibold text-ink">{p.lead}</strong> {p.body}
            </li>
          ))}
        </ul>
      </Section>

      <Section kicker="Why it’s built this way" title="Built on yoga’s own values">
        <div className="grid gap-3 sm:grid-cols-2">
          {YAMAS.map((y) => (
            <Card key={y.name}>
              <h3 className="flex items-baseline gap-2 mb-1.5">
                <span className="type-subtitle">{y.name}</span>
                <span className="type-caption">{y.gloss}</span>
              </h3>
              <p className="type-body">{y.body}</p>
            </Card>
          ))}
        </div>
        <p className="type-body mt-5">
          The app is open source, built by volunteers, and honest about what it costs to run —
          supported by teachers who choose to give back, never by fees.
        </p>
        <p className="type-caption mt-3">Open source · No fees</p>
      </Section>

      <section id="start" className="pt-10 pb-8">
        <Card className="px-6 py-8">
          <p className="type-caption mb-1.5">Get started</p>
          <h2 className="type-title mb-3">Set up your first class in a few minutes</h2>
          <p className="type-body mb-5">
            Fill in your profile and how students pay you, add your room, create your first class, and share
            your page. That’s it.
          </p>
          <ol className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-7 type-body text-ink">
            {STEPS.map((step, i) => (
              <li key={step}>
                {i > 0 && (
                  <span aria-hidden="true" className="text-brown-light mr-3">
                    →
                  </span>
                )}
                <span className="font-semibold text-teal">{i + 1}</span>&nbsp;{step}
              </li>
            ))}
          </ol>
          <Link href="/signup" className={PRIMARY_LINK}>
            Get started — it’s free
          </Link>
          <p className="type-caption mt-3.5">No fees. No commission. No catch.</p>
        </Card>
      </section>

      <footer className="border-t border-border pt-6 flex flex-col gap-2.5">
        <Wordmark />
        <p className="type-caption">Making the economics of yoga fair for everyone involved.</p>
        <p className="type-caption flex flex-wrap gap-2">
          <a href={REPO_URL}>Open source</a>
          <span aria-hidden="true">·</span>
          <a href={CONTACT_HREF}>Contact</a>
          <span aria-hidden="true">·</span>
          <Link href="/login">Sign in</Link>
        </p>
      </footer>
    </div>
  );
}
