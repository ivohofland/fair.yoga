'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';

interface ShareBookingLinkProps {
  pageSlug: string;
}

// Shares the teacher's public booking page. Uses the native share sheet
// where available (the one-handed phone case), clipboard otherwise.
export function ShareBookingLink({ pageSlug }: ShareBookingLinkProps) {
  const [copied, setCopied] = useState(false);
  const [fallbackUrl, setFallbackUrl] = useState('');

  async function handleShare() {
    const url = `${window.location.origin}/${pageSlug}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Book a class', url });
        return;
      } catch {
        // user dismissed the sheet — fall through to clipboard
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be blocked (permissions, insecure context) — an
      // unhandled rejection here would fail silently. Show the link so the
      // teacher can copy it by hand.
      setFallbackUrl(url);
    }
  }

  return (
    <div className="flex flex-col gap-2 w-full sm:w-auto">
      <Button variant="secondary" onClick={handleShare} className="w-full sm:w-auto">
        <Icon name="share" size={18} />
        {copied ? 'Link copied' : 'Share booking link'}
      </Button>
      {fallbackUrl && (
        <p className="type-caption break-all select-all">
          Copy it yourself: {fallbackUrl}
        </p>
      )}
    </div>
  );
}
