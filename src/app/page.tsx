import type { Metadata } from 'next';
import Link from 'next/link';
import { getSession } from '@/lib/session';
import { isSignedIn } from '@/lib/marketing-session';
import { siteUrl } from '@/lib/seo';
import { Icon } from '@/components/ui/icon';
import { FeatureBand } from '@/components/landing/feature-band';
import { SiteFooter } from '@/components/landing/site-footer';
import { SiteHeader } from '@/components/landing/site-header';
import { Band, HEADING, KICKER, LEAD } from '@/components/landing/band';
import {
  COLUMN,
  PRIMARY_LINK,
  REPO_URL,
  SECONDARY_LINK,
} from '@/components/landing/landing-links';

const TITLE = 'fair.yoga — free sliding-scale and donation booking for yoga teachers';
const DESCRIPTION =
  'Free, open source booking for independent yoga teachers. Sliding-scale or donation pricing, in-person and online classes, paid straight to you.';

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  alternates: { canonical: '/' },
  openGraph: { title: TITLE, description: DESCRIPTION, url: '/', siteName: 'fair.yoga', type: 'website' },
};

/** schema.org's account of the product, for search results. */
function structuredData(): string {
  const data = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'fair.yoga',
    description: DESCRIPTION,
    url: siteUrl().href,
    applicationCategory: 'BusinessApplication',
    operatingSystem: 'Web',
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'EUR' },
  };
  // `<` escaped so no string in the data can close the script element.
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

const PROMISES = [
  {
    lead: 'Your students stay yours',
    body: 'Your contacts and relationships stay with you, never on a platform’s list to market to.',
  },
  {
    lead: 'Money goes straight to you',
    body: 'Payments go straight from student to you. Only your provider’s usual fee applies; we add nothing.',
  },
  {
    lead: 'Paid after class, not before',
    body: 'Prices settle after class, based on who registered. No upfront packages, no lock-in.',
  },
  {
    lead: 'Works with what you have',
    body: 'Keep your website, your studio work and your following. fair.yoga sits next to them.',
  },
  {
    lead: 'Private by default',
    body: 'We collect as little as possible, and the most private settings are on by default.',
  },
] as const;

const PRINCIPLES = [
  { title: 'Trust, not checks', body: 'Students tell us which income tier fits them. Nobody asks them for proof.' },
  { title: 'We don’t take a cut', body: 'No one is priced out of class, and fair.yoga never takes a share of your earnings.' },
  { title: 'Only what’s needed', body: 'We hold as little data as we can, and the platform stays free.' },
  {
    title: 'No side gets squeezed',
    body: 'The numbers never favour one side over another: student, teacher or studio.',
  },
] as const;

const STEPS = [
  { title: 'Profile', body: 'Who you are and what you teach' },
  { title: 'Payments', body: 'How students pay you' },
  { title: 'Room', body: 'Where you teach and what it costs' },
  { title: 'Class', body: 'Time, size and what you’d like to earn' },
  { title: 'Share', body: 'Send your page to your students' },
] as const;

/**
 * The public front door, the same page for everyone. The app's own door is
 * `/start`, which the header and footer offer a signed-in visitor.
 */
