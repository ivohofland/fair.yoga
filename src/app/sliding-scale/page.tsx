import type { Metadata } from 'next';
import Link from 'next/link';
import { getSession } from '@/lib/session';
import { isSignedIn } from '@/lib/marketing-session';
import { Icon } from '@/components/ui/icon';
import { Band, HEADING, KICKER, LEAD } from '@/components/landing/band';
import { COLUMN, PRIMARY_LINK } from '@/components/landing/landing-links';
import { PricingCalculator } from '@/components/landing/pricing-calculator';
import { SiteFooter } from '@/components/landing/site-footer';
import { SiteHeader } from '@/components/landing/site-header';
import { parseExampleKey } from '@/lib/pricing-examples';
import { TIER_INFO, TIER_RATIOS } from '@/lib/tiers';

export const metadata: Metadata = {
  title: { absolute: 'Sliding-scale pricing for yoga classes · fair.yoga' },
  description:
    'Five income tiers, the highest paying about twice the lowest. Set your minimum and target; fair.yoga works out every price. Try the examples.',
  alternates: { canonical: '/sliding-scale' },
};

const POINTS = [
  { title: 'You earn your rate', body: 'Prices are set so you always land between your minimum and your target.' },
  { title: 'No surprises', body: 'See what every class size means for you before you publish. No discounts to manage.' },
  { title: 'No one priced out', body: 'The lowest tier keeps your classes within reach for people on a tight budget.' },
] as const;

const QUESTIONS = [
  {
    q: 'Do students have to prove their income?',
    a: 'No. They pick the tier that fits their life right now. The highest tier pays about twice the lowest, so a choice that’s off by one makes only a small difference.',
  },
  {
    q: 'What if only a few people come?',
    a: 'Below your minimum number of students, the class auto-cancels at the time you choose. At or above it, you earn at least your minimum rate.',
  },
  {
    q: 'Can I just charge one price?',
    a: 'Yes: set your minimum equal to your target and you earn the same every class.',
  },
  {
    q: 'What does fair.yoga take?',
    a: 'Nothing. It’s free and open source, and students pay you directly.',
  },
] as const;

/** Explains the income tiers and hosts the example calculator; the same page for everyone. */
export default async function SlidingScalePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [session, params] = await Promise.all([getSession(), searchParams]);
  const signedIn = isSignedIn(session);

  return (
    <div className="flex flex-col flex-1 text-pretty">
      <SiteHeader signedIn={signedIn} onHome={false} />

      <section className={`${COLUMN} pt-8 sm:pt-12 pb-12`}>
        <div className="max-w-[680px] flex flex-col gap-5">
          <nav aria-label="Breadcrumb" className={KICKER}>
            <Link href="/">fair.yoga</Link> / <span>Sliding scale</span>
          </nav>
          <h1 className="font-heading font-bold text-[clamp(28px,4.2vw,44px)] leading-[1.2] text-ink">
            <em className="text-teal">Sliding-scale pricing</em> for yoga classes, worked out for you
          </h1>
          <p className={LEAD}>
            Everyone books the same class. Each student picks the income tier that fits their life, and pays a
            little more or a little less. You set what you need to earn; fair.yoga does the sums.
          </p>
        </div>
      </section>

      <Band className="flex flex-col gap-10">
        <div className="max-w-[680px] flex flex-col gap-5">
          <p className={KICKER}>How it works</p>
          <h2 className={`${HEADING} text-teal`}>Five tiers, never more than about twice apart.</h2>
        </div>
        <div className="grid md:grid-cols-2 gap-10 items-center">
          <div className="flex flex-col gap-4">
            <p className="type-body">
              Students choose a tier when they book. Nobody asks for proof: trust, not checks.
            </p>
            <p className="type-body">
              You enter what the room costs, the least you need to earn and what you’d like to earn. After
              class, the price is set from who registered: the more students, the closer you get to your target
              and the less each person pays.
            </p>
            <p className="type-body">
              A middle-tier student pays the plain share. The highest tier pays about twice what the lowest
              does, so nobody is priced out and nobody is squeezed.
            </p>
          </div>
          <ol className="bg-sand-soft border border-border rounded-card divide-y divide-border">
            {TIER_INFO.map((t) => (
              <li key={t.tier} className="flex items-center gap-4 px-5 py-4">
                <span className="size-8 shrink-0 rounded-full bg-teal-tint text-teal font-semibold flex items-center justify-center">
                  {t.tier}
                </span>
                <span className="flex flex-col flex-1">
                  <span className="font-semibold text-ink">{t.label}</span>
                  <span className="text-[13px] text-brown">{t.caption}</span>
                </span>
                <span className="type-number">{TIER_RATIOS[t.tier]}×</span>
              </li>
            ))}
          </ol>
        </div>
      </Band>

      <Band id="examples" className="flex flex-col gap-8">
        <div className="max-w-[680px] flex flex-col gap-5">
          <p className={KICKER}>Try it</p>
          <h2 className={`${HEADING} text-teal`}>What would your class look like?</h2>
        </div>
        <PricingCalculator initialExample={parseExampleKey(params.example)} />
      </Band>

      <Band className="flex flex-col gap-10">
        <div className="max-w-[680px] flex flex-col gap-5">
          <p className={KICKER}>What it means for you</p>
          <h2 className={`${HEADING} text-teal`}>Your rate, without the guesswork.</h2>
        </div>
        <ul className="grid sm:grid-cols-3 gap-8">
          {POINTS.map((p) => (
            <li key={p.title} className="border-t border-border pt-5 flex flex-col gap-2">
              <h3 className="type-subtitle text-teal">{p.title}</h3>
              <p className="type-body">{p.body}</p>
            </li>
          ))}
        </ul>
        <div className="max-w-[680px] flex flex-col">
          {QUESTIONS.map((item, i) => (
            <details key={item.q} open={i === 0} className="group border-t border-border last:border-b">
              <summary className="flex items-center justify-between gap-4 min-h-14 py-3 font-semibold text-ink list-none [&::-webkit-details-marker]:hidden">
                {item.q}
                <Icon name="chevron-right" size={20} className="text-teal shrink-0 group-open:rotate-90" />
              </summary>
              <p className="type-body pb-5">{item.a}</p>
            </details>
          ))}
        </div>
      </Band>

      <section className={`${COLUMN} pb-16 sm:pb-24`}>
        <div className="bg-teal-tint rounded-card px-6 py-10 sm:p-14 flex flex-col items-center text-center gap-5">
          <p className="font-heading font-bold italic text-[clamp(22px,3vw,28px)] leading-[1.3] text-teal max-w-[22em]">
            Try it with your own room and rate
          </p>
          <Link href="/signup" className={PRIMARY_LINK}>
            Set up your first class
          </Link>
        </div>
      </section>

      <SiteFooter signedIn={signedIn} />
    </div>
  );
}
