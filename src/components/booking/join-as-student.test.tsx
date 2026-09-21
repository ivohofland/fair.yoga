import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { routerRefresh } from '../../../tests/setup/components';
import { JoinAsStudent } from './join-as-student';

describe('JoinAsStudent', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function join(): void {
    render(<JoinAsStudent firstName="Anna" />);
    fireEvent.click(screen.getByRole('button', { name: 'Join as a student' }));
  }

  it('adds the student side, then refreshes into the booking flow', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 201, json: async () => ({ data: { studentId: 's-1' } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    join();

    await vi.waitFor(() => expect(routerRefresh).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith('/api/account/student-profile', { method: 'POST' });
  });

  it('treats a student side that already exists as done', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { studentId: 's-1' }, outcome: 'unchanged' }),
    }));
    join();

    await vi.waitFor(() => expect(routerRefresh).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not claim success for a 409', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        error: { code: 'UNIQUE_CONFLICT', message: 'That already exists. Refresh to see the latest.' },
      }),
    }));
    join();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That already exists. Refresh to see the latest.',
    );
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it('falls back to its own message when the server sends none', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }));
    join();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not set up your student side. Try again.',
    );
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it('reports a thrown fetch', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    join();

    expect(await screen.findByRole('alert')).toHaveTextContent('Network error. Try again.');
  });
});
