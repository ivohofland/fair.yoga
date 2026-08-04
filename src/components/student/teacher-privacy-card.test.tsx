import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { routerRefresh } from '../../../tests/setup/components';
import { TeacherPrivacyCard } from './teacher-privacy-card';

/**
 * #136. The body here was already `{ teacherId, ...values }`, spread from
 * the exported `TeacherPrivacyValues` interface — so unlike its three
 * siblings in this batch, this form had no untracked drift to begin with.
 * Only the pins against `updatePrivacySchema` were missing. This test holds
 * what a pin cannot see, which is what actually reaches the API: all seven
 * keys, teacherId plus the six privacy fields, including a toggled value.
 *
 * Nothing fetches on mount, so the save click is the first (and only) call.
 */
describe('TeacherPrivacyCard', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  function stubFetch() {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
  }

  const initial = {
    shareFullName: true,
    shareEmail: true,
    sharePhone: false,
    shareBirthday: false,
    shareAddress: false,
    receiveComms: true,
  };

  async function save(): Promise<{ url: string; method: string; body: Record<string, unknown> }> {
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, options] = fetchMock.mock.calls[0] ?? [];
    const opts = options as { method: string; body: string };
    return {
      url: url as string,
      method: opts.method,
      body: JSON.parse(opts.body) as Record<string, unknown>,
    };
  }

  it('sends all seven fields — teacherId plus the six privacy values', async () => {
    stubFetch();
    render(
      <TeacherPrivacyCard
        studentId="student-1"
        teacherId="teacher-1"
        teacherName="Jane Teacher"
        initial={initial}
      />,
    );
    const { url, method, body } = await save();
    expect(url).toBe('/api/students/student-1/privacy');
    expect(method).toBe('PUT');
    expect(body).toEqual({
      teacherId: 'teacher-1',
      shareFullName: true,
      shareEmail: true,
      sharePhone: false,
      shareBirthday: false,
      shareAddress: false,
      receiveComms: true,
    });
  });

  it('sends a toggled value, not just the initial one', async () => {
    stubFetch();
    render(
      <TeacherPrivacyCard
        studentId="student-1"
        teacherId="teacher-1"
        teacherName="Jane Teacher"
        initial={initial}
      />,
    );
    fireEvent.click(screen.getByLabelText('Phone number'));
    const { body } = await save();
    expect(body.sharePhone).toBe(true);
  });

  function stubFailure(status: number) {
    fetchMock.mockResolvedValue({ ok: false, status, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
  }

  function renderCard() {
    render(
      <TeacherPrivacyCard
        studentId="student-1"
        teacherId="teacher-1"
        teacherName="Jane Teacher"
        initial={initial}
      />,
    );
  }

  // The route started 403ing unlinked teachers on the #146/#148 branch, and
  // `deleteTeacherAccount` hard-deletes every link a teacher has — so a card
  // can outlive its link. Retry advice for a state no retry can reach is the
  // defect; these two pin that only the retryable failure says "try again".
  it('403 says the link is gone, and does not suggest retrying', async () => {
    stubFailure(403);
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() =>
      expect(screen.getByText(/no longer connected to your account/i)).toBeTruthy(),
    );
    expect(screen.queryByText(/try again/i)).toBeNull();
  });

  it('keeps the retry message for failures a retry can fix', async () => {
    stubFailure(500);
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(screen.getByText('Could not save. Try again.')).toBeTruthy());
  });

  /**
   * #166 Task 11. `DELETE /api/teacher-links/[teacherId]` — the student's
   * unlink. Two-step confirm, same idiom as `RemoveStudentButton` and
   * `PendingInvitationCard`: the trigger alone must never fetch, and the
   * copy in the confirm step is the one place this promises what survives
   * (past bookings, payments) and what doesn't (the teacher's ability to
   * re-add this student unprompted).
   */
  describe('unlinking a teacher', () => {
    it('renders no confirmation, and fetches nothing, until the trigger is clicked', () => {
      stubFetch();
      renderCard();
      expect(screen.queryByText(/won't be able to add you again/i)).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: /remove this teacher/i }));
      expect(fetchMock).not.toHaveBeenCalled();
      expect(screen.getByText(/won't be able to add you again/i)).toBeInTheDocument();
    });

    it('DELETEs /api/teacher-links/:teacherId and refreshes on success', async () => {
      stubFetch();
      renderCard();
      fireEvent.click(screen.getByRole('button', { name: /remove this teacher/i }));
      fireEvent.click(screen.getByRole('button', { name: /^remove teacher$/i }));
      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith('/api/teacher-links/teacher-1', { method: 'DELETE' }),
      );
      await waitFor(() => expect(routerRefresh).toHaveBeenCalledTimes(1));
    });

    it('cancel returns to the unconfirmed state without fetching', () => {
      stubFetch();
      renderCard();
      fireEvent.click(screen.getByRole('button', { name: /remove this teacher/i }));
      fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
      expect(screen.queryByText(/won't be able to add you again/i)).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('surfaces the server error message on a failed unlink, and does not refresh', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({ error: { message: 'Teacher link not found' } }),
      });
      vi.stubGlobal('fetch', fetchMock);
      renderCard();
      fireEvent.click(screen.getByRole('button', { name: /remove this teacher/i }));
      fireEvent.click(screen.getByRole('button', { name: /^remove teacher$/i }));
      expect(await screen.findByText('Teacher link not found')).toBeInTheDocument();
      expect(routerRefresh).not.toHaveBeenCalled();
    });
  });
});
