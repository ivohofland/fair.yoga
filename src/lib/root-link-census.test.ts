import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `/` is the public homepage for everyone, signed in or not, so a link there
 * leaves the app. The way back to the schedule is `/schedule`, and the way into
 * the app is `/start`. A file joins this list only when leaving for the homepage
 * is what its link is for.
 */
const LEADS_TO_THE_HOMEPAGE_ON_PURPOSE = [
  'src/app/(public)/[slug]/layout.tsx',
  'src/app/not-found.tsx',
  'src/components/landing/breadcrumb.tsx',
  'src/components/landing/site-header.tsx',
];

const ROOT_NAVIGATION = /(?:\b(?:backHref|href)=\{?\s*|\bhref:\s*|\brouter\.(?:push|replace)\(\s*|\b(?:permanentRedirect|redirect)\(\s*)['"`]\/['"`]/;

function sourcesUnderSrc(): string[] {
  return readdirSync(path.join(process.cwd(), 'src'), { recursive: true, encoding: 'utf8' })
    .map((p) => `src/${p.split(path.sep).join('/')}`)
    .filter((p) => /\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p) && !p.startsWith('src/generated/'))
    .sort();
}

describe('links to the homepage', () => {
  it('exist only where leaving the app is the point', () => {
    const linking = sourcesUnderSrc().filter((p) => ROOT_NAVIGATION.test(readFileSync(path.join(process.cwd(), p), 'utf8')));

    expect(linking).toEqual(LEADS_TO_THE_HOMEPAGE_ON_PURPOSE);
  });
});
