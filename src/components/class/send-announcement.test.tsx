import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SendAnnouncement } from './send-announcement';

/**
 * #196. `POST /api/announcements` suppresses an identical resend inside a
 * two-minute window and answers 200 with `duplicateSuppressed: true`, where a
 * genuine send answers 201. This component checked only `res.ok`, so both
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

afterEach(() => {
  vi.unstubAllGlobals();
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
    // rather than alarming, and `recipientCount` on this branch is the FIRST
    // send's, which is the honest number.
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
});
