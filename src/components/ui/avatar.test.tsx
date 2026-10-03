import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Avatar, AvatarSkeleton, initialsOf } from './avatar';

describe('initialsOf', () => {
  it('takes the first character of each name, uppercased', () => {
    expect(initialsOf('ivo', 'hofland')).toBe('IH');
    expect(initialsOf('élise', 'ødegaard')).toBe('ÉØ');
  });
  it('keeps an astral first character whole', () => {
    expect(initialsOf('𠮷野', 'Tanaka')).toBe('𠮷T');
  });
});

describe('Avatar', () => {
  it('renders initials, hidden from assistive tech, when there is no photo', () => {
    const { container } = render(<Avatar firstName="Visual" lastName="Teacher" photoId={null} size={72} />);
    const el = container.firstElementChild;
    expect(el?.textContent).toBe('VT');
    expect(el?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('img')).toBeNull();
  });
  it('renders the photo at its size with an empty alt', () => {
    const { container } = render(<Avatar firstName="Visual" lastName="Teacher" photoId="abc" size={40} />);
    const img = container.querySelector('img');
    expect(img?.getAttribute('src')).toBe('/api/teacher-photos/abc');
    expect(img?.getAttribute('alt')).toBe('');
    expect(img?.getAttribute('width')).toBe('40');
  });
});

describe('AvatarSkeleton', () => {
  it('renders a hidden placeholder frame sized like the real avatar', () => {
    const { container } = render(<AvatarSkeleton size={40} />);
    const el = container.firstElementChild;
    expect(el?.getAttribute('aria-hidden')).toBe('true');
    expect(el?.classList.contains('rounded-pill')).toBe(true);
    expect(el?.classList.contains('shrink-0')).toBe(true);
    expect(el?.classList.contains('bg-sand-soft')).toBe(true);
    expect((el as HTMLElement)?.style.width).toBe('40px');
    expect((el as HTMLElement)?.style.height).toBe('40px');
  });
});
