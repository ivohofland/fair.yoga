import type { Metadata } from 'next';
import { log } from '@/lib/log';

const FALLBACK_URL = 'http://localhost:3000';

/**
 * The site's own origin, from `NEXT_PUBLIC_APP_URL`. A value that is not an
 * http(s) URL falls back to localhost instead of throwing: callers read it
 * while rendering, and a throw would fail the page rather than one URL in it.
 * The fallback is logged wherever it means a broken deploy: a bad value
 * anywhere, a missing one on a running production server. `next build` never
 * sees the variable (DEPLOYMENT.md), so a missing one there is expected.
 */
export function siteUrl(): URL {
  const raw = process.env.NEXT_PUBLIC_APP_URL;
  if (!raw) {
    if (process.env.NODE_ENV === 'production' && process.env.NEXT_PHASE !== 'phase-production-build') {
      log.error('NEXT_PUBLIC_APP_URL is unset; canonical, Open Graph and sitemap URLs point at localhost');
    }
    return new URL(FALLBACK_URL);
  }
  const url = URL.canParse(raw) ? new URL(raw) : null;
  if (url?.protocol === 'http:' || url?.protocol === 'https:') return url;
  log.error({ raw }, 'NEXT_PUBLIC_APP_URL is not an http(s) URL; canonical, Open Graph and sitemap URLs point at localhost');
  return new URL(FALLBACK_URL);
}

/** A page that keeps itself out of search indexes. */
export const NOINDEX = { robots: { index: false } } as const satisfies Metadata;

/** `text` on one line, cut at a word boundary to at most `max` characters for a meta description. */
export function snippet(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const room = flat.slice(0, max - 1);
  const lastSpace = room.lastIndexOf(' ');
  return `${lastSpace > 0 ? room.slice(0, lastSpace) : room}…`;
}
