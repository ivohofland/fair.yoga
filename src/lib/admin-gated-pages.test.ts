import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const GATED_TREE = path.resolve(__dirname, '../app/(admin)/admin/(gated)');

function pagesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return pagesUnder(full);
    return entry.name === 'page.tsx' ? [full] : [];
  });
}

describe('the gated admin tree', () => {
  const pages = pagesUnder(GATED_TREE);

  it('holds at least one page', () => {
    expect(pages.length).toBeGreaterThan(0);
  });

  it.each(pages.map((p) => [path.relative(GATED_TREE, p), p] as const))(
    '%s calls requireAdminSession itself',
    (_name, file) => {
      expect(readFileSync(file, 'utf8')).toContain('requireAdminSession(');
    },
  );
});
