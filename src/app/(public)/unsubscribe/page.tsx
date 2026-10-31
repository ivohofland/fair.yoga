import type { Metadata } from 'next';
import { NOINDEX } from '@/lib/seo';
import { UnsubscribeForm } from './unsubscribe-form';

export const metadata: Metadata = NOINDEX;

/** Where an email's unsubscribe link lands. Public and the same for everyone. */
export default function UnsubscribePage() {
  return (
    <div className="flex-1 flex flex-col py-10">
      <h1 className="type-display mb-5">Unsubscribe</h1>
      <UnsubscribeForm />
    </div>
  );
}
