'use client';

import { useState } from 'react';
import { readErrorMessage } from '@/lib/client-errors';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

interface SendAnnouncementProps {
  /** Scope to one class; omit to message all the teacher's students. */
  classId?: string;
  /** e.g. "everyone in this class" / "your booked students". */
  recipientHint: string;
}

interface SentState {
  /** `null` when a 2xx body couldn't be read — the send still happened. */
  count: number | null;
  suppressed: boolean;
}

// One-to-many only, by design: an announcement creates one notification
// per recipient (plus email fallback). There is no chat.
export function SendAnnouncement({ classId, recipientHint }: SendAnnouncementProps) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<SentState | null>(null);
  const [error, setError] = useState('');
  const [showRecipients, setShowRecipients] = useState(false);

  const recipientExplanation = classId
    ? "Everyone registered for this class (late cancellations included), unless they've muted your messages. They'll see it in the app on their next visit; anyone who hasn't read it within 30 minutes — sooner when class is about to start — also gets it by email, unless they've turned email off."
    : "Students with a booking in any of your classes, unless they've muted your messages — contacts who've never booked (or only cancelled) aren't included. They'll see it in the app on their next visit; anyone who hasn't read it within 30 minutes also gets it by email, unless they've turned email off.";

  async function handleSend() {
    if (!message.trim()) return;
    setSending(true);
    setError('');

    let res: Response;
    try {
      res = await fetch('/api/announcements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: message.trim(), ...(classId ? { classId } : {}) }),
      });
    } catch (err) {
      console.error('[send-announcement] request failed', { classId, err });
      setError('Network error. Try again.');
      setSending(false);
      return;
    }

    if (!res.ok) {
      setError(await readErrorMessage(res, 'Could not send the announcement. Try again.'));
      setSending(false);
      return;
    }

    // `res.ok` alone is not the whole answer: the route answers 201 when it
    // created the announcement and 200 when it suppressed an identical one
    // sent moments ago, and only `duplicateSuppressed` distinguishes them
    // in a field a client has to read past rather than a status it can
    // ignore.
    try {
      const json = (await res.json()) as {
        data: { recipientCount: number; duplicateSuppressed?: boolean };
      };
      if (typeof json?.data?.recipientCount !== 'number') {
        throw new Error('missing recipientCount');
      }
      setSent({ count: json.data.recipientCount, suppressed: json.data.duplicateSuppressed === true });
    } catch (err) {
      // A 2xx here means the send already happened (or was suppressed) —
      // an unreadable body is not a failure to report, and inviting a resend
      // would risk a genuine duplicate. Settle on what IS known: it went out.
      console.error('[send-announcement] sent, but the response was unreadable', { classId, err });
      setSent({ count: null, suppressed: false });
    }
    setMessage('');
    setOpen(false);
    setSending(false);
  }

  if (sent !== null && !open) {
    const students = sent.count !== null ? `${sent.count} ${sent.count === 1 ? 'student' : 'students'}` : null;
    // Neutral for the suppressed outcome — not `text-teal`, because nothing
    // new succeeded, and not `text-danger`, because nothing failed and danger
    // is reserved for things that did. Every other outcome (a fresh send, or
    // one whose body couldn't be read) uses the same teal as a plain confirm.
    const neutral = sent.count !== null && sent.suppressed;
    const label = sent.count === null
      ? 'Announcement sent.'
      : sent.suppressed
        ? `Not sent again — the same message reached ${students} moments ago.`
        : `Sent to ${students}`;
    return (
      <div className="flex items-center gap-3">
        <span className={neutral ? 'type-caption' : 'type-caption text-teal'}>
          {label}
        </span>
        <button
          type="button"
          onClick={() => { setSent(null); setOpen(true); }}
          className="type-label text-teal"
        >
          Send another
        </button>
      </div>
    );
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="type-label text-teal">
        Send announcement
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-3 w-full max-w-[480px]">
      <Textarea
        label={`Announcement to ${recipientHint}`}
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        rows={3}
        placeholder="Bring a blanket on Sunday — we'll end with a long savasana."
      />
      <div className="flex flex-col items-start gap-1">
        <button
          type="button"
          onClick={() => setShowRecipients((v) => !v)}
          aria-expanded={showRecipients}
          className="type-caption text-teal"
        >
          Who receives this?
        </button>
        {showRecipients && (
          <p className="type-caption">{recipientExplanation}</p>
        )}
      </div>
      <div className="flex gap-3">
        <Button variant="primary" onClick={handleSend} disabled={sending || !message.trim()}>
          {sending ? 'Sending...' : 'Send'}
        </Button>
        <Button variant="ghost" onClick={() => { setOpen(false); setError(''); }}>
          Close
        </Button>
      </div>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </div>
  );
}
