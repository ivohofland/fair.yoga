import { Input } from '@/components/ui/input';
import { BOOKING_URL_MAX } from '@/lib/input-bounds';
import { parseHttpsLink, BOOKING_LINK_MESSAGES } from '@/lib/payment-link';

export const BOOKING_LINK_LABEL = 'Booking page';
export const BOOKING_LINK_HINT = 'Where students book this class with the studio';

/**
 * What a booking link field holds, read the way the server reads it: `null`
 * for an empty field, the normalised href for a good link, or the message to
 * show.
 */
export function readBookingLink(raw: string): { ok: true; url: string | null } | { ok: false; message: string } {
  if (raw.trim() === '') return { ok: true, url: null };
  const parsed = parseHttpsLink(raw, BOOKING_URL_MAX);
  return parsed.ok ? { ok: true, url: parsed.url } : { ok: false, message: BOOKING_LINK_MESSAGES[parsed.error] };
}

export function BookingLinkField({
  value,
  onChange,
  error,
}: {
  value: string;
  onChange: (value: string) => void;
  error?: string;
}) {
  return (
    <Input
      id="bookingUrl"
      label={BOOKING_LINK_LABEL}
      inputMode="url"
      placeholder="https://"
      maxLength={BOOKING_URL_MAX * 2}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      hint={BOOKING_LINK_HINT}
      error={error}
    />
  );
}
