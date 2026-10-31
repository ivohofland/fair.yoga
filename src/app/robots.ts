import type { MetadataRoute } from 'next';
import { siteUrl } from '@/lib/seo';

// Rendered per request: `next build` never sees NEXT_PUBLIC_APP_URL, so a
// prerendered file would carry the localhost fallback.
export const dynamic = 'force-dynamic';

// No Disallow lines: this file is public, and one would advertise the path it
// names. Policy: docs/technical-architecture.md (Search engines).
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', allow: '/' },
    sitemap: new URL('/sitemap.xml', siteUrl()).href,
  };
}
