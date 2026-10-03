import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SendAnnouncement, SendAnnouncementSkeleton } from './send-announcement';

/**
 * #196. `POST /api/announcements` answers 200 with `duplicateSuppressed: true`
 * (and `outcome: 'unchanged'` beside the data) when every student it was asked
 * to tell had already had the message inside `ANNOUNCEMENT_DEDUPE_WINDOW_MS`,
 * and 201 when it told anyone. This component checked only `res.ok`, so both
 * outcomes rendered "Sent to 12 students" — a tool reporting a send that did
 * not happen. Suppressing the duplicate is right; hiding the suppression is
 * not, and these tests are what makes the honesty load-bearing rather than
 * decorative.
 *
 * `fetch` is stubbed per test: the `components` project mocks
 * `next/navigation` and nothing else (`vitest.config.ts`), so a click with no
 * stub issues a real relative-URL request that this component swallows into
 * "Network error" — green-looking for the wrong reason.
 */
function stubSend(status: number, data: Record<string, unknown>) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status < 400,
    status,
    json: async () => ({ data }),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/**
 * The failure shape, which `stubSend` cannot express: `respondError` answers
 * `{ error: { message, code } }`, with no `data` at all, and this component
 * reads that message rather than showing a generic line.
 */
function stubFailure(status: number, message: string) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: async () => ({ error: { message } }),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/**
 * A real `Response` whose `json()` genuinely throws — the shape a proxy's
 * HTML error page takes, which `stubFailure`'s plain object cannot express.
 */
