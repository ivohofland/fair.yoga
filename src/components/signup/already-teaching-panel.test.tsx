import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AlreadyTeachingPanel } from './already-teaching-panel';
import { routerPush } from '../../../tests/setup/components';

describe('AlreadyTeachingPanel', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('names the address the browser is signed in as, and why that settles it', () => {
    render(<AlreadyTeachingPanel email="ivo@example.com" />);

    expect(screen.getByText('ivo@example.com')).toBeInTheDocument();
    expect(screen.getByText(/already has a teacher page/)).toBeInTheDocument();
  });

  it('offers the schedule as the way on', () => {
    render(<AlreadyTeachingPanel email="ivo@example.com" />);

    expect(screen.getByRole('link', { name: /Go to your schedule/ })).toHaveAttribute(
      'href',
      '/schedule',
    );
  });

  it('signs out back to /signup, the page the reader was trying to use', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    render(<AlreadyTeachingPanel email="ivo@example.com" />);

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/signup'));
    expect(routerPush).not.toHaveBeenCalledWith('/login');
  });
});
