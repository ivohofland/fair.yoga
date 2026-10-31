import type { MetadataRoute } from 'next';
import { siteUrl } from '@/lib/seo';

// The platform's own pages. A teacher's page is never listed: it is found
// when the teacher shares it, not because fair.yoga promoted it.
export default function sitemap(): MetadataRoute.Sitemap {
  return [{ url: new URL('/', siteUrl()).href, changeFrequency: 'monthly' }];
}