function htmlResponse(status = 502): Response {
  return new Response('<html><body>502 Bad Gateway</body></html>', {
    status,
    headers: { 'Content-Type': 'text/html' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function send(message: string) {
  fireEvent.click(screen.getByText('Send announcement'));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: message } });
  fireEvent.click(screen.getByText('Send'));
}

describe('SendAnnouncement', () => {
  it('reports how many students a fresh announcement reached', async () => {
    stubSend(201, { recipientCount: 12, duplicateSuppressed: false });
    render(<SendAnnouncement classId="c1" recipientHint="everyone in this class" />);

    send('Bring a blanket.');

    expect(await screen.findByText('Sent to 12 students')).toBeInTheDocument();
  });

  it('says a duplicate was not sent again, and that the first one landed', async () => {
    stubSend(200, { recipientCount: 12, duplicateSuppressed: true });
    render(<SendAnnouncement classId="c1" recipientHint="everyone in this class" />);

    send('Bring a blanket.');

    // Both halves are asserted: what did NOT happen, and that the earlier send
    // did reach those students — the second is what makes the first calm
    // rather than alarming. `recipientCount` on this branch is how many of THIS
    // request's students already had the message (the response's
    // `alreadyNotified`), not the size of any earlier send.
    const caption = await screen.findByText(/Not sent again/);
    expect(caption).toHaveTextContent(/reached 12 students/);

    expect(screen.queryByText(/^Sent to/)).toBeNull();
  });

  /**
   * The register the caption is written in, asserted because it is a decision
   * and not a detail: nothing failed, so it is not `text-danger`; nothing new
   * succeeded, so it is not `text-teal` either. A neutral caption is the
   * honest colour for "we deliberately did nothing".
   */
  it('renders the suppressed caption neutrally — no success colour, no alarm colour', async () => {
    stubSend(200, { recipientCount: 12, duplicateSuppressed: true });
    render(<SendAnnouncement classId="c1" recipientHint="everyone in this class" />);

    send('Bring a blanket.');

    const caption = await screen.findByText(/Not sent again/);
    expect(caption.className).not.toMatch(/text-teal/);
    expect(caption.className).not.toMatch(/text-danger/);
  });

  /**
   * A suppressed send must not be a dead end. "Send another" reopens the
   * composer, and the next outcome has to be able to read as a real send —
   * a leftover `suppressed` flag would mislabel it.
   */
  it('clears the suppressed state when the teacher sends another', async () => {
    stubSend(200, { recipientCount: 12, duplicateSuppressed: true });
    render(<SendAnnouncement classId="c1" recipientHint="everyone in this class" />);
    send('Bring a blanket.');
    await screen.findByText(/Not sent again/);

    fireEvent.click(screen.getByText('Send another'));
    stubSend(201, { recipientCount: 12, duplicateSuppressed: false });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Different message.' } });
    fireEvent.click(screen.getByText('Send'));

    expect(await screen.findByText('Sent to 12 students')).toBeInTheDocument();
    expect(screen.queryByText(/Not sent again/)).toBeNull();
  });

  /**
   * The third outcome, and the only one no test covered: a send that FAILS.
   * Taken after a suppressed one on purpose — that is the state with
   * something to leave standing. "Not sent again — the same message reached
   * 12 students" is a claim about the message currently in the composer, and
   * a failed send that left it on screen would tell a teacher their
   * announcement was a harmless duplicate when in fact it never went out.
   *
   * The error branch is also the only reader of the route's `{ error:
   * { message } }` body: everything else here stubs `{ data }`, so an error
   * shape this component could not read would show as its generic fallback
   * with nothing failing.
   */
  it('shows the failure, and no leftover caption, when a send after a suppressed one fails', async () => {
    stubSend(200, { recipientCount: 12, duplicateSuppressed: true });
    render(<SendAnnouncement classId="c1" recipientHint="everyone in this class" />);
    send('Bring a blanket.');
    await screen.findByText(/Not sent again/);

    fireEvent.click(screen.getByText('Send another'));
    stubFailure(400, 'No students to notify');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Second try.' } });
    fireEvent.click(screen.getByText('Send'));

    // The route's own words, not a generic line — the teacher can act on
    // "No students to notify" and cannot act on "Try again".
    expect(await screen.findByText('No students to notify')).toBeInTheDocument();

    // Neither "it went out" caption survives the failure.
    expect(screen.queryByText(/Not sent again/)).toBeNull();
    expect(screen.queryByText(/^Sent to/)).toBeNull();
    // And the composer is still open with the text in it, so the teacher can
    // retry without retyping.
    expect(screen.getByRole('textbox')).toHaveValue('Second try.');
  });

  /**
   * A proxy's HTML error page, not the route's own `{ error }` shape. Read
   * through `readErrorMessage`, this shows the component's own fallback and
   * leaves a console record instead of the generic "Network error" copy a
   * `SyntaxError` landing in the outer catch would produce.
   */
  it('shows the fallback and logs when the error body is unreadable', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(htmlResponse(502)));
    render(<SendAnnouncement classId="c1" recipientHint="everyone in this class" />);

    send('Bring a blanket.');

    expect(
      await screen.findByText('Could not send the announcement. Try again.'),
    ).toBeInTheDocument();
    expect(consoleError).toHaveBeenCalledWith(
      'API error response body could not be read',
      expect.objectContaining({ status: 502 }),
    );
  });

  it('shows network copy and logs when the request itself fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    render(<SendAnnouncement classId="c1" recipientHint="everyone in this class" />);

    send('Bring a blanket.');

    expect(await screen.findByText('Network error. Try again.')).toBeInTheDocument();
    expect(consoleError).toHaveBeenCalledWith(
      '[send-announcement] request failed',
      expect.objectContaining({ classId: 'c1' }),
    );
  });

  /**
   * A 2xx means the server accepted the send, so an unreadable body must be
   * treated as sent, not shown as a failure that invites a resend. The
   * composer closes and the caption reads success with no count, since none
   * is known — and "Send another" is still offered rather than a dead end.
   */
  it('treats the send as sent, with no count, when a successful response is unreadable', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(htmlResponse(201)));
    render(<SendAnnouncement classId="c1" recipientHint="everyone in this class" />);

    send('Bring a blanket.');

    const caption = await screen.findByText('Announcement sent.');
    expect(caption.className).toMatch(/text-teal/);
    expect(consoleError).toHaveBeenCalledWith(
      '[send-announcement] sent, but the response was unreadable',
      expect.objectContaining({ classId: 'c1' }),
    );
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText('Send another')).toBeInTheDocument();
  });

  /**
   * A parseable 2xx body that lacks `recipientCount` is a different shape of
   * the same problem the test above covers: `json.data.recipientCount` would
   * be `undefined`, and rendering it straight into the caption reads "Sent to
   * undefined students" — a claim about the send, made up out of a field that
   * was never there.
   */
  it('treats the send as sent, with no count, when a successful body is missing recipientCount', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 201, json: async () => ({ data: {} }) }),
    );
    render(<SendAnnouncement classId="c1" recipientHint="everyone in this class" />);

    send('Bring a blanket.');

    const caption = await screen.findByText('Announcement sent.');
    expect(caption.className).toMatch(/text-teal/);
    expect(consoleError).toHaveBeenCalledWith(
      '[send-announcement] sent, but the response was unreadable',
      expect.objectContaining({ classId: 'c1' }),
    );
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText('Send another')).toBeInTheDocument();
  });
});

