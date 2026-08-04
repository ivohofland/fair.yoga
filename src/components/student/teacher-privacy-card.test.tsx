import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
  // `eraseTeacher` hard-deletes every link a teacher has — so a card on screen
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
});
