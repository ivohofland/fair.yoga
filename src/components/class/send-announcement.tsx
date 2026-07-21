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
  const [error, setError] = useState('');
  const [showRecipients, setShowRecipients] = useState(false);

  const recipientExplanation = classId
    ? "Everyone registered for this class. It lands in their inbox here; anyone who hasn't read it after 30 minutes also gets it by email, unless they've opted out."
    : "Everyone with a booking in one of your classes — contacts who've never booked won't receive it. It lands in their inbox here; anyone who hasn't read it after 30 minutes also gets it by email, unless they've opted out.";

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
        const json = (await res.json()) as { data: { recipientCount: number } };
        setSentCount(json.data.recipientCount);
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
    return (
      <div className="flex items-center gap-3">
        <span className="type-caption text-teal">
          Sent to {sentCount} {sentCount === 1 ? 'student' : 'students'}
        </span>
        <button
          type="button"
          onClick={() => { setSentCount(null); setOpen(true); }}
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
          <p className="type-caption max-w-[420px]">{recipientExplanation}</p>
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
      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  );
}
