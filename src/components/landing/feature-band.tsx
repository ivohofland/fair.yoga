import Link from 'next/link';
import type { ReactNode } from 'react';
import { Icon } from '@/components/ui/icon';
import { COLUMN } from './landing-links';
import { ProofBox } from './proof-box';

interface Card {
  label: string;
  promise: string;
  items: readonly ReactNode[];
  extra?: ReactNode;
}

const CARDS: readonly Card[] = [
  {
    label: 'Pricing',
    promise: 'Charge what’s fair, earn what you need',
    items: [
      <>
        <Link href="/sliding-scale">Sliding scale</Link>: five income tiers, the highest pays about twice the
        lowest
      </>,
      <>
        <Link href="/donation-based">Donation-based</Link>: students give what they can after class
      </>,
      'Or one flat rate, if you prefer',
      'VAT and your own currency',
    ],
    extra: <ProofBox />,
  },
  {
    label: 'Classes',
    promise: 'Your schedule, set once',
    items: [
      'Recurring classes that fill your calendar ahead',
      'Your live schedule on your own website, plus a calendar feed students can subscribe to',
      'Online classes: the join link reaches only booked students',
      'Private classes, shared by link and kept off your page',
      'Your rooms and what they cost you',
      'Auto-cancel when too few sign up',
    ],
  },
  {
    label: 'Students',
    promise: 'Fill the room without chasing',
    items: [
      'One link to share, booked in a few taps',
      'A waitlist that promotes people on its own',
      'Walk-ins at the door',
      'Reminders and announcements',
      'Each student decides what you can see',
    ],
  },
  {
    label: 'Money',
    promise: 'Paid directly, tracked for you',
    items: [
      'Bank transfer with a QR code, your payment link, or Mollie',
      'Who has paid, at a glance',
      'Waive a payment when life happens',
      'Income reports, studio classes included',
    ],
  },
];

/** The homepage's "what it does" band: four cards, then one quiet line. */
export function FeatureBand() {
  return (
    <section id="features" aria-labelledby="features-heading" className="border-t border-border">
      <div className={`${COLUMN} pt-16 sm:pt-24 pb-16 sm:pb-24 flex flex-col gap-10`}>
        <div className="max-w-[680px] flex flex-col gap-5">
          <p className="text-sm font-medium text-brown">What it does</p>
          <h2 id="features-heading" className="font-heading font-bold text-[28px] leading-[1.25] text-teal">
            Everything a class needs, nothing it doesn’t
          </h2>
          <p className="type-body text-lg leading-[1.6]">
            Pricing, scheduling, bookings and payments in one calm place, built for teachers who run their own
            classes.
          </p>
        </div>
        <div className="grid sm:grid-cols-2 gap-4">
          {CARDS.map((card) => (
            <article
              key={card.label}
              className="bg-sand-soft border border-border rounded-card p-6 flex flex-col gap-4"
            >
              <p className="text-[13px] font-medium text-brown">{card.label}</p>
              <h3 className="type-subtitle text-teal">{card.promise}</h3>
              <ul className="flex flex-col gap-3">
                {card.items.map((item, i) => (
                  <li key={i} className="flex gap-3 items-start">
                    <Icon name="check" size={20} className="text-teal shrink-0 mt-0.5" />
                    <span className="type-body">{item}</span>
                  </li>
                ))}
              </ul>
              {card.extra}
            </article>
          ))}
        </div>
        <p className="text-sm text-brown text-center">
          Works as an app on your phone · No passwords · No commission, ever
        </p>
      </div>
    </section>
  );
}
