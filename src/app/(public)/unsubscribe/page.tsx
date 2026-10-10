import { UnsubscribeForm } from './unsubscribe-form';

/**
 * Where an email's unsubscribe link lands. Public and the same for everyone:
 * the page names no one, and the token stays in the fragment until the
 * button sends it.
 */
export default function UnsubscribePage() {
  return (
    <div className="flex-1 flex flex-col py-10">
      <h1 className="type-display mb-5">Unsubscribe</h1>
      <UnsubscribeForm />
    </div>
  );
}
