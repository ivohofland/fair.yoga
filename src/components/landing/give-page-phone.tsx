import { Icon } from '@/components/ui/icon';
import { MethodChooser } from '@/components/student/method-chooser';
import type { GiftMethod } from '@/components/student/method-panel';
import { GIVE_PAGE_BACK, GIVE_PAGE_HEADING, giveCaption } from '@/lib/give-page-copy';

const SAMPLE_METHODS: GiftMethod[] = [
  {
    kind: 'bank_transfer',
    beneficiary: 'Anna Smith',
    details: { scheme: 'sepa', iban: 'NL91ABNA0417164300', bic: null },
  },
  { kind: 'epc_qr', beneficiary: 'Anna Smith', iban: 'NL91ABNA0417164300', bic: null, currency: 'EUR' },
  { kind: 'payment_link', url: 'https://example.com/anna', host: 'example.com' },
];

const CAPTION = giveCaption(
  { classType: 'Slow flow', date: new Date('2026-11-03T00:00:00Z') },
  { firstName: 'Anna', lastName: 'Smith' },
);

/** An illustration of the student's give page, built from the page's own words and chooser. */
export function GivePagePhone() {
  return (
    <div
      role="img"
      aria-label="The page a student sees after a donation class: a thank-you, then ways to give with no amount shown. An illustration of the give page."
      className="w-full max-w-[340px] mx-auto bg-cream border border-border rounded-[28px] p-5"
    >
      <div inert aria-hidden="true">
        <span className="inline-flex items-center gap-1.5 type-label text-teal mb-2">
          <Icon name="arrow-left" size={18} />
          {GIVE_PAGE_BACK}
        </span>
        <p className="type-title">{GIVE_PAGE_HEADING}</p>
        <p className="type-caption mb-4">{CAPTION}</p>
        <MethodChooser
          name="give-illustration"
          methods={SAMPLE_METHODS}
          amount={{ kind: 'open' }}
          currency="EUR"
          reference="Slow flow"
        />
      </div>
    </div>
  );
}
