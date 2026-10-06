import { isValidElement, type ReactElement, type ReactNode } from 'react';

/**
 * Every element in a server component's returned tree, reached through any
 * prop, not only `children` — so an element passed as a slot (`action`,
 * `after`) is found without rendering the tree.
 */
export function* elementsOf(node: ReactNode): Generator<ReactElement> {
  if (Array.isArray(node)) {
    for (const child of node) yield* elementsOf(child);
    return;
  }
  if (!isValidElement(node)) return;
  yield node;
  const props: unknown = node.props;
  if (typeof props !== 'object' || props === null) return;
  for (const value of Object.values(props)) {
    if (Array.isArray(value) || isValidElement(value)) yield* elementsOf(value);
  }
}
