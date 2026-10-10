import { ContentColumn } from '@/components/layout/content-column';

export default function AdminGroupLayout({ children }: { children: React.ReactNode }) {
  return <ContentColumn>{children}</ContentColumn>;
}
