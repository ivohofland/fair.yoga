import type { Metadata } from 'next';
import { NOINDEX } from '@/lib/seo';
import { ContentColumn } from '@/components/layout/content-column';

export const metadata: Metadata = NOINDEX;

export default function AdminGroupLayout({ children }: { children: React.ReactNode }) {
  return <ContentColumn>{children}</ContentColumn>;
}