describe('SendAnnouncement audience choice', () => {
  const AUDIENCE = [
    { id: 'a', displayName: 'Anna K.' },
    { id: 'b', displayName: 'Ben L.' },
  ];

  /** Routes the picker's GET and the composer's POST to separate answers. */
  function stubRoutes(post: { status: number; data: Record<string, unknown> }) {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/announcements/audience') {
        return { ok: true, status: 200, json: async () => ({ data: { students: AUDIENCE } }) };
      }
      return { ok: post.status < 400, status: post.status, json: async () => ({ data: post.data }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  function postBody(fetchMock: ReturnType<typeof stubRoutes>): Record<string, unknown> {
    const call = fetchMock.mock.calls.find(([url]) => url === '/api/announcements');
    if (!call) throw new Error('no POST made');
    const init = (call as unknown as [string, { body: string }])[1];
    return JSON.parse(init.body) as Record<string, unknown>;
  }

  async function openChoosing() {
    fireEvent.click(screen.getByText('Send announcement'));
    fireEvent.click(screen.getByLabelText('Choose students'));
    return screen.findByLabelText('Anna K.');
  }

  it('offers no audience choice when scoped to a class', () => {
    render(<SendAnnouncement classId="c1" recipientHint="everyone in this class" />);
    fireEvent.click(screen.getByText('Send announcement'));
    expect(screen.queryByLabelText('Choose students')).toBeNull();
    expect(screen.queryByLabelText('Everyone')).toBeNull();
  });

  it('defaults to everyone and fetches no audience', () => {
    const fetchMock = stubRoutes({ status: 201, data: { recipientCount: 1 } });
    render(<SendAnnouncement recipientHint="your students" />);
    fireEvent.click(screen.getByText('Send announcement'));
    expect((screen.getByLabelText('Everyone') as HTMLInputElement).checked).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs studentIds and no classId for a chosen audience', async () => {
    const fetchMock = stubRoutes({ status: 201, data: { recipientCount: 1, duplicateSuppressed: false } });
    render(<SendAnnouncement recipientHint="your students" />);
    fireEvent.click(await openChoosing());
    fireEvent.change(screen.getByLabelText('Announcement to 1 selected'), { target: { value: 'Hello.' } });
    fireEvent.click(screen.getByText('Send'));

    await screen.findByText('Sent to 1 student');
    expect(postBody(fetchMock)).toEqual({ message: 'Hello.', studentIds: ['a'] });
  });

  it('disables Send while nobody is ticked', async () => {
    stubRoutes({ status: 201, data: { recipientCount: 1 } });
    render(<SendAnnouncement recipientHint="your students" />);
    await openChoosing();
    fireEvent.change(screen.getByLabelText('Announcement to 0 selected'), { target: { value: 'Hello.' } });
    expect((screen.getByText('Send') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('Anna K.'));
    expect((screen.getByText('Send') as HTMLButtonElement).disabled).toBe(false);
  });

  it('sends to everyone with no studentIds after switching back', async () => {
    const fetchMock = stubRoutes({ status: 201, data: { recipientCount: 2 } });
    render(<SendAnnouncement recipientHint="your students" />);
    fireEvent.click(await openChoosing());
    fireEvent.click(screen.getByLabelText('Everyone'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Hello.' } });
    fireEvent.click(screen.getByText('Send'));

    await screen.findByText('Sent to 2 students');
    expect(postBody(fetchMock)).toEqual({ message: 'Hello.' });
  });

  it('reports how many already had the message', async () => {
    stubRoutes({ status: 201, data: { recipientCount: 1, duplicateSuppressed: false, alreadyNotified: 2 } });
    render(<SendAnnouncement recipientHint="your students" />);
    fireEvent.click(await openChoosing());
    fireEvent.change(screen.getByLabelText('Announcement to 1 selected'), { target: { value: 'Hello.' } });
    fireEvent.click(screen.getByText('Send'));

    expect(await screen.findByText('Sent to 1 student (2 already had it)')).toBeInTheDocument();
  });

  it('keeps the ticked students when the teacher sends another', async () => {
    const fetchMock = stubRoutes({ status: 201, data: { recipientCount: 1 } });
    render(<SendAnnouncement recipientHint="your students" />);
    fireEvent.click(await openChoosing());
    fireEvent.change(screen.getByLabelText('Announcement to 1 selected'), { target: { value: 'Hello.' } });
    fireEvent.click(screen.getByText('Send'));
    await screen.findByText('Sent to 1 student');

    fireEvent.click(screen.getByText('Send another'));
    expect((await screen.findByLabelText('Anna K.') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByLabelText('Ben L.'));
    fireEvent.change(screen.getByLabelText('Announcement to 2 selected'), { target: { value: 'Hello.' } });
    fireEvent.click(screen.getByText('Send'));

    await waitFor(() => {
      const posts = fetchMock.mock.calls.filter(([url]) => url === '/api/announcements');
      expect(posts).toHaveLength(2);
    });
    const last = fetchMock.mock.calls.filter(([url]) => url === '/api/announcements')[1] as unknown as [string, { body: string }];
    expect(JSON.parse(last[1].body)).toEqual({ message: 'Hello.', studentIds: ['a', 'b'] });
  });

  it('says how many of the selection could not be reached', async () => {
    stubRoutes({ status: 201, data: { recipientCount: 1, duplicateSuppressed: false, alreadyNotified: 0 } });
    render(<SendAnnouncement recipientHint="your students" />);
    fireEvent.click(await openChoosing());
    fireEvent.click(screen.getByLabelText('Ben L.'));
    fireEvent.change(screen.getByLabelText('Announcement to 2 selected'), { target: { value: 'Hello.' } });
    fireEvent.click(screen.getByText('Send'));

    expect(
      await screen.findByText(
        'Sent to 1 student — 1 of your selection could not be reached (muted, or no longer your students)',
      ),
    ).toBeInTheDocument();
  });

  it('counts a student who already had it as reached', async () => {
    stubRoutes({ status: 201, data: { recipientCount: 1, duplicateSuppressed: false, alreadyNotified: 1 } });
    render(<SendAnnouncement recipientHint="your students" />);
    fireEvent.click(await openChoosing());
    fireEvent.click(screen.getByLabelText('Ben L.'));
    fireEvent.change(screen.getByLabelText('Announcement to 2 selected'), { target: { value: 'Hello.' } });
    fireEvent.click(screen.getByText('Send'));

    expect(await screen.findByText('Sent to 1 student (1 already had it)')).toBeInTheDocument();
  });

  it('says nothing about the selection when the send went to everyone', async () => {
    stubRoutes({ status: 201, data: { recipientCount: 1, duplicateSuppressed: false, alreadyNotified: 0 } });
    render(<SendAnnouncement recipientHint="your students" />);
    fireEvent.click(await openChoosing());
    fireEvent.click(screen.getByLabelText('Ben L.'));
    fireEvent.click(screen.getByLabelText('Everyone'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Hello.' } });
    fireEvent.click(screen.getByText('Send'));

    expect(await screen.findByText('Sent to 1 student')).toBeInTheDocument();
  });

  describe('while the student list is not in', () => {
    /**
     * The first GET answers, so a student can be ticked and sent to; the
     * second — the picker remounting on "Send another" — is whatever `second`
     * says. The tick survives the remount, which is what makes a hidden,
     * sendable selection possible at all.
     */
    function stubSecondLoad(second: () => Promise<unknown>) {
      let gets = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          if (url === '/api/announcements/audience') {
            gets += 1;
            if (gets === 1) {
              return { ok: true, status: 200, json: async () => ({ data: { students: AUDIENCE } }) };
            }
            return second();
          }
          return { ok: true, status: 201, json: async () => ({ data: { recipientCount: 1 } }) };
        }),
      );
    }

    async function sendOnceThenReopen() {
      render(<SendAnnouncement recipientHint="your students" />);
      fireEvent.click(await openChoosing());
      fireEvent.change(screen.getByLabelText('Announcement to 1 selected'), { target: { value: 'Hello.' } });
      fireEvent.click(screen.getByText('Send'));
      await screen.findByText('Sent to 1 student');
      fireEvent.click(screen.getByText('Send another'));
      fireEvent.change(screen.getByLabelText('Announcement to 1 selected'), { target: { value: 'Again.' } });
    }

    it('holds Send while the list is loading', async () => {
      stubSecondLoad(() => new Promise(() => {}));
      await sendOnceThenReopen();
      expect(screen.getByText('Loading your students…')).toBeInTheDocument();
      expect((screen.getByText('Send') as HTMLButtonElement).disabled).toBe(true);
    });

    it('holds Send when the list failed to load', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      stubSecondLoad(async () => ({ ok: false, status: 500, json: async () => ({}) }));
      await sendOnceThenReopen();
      expect(await screen.findByRole('alert')).toHaveTextContent('Could not load your students.');
      expect((screen.getByText('Send') as HTMLButtonElement).disabled).toBe(true);
    });
  });

  it('keeps the suppressed wording when every chosen student already had it', async () => {
    stubRoutes({ status: 200, data: { recipientCount: 2, duplicateSuppressed: true, alreadyNotified: 2 } });
    render(<SendAnnouncement recipientHint="your students" />);
    fireEvent.click(await openChoosing());
    fireEvent.click(screen.getByLabelText('Ben L.'));
    fireEvent.change(screen.getByLabelText('Announcement to 2 selected'), { target: { value: 'Hello.' } });
    fireEvent.click(screen.getByText('Send'));

    const caption = await screen.findByText(/Not sent again/);
    expect(caption).toHaveTextContent('Not sent again — the same message reached 2 students moments ago.');
    expect(caption.textContent).not.toMatch(/already had it/);
  });
});

describe('SendAnnouncementSkeleton', () => {
  it('draws the collapsed trigger\'s line in its type style, hidden and inert', () => {
    render(<SendAnnouncement recipientHint="your booked students" />);
    const trigger = screen.getByRole('button', { name: 'Send announcement' });
    const { container } = render(<SendAnnouncementSkeleton />);
    const line = container.firstElementChild;
    expect(line?.getAttribute('aria-hidden')).toBe('true');
    const typeStyle = trigger.className.split(/\s+/).find((t) => t.startsWith('type-'));
    expect(typeStyle).toBe('type-label');
    expect(line?.classList.contains(typeStyle ?? '')).toBe(true);
    expect(container.querySelector('a, button, input, select, textarea, [tabindex]')).toBeNull();
  });
});
