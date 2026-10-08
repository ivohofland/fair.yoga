import { PayoutPauseForm } from './payout-pause-form';

/**
 * Where a payout-change email's "This wasn't me" button lands. Public and
 * the same for everyone: the page names no teacher, and the token stays in
 * the fragment until the button sends it.
 */
export default function PayoutPausePage() {
  return (
    <div className="flex-1 flex flex-col py-10">
      <h1 className="type-display mb-5">Didn&rsquo;t change your payment details?</h1>
      <p className="type-body mb-4">
        If you didn&rsquo;t change where your students pay, pause payments now. Pausing:
      </p>
      <ul className="type-body list-disc pl-5 mb-6 flex flex-col gap-1">
        <li>signs you out on every device,</li>
        <li>removes passkeys added recently,</li>
        <li>asks your students to hold off paying until you&rsquo;ve checked your details.</li>
      </ul>
      <p className="type-body mb-8">
        You can resume payments once you&rsquo;ve signed in and checked your payment details.
      </p>
      <PayoutPauseForm />
    </div>
  );
}
