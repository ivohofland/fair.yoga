import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CompleteClassButton } from './complete-class-button';
import { routerRefresh } from '../../../tests/setup/components';

/**
 * Same defect as `PublishClassButton` (#166 re-review M5), with more behind
 * it: completing runs the pricing engine, writes the payment rows and
 * notifies everyone registered. A silent failure leaves the teacher looking
 * at an unchanged page with no idea whether any of that happened, and the
 * obvious response — click again — is the one thing they should not do while
 * uncertain.
 */
describe('CompleteClassButton', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('posts the completion once confirmed and refreshes on success', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    render(<CompleteClassButton classId="c-9" chargedCount={2} />);

    fireEvent.click(screen.getByRole('button', { name: 'Finish class' }));
    fireEvent.click(screen.getByRole('button', { name: 'Finish' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/classes/c-9/complete', { method: 'POST' }),
    );
    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
  });

  it('asks before finishing, and posts nothing until confirmed', () => {
    vi.stubGlobal('fetch', fetchMock);
    render(<CompleteClassButton classId="c-9" chargedCount={2} />);

    fireEvent.click(screen.getByRole('button', { name: 'Finish class' }));

    screen.getByText('Finish class? Payment requests go to 2 students now.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the class open when the teacher backs out', () => {
    vi.stubGlobal('fetch', fetchMock);
    render(<CompleteClassButton classId="c-9" chargedCount={2} />);

    fireEvent.click(screen.getByRole('button', { name: 'Finish class' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep open' }));

    expect(fetchMock).not.toHaveBeenCalled();
    screen.getByRole('button', { name: 'Finish class' });
  });

  /**
   * The POST cannot be recalled once sent, so "Keep open" must not offer to
   * while it is in flight.
   */
  it('disables Keep open while the finish is in flight', async () => {
    let answer: (value: { ok: boolean }) => void = () => {};
    fetchMock.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    vi.stubGlobal('fetch', fetchMock);
    render(<CompleteClassButton classId="c-9" chargedCount={2} />);

    fireEvent.click(screen.getByRole('button', { name: 'Finish class' }));
    expect(screen.getByRole('button', { name: 'Keep open' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Finish' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Keep open' })).toBeDisabled());

    answer({ ok: true });
    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
  });

  it('says one student, not one students', () => {
    vi.stubGlobal('fetch', fetchMock);
    render(<CompleteClassButton classId="c-9" chargedCount={1} />);
    fireEvent.click(screen.getByRole('button', { name: 'Finish class' }));
    screen.getByText('Finish class? A payment request goes to 1 student now.');
  });

  // Review Focus 4.
  it('does not promise payment requests when nobody is charged', () => {
    vi.stubGlobal('fetch', fetchMock);
    render(<CompleteClassButton classId="c-9" chargedCount={0} />);
    fireEvent.click(screen.getByRole('button', { name: 'Finish class' }));
    screen.getByText('Finish class? No one is charged for this class.');
  });

  it('treats an unchanged answer as success: the class was already completed', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { ok: true, newStatus: 'completed' }, outcome: 'unchanged' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<CompleteClassButton classId="c-9" chargedCount={2} />);

    fireEvent.click(screen.getByRole('button', { name: 'Finish class' }));
    fireEvent.click(screen.getByRole('button', { name: 'Finish' }));

    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the server message when completion is refused', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        error: { code: 'CLASS_CANCELLED', message: 'This class has been cancelled.' },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<CompleteClassButton classId="c-9" chargedCount={2} />);

    fireEvent.click(screen.getByRole('button', { name: 'Finish class' }));
    fireEvent.click(screen.getByRole('button', { name: 'Finish' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('This class has been cancelled.');
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it('says something when the request never reaches the server', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);
    render(<CompleteClassButton classId="c-9" chargedCount={2} />);

    fireEvent.click(screen.getByRole('button', { name: 'Finish class' }));
    fireEvent.click(screen.getByRole('button', { name: 'Finish' }));

    expect(await screen.findByText('Network error. Please try again.')).toBeInTheDocument();
  });
});
