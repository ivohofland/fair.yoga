import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CancelClassButton } from './cancel-class-button';
import { routerRefresh } from '../../../tests/setup/components';

/**
 * The REGULAR family's cancel button, which had no test file at all.
 *
 * WHAT THAT COST. #327 changed this component's wire call three ways in one
 * edit — `…/transition` became `…/cancel`, the `Content-Type` header went, and
 * the JSON body `{ status: 'cancelled' }` went with it, because `cancelled`
 * stopped being a `ClassStatus` and there is no target status left to name.
 * Nothing on the caller side observed any of it: no unit test, and neither of
 * the two e2e `Cancel class` clicks is this button — both are the STUDIO twin
 * (`tests/e2e/studio.spec.ts`). Its studio twin
 * (`cancel-studio-class-button.test.tsx`) asserts its own URL and method
 * exactly; this brings the pair level.
 *
 * The URL and the method are asserted as VALUES, not as "a fetch happened":
 * pointing this at the old endpoint again would leave a `toHaveBeenCalled`
 * assertion perfectly green while every cancellation 400d.
 *
 * The error branch is the same defect the studio file names (#166 re-review
 * M5): the confirm step makes silence worse rather than safer, because the
 * teacher has already answered "yes, cancel this", so an unchanged page reads
 * as the cancellation having gone through.
 */
describe('CancelClassButton', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  // Two buttons named `Cancel class`: the trigger, and the destructive confirm
  // that replaces it. `getAllByRole` then `[1]` would pick the wrong one before
  // the click — the trigger unmounts, so after it there is exactly one again.
  const confirm = () => {
    fireEvent.click(screen.getByRole('button', { name: 'Cancel class' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel class' }));
  };

  it('posts to the cancel door with no body, and refreshes on success', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    render(<CancelClassButton classId="c-7" registrationCount={0} />);

    confirm();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/classes/c-7/cancel');
    expect(init.method).toBe('POST');
    // The URL is the whole request since #327. A body here would be naming a
    // status the enum no longer has, and `transitionClassSchema` is not what
    // reads this endpoint any more.
    expect(init.body).toBeUndefined();
    expect(init.headers).toBeUndefined();
    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
  });

  it('shows the server message when the cancellation is refused', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: { message: 'That class can no longer be changed' } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<CancelClassButton classId="c-7" registrationCount={0} />);

    confirm();

    expect(await screen.findByText('That class can no longer be changed')).toBeInTheDocument();
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  // `respondError` sends `{ error: '…' }` from some doors and
  // `{ error: { message: '…' } }` from others, and this component reads both
  // by hand rather than through `readErrorMessage`. Both shapes, so a
  // simplification to one of them cannot pass quietly.
  it('reads a bare string error as well as a nested one', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: 'Class not found' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<CancelClassButton classId="c-7" registrationCount={0} />);

    confirm();

    expect(await screen.findByText('Class not found')).toBeInTheDocument();
  });

  it('says something when the request never reaches the server', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);
    render(<CancelClassButton classId="c-7" registrationCount={0} />);

    confirm();

    expect(await screen.findByText('Network error. Try again.')).toBeInTheDocument();
  });

  // The confirm copy the teacher reads before answering, and the only thing
  // `registrationCount` is for. Singular and plural, because the component
  // branches on it.
  it('names how many students will be notified', async () => {
    render(<CancelClassButton classId="c-7" registrationCount={1} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel class' }));
    expect(screen.getByText(/1 registered student will be notified\./)).toBeInTheDocument();
  });

  it('pluralises that count, and says nothing at zero', async () => {
    const { rerender } = render(<CancelClassButton classId="c-7" registrationCount={3} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel class' }));
    expect(screen.getByText(/3 registered students will be notified\./)).toBeInTheDocument();

    rerender(<CancelClassButton classId="c-8" registrationCount={0} />);
    expect(screen.queryByText(/will be notified/)).not.toBeInTheDocument();
  });
});
