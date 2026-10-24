import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ShareBookingLink } from './share-booking-link';

const PATH = '/anna/book/c1';
const URL_ = `${window.location.origin}${PATH}`;

function setNavigator(key: 'share' | 'clipboard', value: unknown): void {
  Object.defineProperty(navigator, key, { value, configurable: true, writable: true });
}

describe('ShareBookingLink', () => {
  const original = {
    share: Object.getOwnPropertyDescriptor(navigator, 'share'),
    clipboard: Object.getOwnPropertyDescriptor(navigator, 'clipboard'),
  };

  afterEach(() => {
    for (const key of ['share', 'clipboard'] as const) {
      const d = original[key];
      if (d) Object.defineProperty(navigator, key, d);
      else Reflect.deleteProperty(navigator, key);
    }
  });

  it('hands the native share sheet the title and the full URL', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    setNavigator('share', share);
    render(<ShareBookingLink path={PATH} title="Book Vinyasa" />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(share).toHaveBeenCalledWith({ title: 'Book Vinyasa', url: URL_ }));
  });

  it('copies the URL and says so when there is no share sheet', async () => {
    setNavigator('share', undefined);
    const writeText = vi.fn().mockResolvedValue(undefined);
    setNavigator('clipboard', { writeText });
    render(<ShareBookingLink path={PATH} title="Book Vinyasa" />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(URL_));
    expect(await screen.findByText('Link copied')).toBeTruthy();
  });

  it('shows the URL for copying by hand when the clipboard refuses', async () => {
    setNavigator('share', undefined);
    setNavigator('clipboard', { writeText: vi.fn().mockRejectedValue(new Error('blocked')) });
    render(<ShareBookingLink path={PATH} title="Book Vinyasa" />);
    fireEvent.click(screen.getByRole('button'));
    expect(await screen.findByText(`Copy it yourself: ${URL_}`)).toBeTruthy();
  });
});
