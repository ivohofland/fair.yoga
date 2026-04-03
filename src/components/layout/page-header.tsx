import Link from 'next/link';

interface PageHeaderProps {
  title: string;
  backHref?: string;
}

export function PageHeader({ title, backHref = '/schedule' }: PageHeaderProps) {
  return (
    <div className="mb-6">
      <Link href={backHref} className="text-teal text-sm mb-2 inline-block">
        &larr; Back
      </Link>
      <h1 className="font-heading text-2xl font-bold text-dark">{title}</h1>
    </div>
  );
}
