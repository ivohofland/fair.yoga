import type { Metadata } from 'next';
import Link from 'next/link';
import { getSession } from '@/lib/session';
import { isSignedIn } from '@/lib/marketing-session';
import { Icon } from '@/components/ui/icon';
import { Band, HEADING, KICKER, LEAD } from '@/components/landing/band';
import { GivePagePhone } from '@/components/landing/give-page-phone';
import { COLUMN, PRIMARY_LINK } from '@/components/landing/landing-links';
import { SiteFooter } from '@/components/landing/site-footer';
import { SiteHeader } from '@/components/landing/site-header';

export const metadata: Metadata = {
  title: { absolute: 'Donation-based yoga classes · fair.yoga' },
  description:
    'Offer classes without a price. Students book as usual, and after class everyone who came is invited once to give what they can, straight to you.',
  alternates: { canonical: '/donation-based' },
};

const STEPS = [
  { title: 'Offer the class', body: 'When you set up a class, or a recurring one, choose By donation. Students book, join the waitlist and walk in just as they would for any other class.' },
  { title: 'Everyone is welcome', body: 'No price appears anywhere, so nobody has to weigh whether they can afford to come.' },
  { title: 'An open hand, once', body: 'After class, everyone who came receives one quiet invitation to give, if and as they wish.' },
  { title: 'Receive with thanks', body: 'Note what came in for the class as a whole, for your own records.' },
] as const;

const PROMISES = [
  { title: 'No price on generosity', body: 'No suggested amount, no default. Even the QR code leaves the amount blank.' },
  { title: 'Asked once, never chased', body: 'One invitation after class. A reminder would turn a gift into a debt.' },
  { title: 'Giving stays private', body: 'You see what came in for the class, never who gave what.' },
  { title: 'From hand to hand', body: 'Gifts go straight to your own account or payment link. Nothing passes through fair.yoga.' },
] as const;

const DONATION_POINTS = [
  'The teaching is a gift, open to anyone',
  'What you receive follows generosity, not a formula',
  'For community classes, or whenever you’d rather not set a price',
] as const;

const SCALE_POINTS = [
  'Each student pays according to their circumstances',
  'You can count on a floor: your minimum is always covered',
  'For classes that have to cover a room every week',
] as const;

const QUESTIONS = [
  { q: 'Can I suggest an amount?', a: 'No, by design. A suggested amount quietly becomes a price, and these classes have none.' },
  { q: 'Do walk-ins receive the invitation too?', a: 'Yes. Everyone who practised is invited in the same way.' },
  {
    q: 'Can I switch a class between donation and sliding scale?',
    a: 'Yes, until the first student books. After that the class keeps its pricing.',
  },
  {
    q: 'I take payments through Mollie. Can students give that way?',
    a: 'Not yet: fair.yoga’s Mollie payments are for a set amount, and a gift has none. If Mollie is all you use, students are invited to give to you directly, however suits them. Add your bank details or a payment link alongside it, and they can give online too.',
  },
  { q: 'What does fair.yoga take?', a: 'Nothing. fair.yoga itself runs on teachers’ donations, in the same spirit.' },
] as const;

function PointList({ points }: { points: readonly string[] }) {
  return (
    <ul className="flex flex-col gap-2">
      {points.map((p) => (
        <li key={p} className="type-body">{p}</li>
      ))}
    </ul>
  );
}

/** Explains donation classes, with an illustration of what students see; the same page for everyone. */
export default async function DonationBasedPage() {
  const session = await getSession();
  const signedIn = isSignedIn(session);

  return (
    <div className="flex flex-col flex-1 text-pretty">
      <SiteHeader signedIn={signedIn} onHome={false} />

      <section className={`${COLUMN} pt-8 sm:pt-12 pb-12`}>
        <div className="max-w-[680px] flex flex-col gap-5">
          <nav aria-label="Breadcrumb" className={KICKER}>
            <Link href="/">fair.yoga</Link> / <span>Donation-based classes</span>
          </nav>
          <h1 className="font-heading font-bold text-[clamp(28px,4.2vw,44px)] leading-[1.2] text-ink">
            <em className="text-teal">Donation-based yoga classes</em>, offered freely.
          </h1>
          <p className={LEAD}>
            Offer your teaching without a price, and let students give what they can, if they can. fair.yoga
            quietly takes care of the practical part.
          </p>
        </div>
      </section>

      <Band className="flex flex-col gap-10">
        <div className="max-w-[680px] flex flex-col gap-5">
          <p className={KICKER}>How it works</p>
          <h2 className={`${HEADING} text-teal`}>Offered freely, received with thanks.</h2>
        </div>
        <ol className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {STEPS.map((step, i) => (
            <li key={step.title} className="bg-sand border border-border rounded-field p-4 flex sm:flex-col gap-3 items-start">
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
      </Band>

      <Band className="flex flex-col gap-10">
        <div className="max-w-[680px] flex flex-col gap-5">
          <p className={KICKER}>What your students see</p>
          <h2 className={`${HEADING} text-teal`}>Generosity, without obligation.</h2>
        </div>
        <div className="grid md:grid-cols-2 gap-10 items-center">
          <GivePagePhone />
          <ul className="flex flex-col gap-6">
            {PROMISES.map((p) => (
              <li key={p.title} className="flex gap-3 items-start">
                <Icon name="check" size={20} className="text-teal shrink-0 mt-0.5" />
                <span className="flex flex-col gap-1">
                  <span className="font-semibold text-ink">{p.title}</span>
                  <span className="type-body">{p.body}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </Band>

      <Band className="flex flex-col gap-10">
        <div className="max-w-[680px] flex flex-col gap-5">
          <p className={KICKER}>Which fits your class?</p>
          <h2 className={`${HEADING} text-teal`}>Two ways to keep the door open.</h2>
        </div>
        <div className="grid md:grid-cols-2 gap-6">
          <div className="bg-sand-soft border border-border rounded-card p-6 flex flex-col gap-4">
            <h3 className="type-subtitle text-teal">By donation</h3>
            <PointList points={DONATION_POINTS} />
          </div>
          <div className="border border-border rounded-card p-6 flex flex-col gap-4">
            <h3 className="type-subtitle text-teal">Sliding scale</h3>
            <PointList points={SCALE_POINTS} />
            <Link href="/sliding-scale" className="type-label text-teal font-semibold">
              How sliding scale works →
            </Link>
          </div>
        </div>
        <p className="type-body italic max-w-[680px]">
          You don’t have to choose one: you could offer some classes by donation and others on a sliding scale.
        </p>
        <div className="max-w-[680px] flex flex-col">
          {QUESTIONS.map((item, i) => (
            <details key={item.q} name="faq" open={i === 0} className="group border-t border-border last:border-b">
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
            Offer your next class by donation
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
