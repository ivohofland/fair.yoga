import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { routerPush } from '../../../tests/setup/components';
import { DataAndDeletion } from './data-and-deletion';
import { enqueueAttendance, getOutbox, resetOutboxForTests } from '@/lib/attendance-outbox';

const clearOfflinePages = vi.fn<() => Promise<void>>(async () => {});
vi.mock('@/lib/offline-client', () => ({
  clearOfflinePages: () => clearOfflinePages(),
}));

/**
 * #171: the student delete confirmation discloses that the address behind a
 * refusal is kept. What is kept and why: `docs/data-model.md` (TeacherBlock).
 */
describe('DataAndDeletion', () => {
  it('tells a student that the email address behind a refusal is kept', () => {
    render(<DataAndDeletion role="student" />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete account' }));

    expect(
      screen.getByText(/we keep your email address only so they can't invite you again/),
    ).toBeInTheDocument();
  });

  it('keeps the refusal sentence out of the teacher copy', () => {
    render(<DataAndDeletion role="teacher" />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete account' }));

    // Positive first: without it, the negative below would also pass on a
    // confirmation that never opened.
    expect(screen.getByText(/permanently removes your personal data/)).toBeInTheDocument();
    expect(screen.queryByText(/can't invite you again/)).not.toBeInTheDocument();
  });

  describe('export', () => {
    const createObjectURL = vi.fn();
    const revokeObjectURL = vi.fn();
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;

    function arrange() {
      URL.createObjectURL = createObjectURL;
      URL.revokeObjectURL = revokeObjectURL;
      createObjectURL.mockReturnValue('blob:export');
      return vi.spyOn(console, 'error').mockImplementation(() => {});
    }

    afterEach(() => {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
      createObjectURL.mockReset();
      revokeObjectURL.mockReset();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    function clickExport() {
      fireEvent.click(screen.getByRole('button', { name: 'Download your data (JSON)' }));
    }

    it('downloads the blob through an anchor click', async () => {
      arrange();
      const blob = new Blob(['{}']);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, blob: async () => blob }));
      const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
      render(<DataAndDeletion role="teacher" />);

      clickExport();

      await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
      expect(createObjectURL).toHaveBeenCalledWith(blob);
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:export');
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('shows the server error and downloads nothing when the response is not ok', async () => {
      arrange();
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }),
      );
      render(<DataAndDeletion role="teacher" />);

      clickExport();

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Could not build the export. Try again.',
      );
      expect(createObjectURL).not.toHaveBeenCalled();
    });

    it('logs a rejected fetch and shows the network error', async () => {
      const consoleError = arrange();
      const boom = new Error('offline');
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(boom));
      render(<DataAndDeletion role="student" />);

      clickExport();

      expect(await screen.findByRole('alert')).toHaveTextContent('Network error. Try again.');
      expect(consoleError).toHaveBeenCalledWith(
        '[data-and-deletion-export] request failed',
        { role: 'student', err: boom },
      );
      expect(createObjectURL).not.toHaveBeenCalled();
    });

    it('logs a failing download and shows the existing export error', async () => {
      const consoleError = arrange();
      const boom = new Error('no object urls');
      createObjectURL.mockImplementation(() => {
        throw boom;
      });
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(['{}']) }),
      );
      render(<DataAndDeletion role="teacher" />);

      clickExport();

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Could not build the export. Try again.',
      );
      expect(consoleError).toHaveBeenCalledWith('[data-and-deletion-export] download failed', {
        role: 'teacher',
        err: boom,
      });
    });
  });
});

describe('DataAndDeletion, deleting the account', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    clearOfflinePages.mockReset();
    clearOfflinePages.mockImplementation(async () => {});
  });

  function confirmDelete() {
    fireEvent.click(screen.getByRole('button', { name: 'Delete account' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete my account' }));
  }

  it('clears the stored pages after the DELETE succeeds, before it navigates', async () => {
    const order: string[] = [];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    clearOfflinePages.mockImplementation(async () => {
      await Promise.resolve();
      order.push('cleared');
    });
    routerPush.mockImplementation(() => order.push('push'));
    render(<DataAndDeletion role="teacher" />);

    confirmDelete();

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/login'));
    expect(order).toEqual(['cleared', 'push']);
    routerPush.mockReset();
  });

  it('clears the queued attendance once the account is deleted', async () => {
    localStorage.clear();
    resetOutboxForTests();
    await enqueueAttendance({
      ownerId: 'owner-1',
      registrationId: 'reg-1',
      classId: 'class-1',
      studentName: 'Student',
      status: 'attended',
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    render(<DataAndDeletion role="teacher" />);

    confirmDelete();

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/login'));
    expect(Object.keys(getOutbox().pending)).toEqual([]);
    routerPush.mockReset();
  });

  it('keeps the stored pages when the DELETE is refused', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }),
    );
    render(<DataAndDeletion role="teacher" />);

    confirmDelete();

    await screen.findByRole('alert');
    expect(clearOfflinePages).not.toHaveBeenCalled();
  });
});
