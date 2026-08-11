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
   * (past bookings, payments) and what doesn't — the teacher's ability to
   * re-add this student unprompted, their announcements, the waitlist
   * spots, and every share on the card above.
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

    // Review F2: `unlinkTeacher` (services/invitations.ts) withdraws every
    // `waiting` waitlist entry for this teacher's classes — a consequence
    // the confirm copy omitted entirely until this pass.
    it('names the waitlist consequence, not just what survives', () => {
      stubFetch();
      renderCard();
      fireEvent.click(screen.getByRole('button', { name: /remove this teacher/i }));
      expect(screen.getByText(/waitlists? is given up/i)).toBeInTheDocument();
    });

    // Whole-branch review C1: the same call silences this teacher's
    // announcements and switches every share on this card off, by writing
    // the `StudentPrivacy` row the unlink would otherwise leave standing.
    // The copy promised neither — it offered only "they can't add you
    // again", which reads as though a student who unlinks after booking
    // keeps receiving announcements they can no longer mute.
    it('names the announcement and sharing consequences', () => {
      stubFetch();
      renderCard();
      fireEvent.click(screen.getByRole('button', { name: /remove this teacher/i }));
      expect(screen.getByText(/stops sending you announcements/i)).toBeInTheDocument();
      expect(screen.getByText(/switched off/i)).toBeInTheDocument();
    });

    // Review F7 found that `setUnlinking(false)` in a `finally` fired right
    // after a successful DELETE, before `router.refresh()` had repainted the
    // page and dropped this card — so a second click reached the server for a
    // link that was already gone and showed "not found" over a success.
    //
    // F7's conclusion stands and is still pinned: a second click must not
    // reach the server. #40 changed only the remedy, because F7's left
    // `unlinking` true forever and froze the confirm cluster when the
    // refresh never committed.
    it('settles after a successful unlink, and cannot send a second DELETE', async () => {
      stubFetch();
      renderCard();
      fireEvent.click(screen.getByRole('button', { name: /remove this teacher/i }));
      fireEvent.click(screen.getByRole('button', { name: /^remove teacher$/i }));

      expect(await screen.findByText(/^Removed/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^remove teacher$/i })).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: /refresh/i }));
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    // G7, second half — Mode 2.
    it('leaves Cancel operable while the DELETE is in flight', async () => {
      let release!: (value: { ok: boolean }) => void;
      fetchMock.mockReturnValue(
        new Promise((resolve) => {
          release = resolve;
        }),
      );
      vi.stubGlobal('fetch', fetchMock);
      renderCard();
      fireEvent.click(screen.getByRole('button', { name: /remove this teacher/i }));
      fireEvent.click(screen.getByRole('button', { name: /^remove teacher$/i }));

      const cancel = screen.getByRole('button', { name: /^cancel$/i });
      await waitFor(() => expect(screen.getByRole('button', { name: /removing/i })).toBeDisabled());
      expect(cancel).toBeEnabled();

      fireEvent.click(cancel);
      release({ ok: true });

      // Whole-branch review F2. Rule 3 un-disabled Cancel, which opened a path
      // that did not exist before: confirm → DELETE in flight → Cancel → the
      // DELETE resolves ok. Cancel cannot recall it, and the link is severed
      // along with a `TeacherBlock` only booking a class can lift, so the card
      // must settle. The settled check used to sit *inside* the confirming
      // branch, so this exact sequence rendered nothing — the card reverted to
      // the full privacy UI offering "Remove this teacher" for a teacher
      // already removed. This test used to end at `release` (F7) and therefore
      // could not see it.
      expect(await screen.findByText(/^Removed/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /remove this teacher/i })).toBeNull();
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

  /**
   * Review F3: archiving is the teacher's own CRM filing action, and must
   * never remove the student's controls over the same link — the page no
   * longer filters an archived `TeacherStudent` row out of the list it
   * renders here, and this card's only acknowledgment of that state is a
   * factual note, never a hidden card or disabled action.
   */
  describe('archivedByTeacher', () => {
    it('shows no archived note by default', () => {
      stubFetch();
      renderCard();
      expect(screen.queryByText(/archived by/i)).toBeNull();
    });

    it('shows a factual note, and still renders the toggles and unlink control, when archived', () => {
      stubFetch();
      render(
        <TeacherPrivacyCard
          studentId="student-1"
          teacherId="teacher-1"
          teacherName="Jane Teacher"
          initial={initial}
          archivedByTeacher
        />,
      );
      expect(screen.getByText(/archived by jane teacher/i)).toBeInTheDocument();
      expect(screen.getByLabelText('Phone number')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /remove this teacher/i })).toBeInTheDocument();
    });
  });
});
