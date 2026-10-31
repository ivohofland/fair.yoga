import type { Metadata } from 'next';
import { NOINDEX } from '@/lib/seo';

// The page is a client component, which cannot export metadata; its URL
// carries a sign-in token.
export const metadata: Metadata = NOINDEX;

export default function VerifyLayout({ children }: { children: React.ReactNode }) {
  return children;
}
