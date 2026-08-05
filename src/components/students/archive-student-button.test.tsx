import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ArchiveStudentButton } from './archive-student-button';
import { routerPush } from '../../../tests/setup/components';

/**
 * This button renders no confirmation on success, only a `router.push` — but
 * that push target is derived inline, the same wiring class as the `?state=`
 * derivation the toggle buttons need this layer for. Nothing asserted it until
 * this file: a button that fired the correct PATCH and then navigated to the
 * wrong page passed the whole suite (#99).
 */
describe('ArchiveStudentButton', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  function stubOk(): void {
    fetchMock.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
  }

  it('sends state=archived when the student is not archived', async () => {
    stubOk();
    render(<ArchiveStudentButton studentId="st-1" isArchived={false} />);

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/students/st-1?state=archived', {
        method: 'PATCH',
      }),
    );
    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/students'));
  });

  it('sends state=unarchived when the student is archived', async () => {
    stubOk();
    render(<ArchiveStudentButton studentId="st-1" isArchived={true} />);

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/students/st-1?state=unarchived', {
        method: 'PATCH',
      }),
    );
  });

  /**
   * #166 review F5. The success path navigates away, so silence on failure is
   * indistinguishable from a click that never registered: the PATCH 4xx'd, the
   * button re-enabled, the page did not change, and nothing said why. These
   * three are the tests that fail if the `else`/`catch` is removed again — the
   * two above pass either way.
   */
  it('shows the server message when the PATCH fails', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: { message: 'This student has an unpaid class.' } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<ArchiveStudentButton studentId="st-1" isArchived={false} />);

    fireEvent.click(screen.getByRole('button'));

    expect(await screen.findByText('This student has an unpaid class.')).toBeInTheDocument();
    expect(routerPush).not.toHaveBeenCalled();
  });

  it('falls back to copy naming the direction when the server sends no message', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
    render(<ArchiveStudentButton studentId="st-1" isArchived={true} />);

    fireEvent.click(screen.getByRole('button'));

    expect(
      await screen.findByText('Could not unarchive this student. Try again.'),
    ).toBeInTheDocument();
  });

  it('reports a thrown fetch instead of swallowing it', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);
    render(<ArchiveStudentButton studentId="st-1" isArchived={false} />);

    fireEvent.click(screen.getByRole('button'));

    expect(await screen.findByText('Network error. Try again.')).toBeInTheDocument();
    // Re-enabled, not stuck mid-flight: `finally` still has to run on the
    // throw path.
    await waitFor(() => expect(screen.getByRole('button')).not.toBeDisabled());
  });
});
