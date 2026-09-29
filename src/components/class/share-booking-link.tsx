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
        // eslint-disable-next-line no-restricted-syntax -- the share sheet was dismissed (or is unsupported); fall through to the clipboard
      } catch {
        // Fall through to the clipboard.
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      // eslint-disable-next-line no-restricted-syntax -- the clipboard is blocked (permissions, insecure context); the link is shown for copying by hand
    } catch {
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
