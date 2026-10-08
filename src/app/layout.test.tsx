import { describe, it, expect, vi } from 'vitest';
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
