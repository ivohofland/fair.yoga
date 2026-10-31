import type { MetadataRoute } from 'next';
import { siteUrl } from '@/lib/seo';

// No Disallow lines: this file is public, and one would advertise the path it
// names. A page that must stay out of search says noindex itself (`NOINDEX`).
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', allow: '/' },
    sitemap: new URL('/sitemap.xml', siteUrl()).href,
  };
}