export default async function LandingPage() {
  const signedIn = isSignedIn(await getSession());

  return (
    // text-pretty is inherited: no paragraph on the page ends on a lone word
    <div className="flex flex-col flex-1 text-pretty">
      {/* A data block, not a script: the browser never runs it, so the CSP's nonce has no say. */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: structuredData() }} />
      <SiteHeader signedIn={signedIn} onHome />

      <section className={`${COLUMN} pt-12 sm:pt-16 pb-12`}>
        <div className="max-w-[680px] flex flex-col gap-5">
          <p className={KICKER}>For independent yoga teachers.</p>
          <h1 className="font-heading font-bold text-[clamp(28px,4.2vw,44px)] leading-[1.2] text-ink">
            <em className="text-teal">A free booking system</em> that prices no one out.
          </h1>
          <p className={LEAD}>
            Plan your classes, take bookings and get paid, all in one place. Prices follow income, so your room
            fills with your whole neighbourhood, not just the people who can afford it.
          </p>
          <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-6 pt-2">
            <Link href="/signup" className={PRIMARY_LINK}>
              Set up your first class
            </Link>
            <Link href="#features" className="type-body text-center sm:text-left">
              See what it does <span aria-hidden="true">↓</span>
            </Link>
          </div>
        </div>
      </section>

      <Band bottom="pb-12 sm:pb-16">
        <div className="max-w-[680px] flex flex-col gap-5">
          <p className={KICKER}>Why it exists</p>
          <h2 className={`${HEADING} text-ink`}>
            <em className="text-teal">Look around the room.</em> Do the people on the mats look like your
            neighbourhood?
          </h2>
          <p className={LEAD}>
            For most of us, the honest answer is no. Not because we want it that way, but because price quietly
            decides who gets to walk in.
          </p>
          <p className="type-body">
            Rooms cost more every year. Set your price low and you can’t cover the rent. Set it higher and the
            people who’d benefit most quietly drift away. Add booking fees and platform commissions on top, and
            it’s you and your students who end up short.
          </p>
          <p className="type-body text-ink">
            Nobody’s doing it wrong. The numbers were just never built to be fair to both sides at once.
          </p>
        </div>
      </Band>

      <section className={`${COLUMN} pb-16 sm:pb-24`}>
        <div className="bg-teal-tint rounded-card px-6 py-10 sm:p-14 flex flex-col items-center text-center gap-3">
          <p className="type-body text-ink">fair.yoga is free, and it stays free. The only thing we ask in return:</p>
          <p className="font-heading font-bold italic text-[clamp(22px,3vw,28px)] leading-[1.3] text-teal max-w-[22em]">
            Let people pay according to what they can afford.
          </p>
        </div>
      </section>

      <FeatureBand />

      <Band className="flex flex-col gap-10">
        <div className="max-w-[680px] flex flex-col gap-5">
          <p className={KICKER}>Not a marketplace</p>
          <h2 className={`${HEADING} text-teal`}>Your students, your income, your rules</h2>
          <p className="type-body">
            You bring your own students. fair.yoga takes care of the scheduling, the pricing, who’s paid and
            who hasn’t, and the admin that eats your evenings. Nobody browses for a cheaper teacher, and
            fair.yoga never takes a percentage of what you earn.
          </p>
        </div>
        <ul className="grid sm:grid-cols-2 gap-x-12 gap-y-8">
          {PROMISES.map((p) => (
            <li key={p.lead} className="flex gap-3 items-start">
              <Icon name="check" size={20} className="text-teal shrink-0 mt-0.5" />
              <p className="type-body flex flex-col gap-1">
                <strong className="font-semibold text-ink">{p.lead}</strong>
                <span>{p.body}</span>
              </p>
            </li>
          ))}
        </ul>
      </Band>

      <Band id="open-source" className="flex flex-col gap-10">
        <div className="max-w-[680px] flex flex-col gap-5">
          <p className={KICKER}>What it’s built on</p>
          <h2 className={`${HEADING} text-teal`}>Fair to everyone in the room</h2>
        </div>
        <ul className="grid sm:grid-cols-2 lg:grid-cols-4 gap-8">
          {PRINCIPLES.map((p) => (
            <li key={p.title} className="border-t border-border pt-5 flex flex-col gap-2">
              <h3 className="type-subtitle text-teal">{p.title}</h3>
              <p className="type-body">{p.body}</p>
            </li>
          ))}
        </ul>
        <div className="bg-sand border border-border rounded-card p-6 sm:p-8 flex flex-col md:flex-row md:items-center md:justify-between gap-5">
          <div className="flex flex-col gap-2 md:max-w-[34em]">
            <h3 className="type-title text-ink">Open source, built by volunteers</h3>
            <p className="type-body">
              The code is public and we’re open about what it costs to run. fair.yoga is kept going by teachers
              who choose to give something back, never by fees.
            </p>
          </div>
          <a href={REPO_URL} className={`${SECONDARY_LINK} shrink-0`}>
            See the code on GitHub
          </a>
        </div>
      </Band>

      <Band id="start" bottom="pb-16 sm:pb-20" className="flex flex-col gap-8">
        <div className="max-w-[680px] flex flex-col gap-5">
          <p className={KICKER}>Get started</p>
          <h2 className={`${HEADING} text-teal`}>Your first class, ready in a few minutes</h2>
          <p className="type-body">Five short steps, then you have a page to share with your students.</p>
        </div>
        <ol className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          {STEPS.map((step, i) => (
            <li
              key={step.title}
              className="bg-sand border border-border rounded-field p-4 flex sm:flex-col gap-3 items-start"
            >
              <span className="size-8 shrink-0 rounded-full bg-teal-tint text-teal font-semibold flex items-center justify-center">
                {i + 1}
              </span>
              <span className="flex flex-col">
                <span className="font-semibold text-ink">{step.title}</span>
                <span className="text-[13px] text-brown">{step.body}</span>
              </span>
            </li>
          ))}
        </ol>
        <div>
          <Link href="/signup" className={PRIMARY_LINK}>
            Set up your first class
          </Link>
        </div>
      </Band>

      <SiteFooter signedIn={signedIn} />
    </div>
  );
}
