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
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Button variant="secondary" onClick={handleShare} className="w-full sm:w-auto">
      <Icon name="share" size={18} />
      {copied ? 'Link copied' : 'Share booking link'}
    </Button>
  );
}
