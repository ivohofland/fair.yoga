import { describe, it, expect } from 'vitest';
import { isValidElement, Children, type ReactNode } from 'react';
import RootLayout from './layout';
import { InstallListener } from '@/components/layout/install-listener';

/** Walks an element tree looking for one whose `type` is `target`, the same
 *  test React itself uses to tell components apart. */
function treeContainsType(node: ReactNode, target: unknown): boolean {
  if (!isValidElement(node)) return false;
  if (node.type === target) return true;
  const { children } = node.props as { children?: ReactNode };
  return Children.toArray(children).some((child) => treeContainsType(child, target));
}

describe('RootLayout', () => {
  it('mounts InstallListener', () => {
    const tree = RootLayout({ children: <div>content</div> });
    expect(treeContainsType(tree, InstallListener)).toBe(true);
  });
});
