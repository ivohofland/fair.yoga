import Link from 'next/link';
import { siteUrl } from '@/lib/seo';
import { KICKER } from './band';

/**
 * The trail from home to a marketing subpage, shown to visitors and, as a
 * schema.org BreadcrumbList, to search engines: both from these props.
 */
export function Breadcrumb({ current, path }: { current: string; path: string }) {
  const data = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'fair.yoga', item: new URL('/', siteUrl()).href },
      { '@type': 'ListItem', position: 2, name: current, item: new URL(path, siteUrl()).href },
    ],
  };
  return (
    <>
      {/* A data block, not a script: the browser never runs it, so the CSP's nonce has no say. */}
      <script
        type="application/ld+json"
        // `<` escaped so no name can close the script element.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, '\\u003c') }}
      />
      <nav aria-label="Breadcrumb" className={KICKER}>
        <Link href="/">fair.yoga</Link> / <span aria-current="page">{current}</span>
      </nav>
    </>
  );
}
