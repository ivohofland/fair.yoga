import type { Metadata } from 'next';
import { NOINDEX } from '@/lib/seo';

// Holds /verify's metadata, since its page is a client component; its URL
// carries a sign-in token.
export const metadata: Metadata = NOINDEX;

export default function VerifyLayout({ children }: { children: React.ReactNode }) {
  return children;
}
