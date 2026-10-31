import { describe, it, expect, vi, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { isValidElement, Children, type ReactNode } from 'react';
import RootLayout from './layout';
import { InstallListener } from '@/components/layout/install-listener';

vi.mock('next/server', () => ({ connection: vi.fn(async () => undefined) }));
const { connection } = await import('next/server');

/** Walks an element tree looking for one whose `type` is `target`, the same
 *  test React itself uses to tell components apart. */
function treeContainsType(node: ReactNode, target: unknown): boolean {
  if (!isValidElement(node)) return false;
  if (node.type === target) return true;
  const { children } = node.props as { children?: ReactNode };
  return Children.toArray(children).some((child) => treeContainsType(child, target));
}

describe('RootLayout', () => {
  it('mounts InstallListener', async () => {
    const tree = await RootLayout({ children: <div>content</div> });
    expect(treeContainsType(tree, InstallListener)).toBe(true);
  });

  it('opts every page into a request-time render', async () => {
    await RootLayout({ children: <div /> });
    expect(connection).toHaveBeenCalled();
  });
});

describe('RootLayout metadata', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  // Pages give relative canonical and og:url values; this is what makes them absolute.
  it('resolves every page URL against NEXT_PUBLIC_APP_URL', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://fair.yoga');
    vi.resetModules();
    const { metadata } = await import('./layout');
    expect(String(metadata.metadataBase)).toBe('https://fair.yoga/');
  });

  it('suffixes a page’s own title with the site name', async () => {
    const { metadata } = await import('./layout');
    expect(metadata.title).toEqual({ default: 'fair.yoga', template: '%s · fair.yoga' });
  });

  // The template adds the site name, so a title that spells it out reads it twice.
  it('no page spells the site name in its own title', () => {
    const app = path.resolve(__dirname);
    const sources = (readdirSync(app, { recursive: true, encoding: 'utf8' }))
      .filter((file) => /\.tsx?$/.test(file) && !file.includes('.test.') && file !== 'layout.tsx');
    const offenders = sources.filter((file) =>
      /title:\s*['"`][^'"`]*fair\.yoga/.test(readFileSync(path.join(app, file), 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
