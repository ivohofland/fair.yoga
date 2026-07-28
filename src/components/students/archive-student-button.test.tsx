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
});
