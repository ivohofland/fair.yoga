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
});
