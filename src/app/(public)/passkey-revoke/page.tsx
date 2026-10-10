import { PasskeyRevokeForm } from './passkey-revoke-form';

/**
 * Where a passkey-added email's "This wasn't me" button lands. Public and the
 * same for everyone: the page names no account, and the token stays in the
 * fragment until the button sends it.
 */
export default function PasskeyRevokePage() {
  return (
    <div className="flex-1 flex flex-col py-10">
      <h1 className="type-display mb-5">Didn&rsquo;t add a passkey?</h1>
      <p className="type-body mb-4">If you didn&rsquo;t add it, this:</p>
      <ul className="type-body list-disc pl-5 mb-6 flex flex-col gap-1">
        <li>signs you out on every device,</li>
        <li>cancels any sign-in links already sent,</li>
        <li>removes the passkey that was added, where it can.</li>
      </ul>
      <p className="type-body mb-8">You can sign in again afterwards with a new link.</p>
      <PasskeyRevokeForm />
    </div>
  );
}
