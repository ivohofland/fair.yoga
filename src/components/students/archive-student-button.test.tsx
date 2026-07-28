import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ArchiveStudentButton } from './archive-student-button';

/**
 * URL only. This button renders no confirmation — success is a `router.push`
 * — so there is nothing further a component test would see that a pure
 * function could not. See the spec's scope boundary (#99).
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
