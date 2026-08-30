'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

interface SendAnnouncementProps {
  /** Scope to one class; omit to message all the teacher's students. */
  classId?: string;
  /** e.g. "everyone in this class" / "your booked students". */
  recipientHint: string;
}

// One-to-many only, by design: an announcement creates one notification
// per recipient (plus email fallback). There is no chat.
export function SendAnnouncement({ classId, recipientHint }: SendAnnouncementProps) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [sentCount, setSentCount] = useState<number | null>(null);
  const [suppressed, setSuppressed] = useState(false);
  const [error, setError] = useState('');
  const [showRecipients, setShowRecipients] = useState(false);

  const recipientExplanation = classId
    ? "Everyone registered for this class (late cancellations included), unless they've muted your messages. They'll see it in the app on their next visit; anyone who hasn't read it within 30 minutes — sooner when class is about to start — also gets it by email, unless they've turned email off."
    : "Students with a booking in any of your classes, unless they've muted your messages — contacts who've never booked (or only cancelled) aren't included. They'll see it in the app on their next visit; anyone who hasn't read it within 30 minutes also gets it by email, unless they've turned email off.";

  async function handleSend() {
    if (!message.trim()) return;
    setSending(true);
    setError('');
    try {
      const res = await fetch('/api/announcements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: message.trim(), ...(classId ? { classId } : {}) }),
      });
      if (res.ok) {
        // `res.ok` alone is not the whole answer, and reading it as though it
        // were is the defect #196 fixed here: the route answers 201 when it
        // created the announcement and 200 when it suppressed an identical one
        // sent moments ago, and only `duplicateSuppressed` distinguishes them
        // in a field a client has to read past rather than a status it can
        // ignore.
        const json = (await res.json()) as {
          data: { recipientCount: number; duplicateSuppressed?: boolean };
        };
        setSentCount(json.data.recipientCount);
        setSuppressed(json.data.duplicateSuppressed === true);
        setMessage('');
        setOpen(false);
      } else {
        const json = (await res.json()) as { error?: { message?: string } | string };
        const messageText = typeof json.error === 'string' ? json.error : json.error?.message;
        setError(messageText ?? 'Could not send the announcement. Try again.');
      }
    } catch {
      setError('Network error. Try again.');
    } finally {
      setSending(false);
    }
  }

  if (sentCount !== null && !open) {
    const students = `${sentCount} ${sentCount === 1 ? 'student' : 'students'}`;
    return (
      <div className="flex items-center gap-3">
        {/* Neutral for the suppressed outcome — not `text-teal`, because
            nothing new succeeded, and not `text-danger`, because nothing
            failed and danger is reserved for things that did. The caption
            names what happened AND confirms the earlier send landed, so the
            teacher learns their message went out without being told a second
            one did. */}
        <span className={suppressed ? 'type-caption' : 'type-caption text-teal'}>
          {suppressed
            ? `Not sent again — the same message reached ${students} moments ago.`
            : `Sent to ${students}`}
        </span>
        <button
          type="button"
          onClick={() => { setSentCount(null); setSuppressed(false); setOpen(true); }}
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
