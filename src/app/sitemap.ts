import type { MetadataRoute } from 'next';
import { siteUrl } from '@/lib/seo';

// Rendered per request: `next build` never sees NEXT_PUBLIC_APP_URL, so a
// prerendered file would carry the localhost fallback.
export const dynamic = 'force-dynamic';

// The platform's own pages; never a teacher's. Policy:
// docs/technical-architecture.md (Search engines).
export default function sitemap(): MetadataRoute.Sitemap {
  return [{ url: new URL('/', siteUrl()).href, changeFrequency: 'monthly' }];
}
