import type { Metadata } from 'next';

const FALLBACK_URL = 'http://localhost:3000';

/**
 * The site's own origin, from `NEXT_PUBLIC_APP_URL`: what canonical and
 * Open Graph URLs resolve against. A value that does not parse falls back to
 * localhost instead of throwing, because the root layout reads this for every
 * page.
 */
export function siteUrl(): URL {
  try {
    return new URL(process.env.NEXT_PUBLIC_APP_URL || FALLBACK_URL);
  } catch {
    return new URL(FALLBACK_URL);
  }
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
