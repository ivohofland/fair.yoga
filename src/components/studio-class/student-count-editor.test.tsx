import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { StudentCountEditor } from './student-count-editor';
import { routerRefresh } from '../../../tests/setup/components';

/**
 * The worst of the four in #166 re-review M5, and the reason is the "Saved"
 * marker. Every other silent failure on this branch leaves an unchanged
 * page; this one leaves the typed number sitting in the field with no
 * "Saved" beside it — which is exactly what an unclicked Save looks like. A
 * teacher who glances at it later reads "I never saved that" and retypes,
 * or reads it as saved because the number is right there.
 */
describe('StudentCountEditor', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  const type = (value: string) =>
    fireEvent.change(screen.getByLabelText('Student count'), { target: { value } });

  it('saves the typed count and confirms it', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    render(<StudentCountEditor studioClassId="sc-1" initialCount={null} />);

    type('12');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/studio-classes/sc-1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentCount: 12 }),
      }),
    );
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  it('shows the server message instead of "Saved" when the save is refused', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'Student count cannot be negative.' } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<StudentCountEditor studioClassId="sc-1" initialCount={null} />);

    type('-4');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Student count cannot be negative.')).toBeInTheDocument();
    // The distinction the whole fix turns on: a failed save must not leave
    // the screen in the shape a successful one has.
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it('says something when the request never reaches the server', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);
    render(<StudentCountEditor studioClassId="sc-1" initialCount={4} />);

    type('5');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Network error. Please try again.')).toBeInTheDocument();
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });

  it('clears a stale error when the teacher edits the field again', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
    render(<StudentCountEditor studioClassId="sc-1" initialCount={null} />);

    type('7');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Could not save. Please try again.')).toBeInTheDocument();

    // The existing `onChange` already clears "Saved" for the same reason: a
    // marker left over from the previous value describes the wrong number.
    type('8');
    expect(screen.queryByText('Could not save. Please try again.')).not.toBeInTheDocument();
  });
});
