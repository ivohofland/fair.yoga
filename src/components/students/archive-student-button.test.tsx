import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ArchiveStudentButton } from './archive-student-button';
import { routerPush, routerRefresh } from '../../../tests/setup/components';

const noneOutstanding = { ids: [], total: 0 };

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

  it('sends state=archived with no body when nothing is outstanding', async () => {
    stubOk();
    render(
      <ArchiveStudentButton
        studentId="st-1"
        studentName="Dana"
        isArchived={false}
        outstanding={noneOutstanding}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Archive student' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/students/st-1?state=archived', {
        method: 'PATCH',
      }),
    );
    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/students'));
  });

  it('sends state=unarchived when the student is archived', async () => {
    stubOk();
    render(
      <ArchiveStudentButton
        studentId="st-1"
        studentName="Dana"
        isArchived={true}
        outstanding={noneOutstanding}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Unarchive student' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/students/st-1?state=unarchived', {
        method: 'PATCH',
      }),
    );
    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/students'));
  });

  describe('something outstanding', () => {
    const outstanding = { ids: ['p1', 'p2'], total: 45 };

    it('opens an inline confirm naming the total and count, sending no request yet', () => {
      render(
        <ArchiveStudentButton
          studentId="st-1"
          studentName="Dana"
          isArchived={false}
          outstanding={outstanding}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: 'Archive student' }));

      expect(
        screen.getByText('Dana still owes €45.00 across 2 payments. Archiving waives them.'),
      ).toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('moves focus to Waive and archive when the confirm opens', () => {
      render(
        <ArchiveStudentButton
          studentId="st-1"
          studentName="Dana"
          isArchived={false}
          outstanding={outstanding}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: 'Archive student' }));

      expect(screen.getByRole('button', { name: 'Waive and archive' })).toHaveFocus();
    });

    it('names a single payment in the singular', () => {
      render(
        <ArchiveStudentButton
          studentId="st-1"
          studentName="Dana"
          isArchived={false}
          outstanding={{ ids: ['p1'], total: 20 }}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: 'Archive student' }));

      expect(
        screen.getByText('Dana still owes €20.00 across 1 payment. Archiving waives it.'),
      ).toBeInTheDocument();
    });

    it('Cancel closes the confirm with no request, returning focus to the main button', () => {
      render(
        <ArchiveStudentButton
          studentId="st-1"
          studentName="Dana"
          isArchived={false}
          outstanding={outstanding}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: 'Archive student' }));
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(screen.queryByRole('button', { name: 'Waive and archive' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Archive student' })).toHaveFocus();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('Waive and archive sends the waive ids and navigates on success', async () => {
      stubOk();
      render(
        <ArchiveStudentButton
          studentId="st-1"
          studentName="Dana"
          isArchived={false}
          outstanding={outstanding}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: 'Archive student' }));
      fireEvent.click(screen.getByRole('button', { name: 'Waive and archive' }));

      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith('/api/students/st-1?state=archived', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ waivePaymentIds: ['p1', 'p2'] }),
        }),
      );
      await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/students'));
    });

    it('a stale STUDENT_HAS_OUTSTANDING_PAYMENTS refusal shows the server message and refreshes, without navigating', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 409,
        json: async () => ({
          error: {
            code: 'STUDENT_HAS_OUTSTANDING_PAYMENTS',
            message: 'What this student owes has changed — now €50.00 across 2 payments. Check it and try again.',
          },
        }),
      });
      vi.stubGlobal('fetch', fetchMock);
      render(
        <ArchiveStudentButton
          studentId="st-1"
          studentName="Dana"
          isArchived={false}
          outstanding={outstanding}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: 'Archive student' }));
      fireEvent.click(screen.getByRole('button', { name: 'Waive and archive' }));

      expect(
        await screen.findByText(
          'What this student owes has changed — now €50.00 across 2 payments. Check it and try again.',
        ),
      ).toBeInTheDocument();
      expect(routerRefresh).toHaveBeenCalled();
      expect(routerPush).not.toHaveBeenCalled();
      // The confirm closes rather than retrying the stale ids — it reopens
      // with fresh numbers on the next tap of the main button.
      expect(screen.queryByRole('button', { name: 'Waive and archive' })).not.toBeInTheDocument();
      await waitFor(() => expect(screen.getByRole('button', { name: 'Archive student' })).toHaveFocus());
      expect(screen.getByRole('alert')).toHaveTextContent(
        'What this student owes has changed — now €50.00 across 2 payments. Check it and try again.',
      );
    });

    it('reopening the confirm after a refusal clears the old error', async () => {
      const staleMessage = 'What this student owes has changed — now €50.00 across 2 payments. Check it and try again.';
      fetchMock.mockResolvedValue({
        ok: false,
        status: 409,
        json: async () => ({ error: { code: 'STUDENT_HAS_OUTSTANDING_PAYMENTS', message: staleMessage } }),
      });
      vi.stubGlobal('fetch', fetchMock);
      render(
        <ArchiveStudentButton
          studentId="st-1"
          studentName="Dana"
          isArchived={false}
          outstanding={outstanding}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: 'Archive student' }));
      fireEvent.click(screen.getByRole('button', { name: 'Waive and archive' }));
      expect(await screen.findByText(staleMessage)).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Archive student' }));

      expect(screen.getByRole('button', { name: 'Waive and archive' })).toBeInTheDocument();
      expect(screen.queryByText(staleMessage)).not.toBeInTheDocument();
    });

    it('a network error keeps the confirm open and announces itself', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const offline = new Error('offline');
      fetchMock.mockRejectedValue(offline);
      vi.stubGlobal('fetch', fetchMock);
      render(
        <ArchiveStudentButton
          studentId="st-1"
          studentName="Dana"
          isArchived={false}
          outstanding={outstanding}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: 'Archive student' }));
      fireEvent.click(screen.getByRole('button', { name: 'Waive and archive' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('Network error. Try again.');
      expect(screen.getByRole('button', { name: 'Waive and archive' })).toBeInTheDocument();
      expect(consoleError).toHaveBeenCalledWith('[archive-student-button-archive] request failed', {
        studentId: 'st-1',
        waivedCount: 2,
        err: offline,
      });
      consoleError.mockRestore();
    });

    it('Cancel is disabled while the waive is in flight', async () => {
      let answer!: (res: { ok: boolean }) => void;
      fetchMock.mockReturnValue(new Promise((r) => { answer = r; }));
      vi.stubGlobal('fetch', fetchMock);
      render(
        <ArchiveStudentButton
          studentId="st-1"
          studentName="Dana"
          isArchived={false}
          outstanding={outstanding}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: 'Archive student' }));
      fireEvent.click(screen.getByRole('button', { name: 'Waive and archive' }));

      expect(await screen.findByRole('button', { name: 'Archiving...' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();

      answer({ ok: true });
      await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/students'));
    });
  });

  it('a prop stale in the other direction: nothing outstanding sends the plain PATCH, and a 409 STUDENT_HAS_OUTSTANDING_PAYMENTS back still refreshes', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        error: {
          code: 'STUDENT_HAS_OUTSTANDING_PAYMENTS',
          message: 'This student still owes €20.00 across 1 payment. Tap Archive student again to waive it and archive.',
        },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <ArchiveStudentButton
        studentId="st-1"
        studentName="Dana"
        isArchived={false}
        outstanding={noneOutstanding}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Archive student' }));

    // outstanding.ids is empty, so this is the plain PATCH, not a waive —
    // the prop said nothing was owed, and the server found otherwise.
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/students/st-1?state=archived', {
        method: 'PATCH',
      }),
    );
    expect(
      await screen.findByText('This student still owes €20.00 across 1 payment. Tap Archive student again to waive it and archive.'),
    ).toBeInTheDocument();
    expect(routerRefresh).toHaveBeenCalled();
    expect(routerPush).not.toHaveBeenCalled();
  });

  it('STUDENT_HAS_UNBILLED_CLASSES shows the server message with no confirm and no refresh', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        error: {
          code: 'STUDENT_HAS_UNBILLED_CLASSES',
          message: "This student is booked on 1 class that hasn't been billed yet. Remove them from it, or archive once it's completed.",
        },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <ArchiveStudentButton
        studentId="st-1"
        studentName="Dana"
        isArchived={false}
        outstanding={noneOutstanding}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Archive student' }));

    expect(
      await screen.findByText(
        "This student is booked on 1 class that hasn't been billed yet. Remove them from it, or archive once it's completed.",
      ),
    ).toBeInTheDocument();
    expect(routerRefresh).not.toHaveBeenCalled();
    expect(routerPush).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Waive and archive' })).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(
      "This student is booked on 1 class that hasn't been billed yet. Remove them from it, or archive once it's completed.",
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
    render(
      <ArchiveStudentButton
        studentId="st-1"
        studentName="Dana"
        isArchived={false}
        outstanding={noneOutstanding}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Archive student' }));

    expect(await screen.findByText('This student has an unpaid class.')).toBeInTheDocument();
    expect(routerPush).not.toHaveBeenCalled();
  });

  it('falls back to copy naming the direction when the server sends no message', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <ArchiveStudentButton
        studentId="st-1"
        studentName="Dana"
        isArchived={true}
        outstanding={noneOutstanding}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Unarchive student' }));

    expect(
      await screen.findByText('Could not unarchive this student. Try again.'),
    ).toBeInTheDocument();
  });

  it('reports a thrown fetch instead of swallowing it', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const offline = new Error('offline');
    fetchMock.mockRejectedValue(offline);
    vi.stubGlobal('fetch', fetchMock);
    render(
      <ArchiveStudentButton
        studentId="st-1"
        studentName="Dana"
        isArchived={false}
        outstanding={noneOutstanding}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Archive student' }));

    expect(await screen.findByText('Network error. Try again.')).toBeInTheDocument();
    // Re-enabled, not stuck mid-flight: `finally` still has to run on the
    // throw path.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Archive student' })).not.toBeDisabled(),
    );
    expect(consoleError).toHaveBeenCalledWith('[archive-student-button-archive] request failed', {
      studentId: 'st-1',
      waivedCount: undefined,
      err: offline,
    });
    consoleError.mockRestore();
  });
});
