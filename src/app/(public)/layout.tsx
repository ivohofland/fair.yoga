import { Wordmark } from '@/components/layout/wordmark';

export default function PublicLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col flex-1">
      <Wordmark className="mb-14" />
      {children}
    </div>
  );
}
