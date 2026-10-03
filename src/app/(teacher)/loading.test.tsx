import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import TeacherLoading from './loading';

// The neutral fallback for every teacher route without a loading.tsx of its
// own: a header placeholder and nothing else. It never grows a body
// skeleton of its own — a route that needs one gets its own loading.tsx —
// so this pins the fallback at exactly a header, with no first-item anchor
// and no other child.
describe('TeacherLoading', () => {
  it('renders aria-busy, one header anchor, no first-item anchor, and nothing else', () => {
    const { container } = render(<TeacherLoading />);
    const root = container.firstElementChild;
    expect(root?.getAttribute('aria-busy')).toBe('true');
    expect(container.querySelectorAll('[data-layout-anchor="header"]').length).toBe(1);
    expect(container.querySelectorAll('[data-layout-anchor="first-item"]').length).toBe(0);
    expect(root?.children.length).toBe(1);
  });
});
