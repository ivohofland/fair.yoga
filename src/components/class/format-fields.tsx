import type { ClassFormat } from '@/lib/prisma-client';
import { VIDEO_URL_MAX } from '@/lib/input-bounds';
import { parseHttpsLink, VIDEO_LINK_MESSAGES } from '@/lib/payment-link';
import { Input } from '@/components/ui/input';

/** The form's wording for the two formats, in the order they are offered. */
const FORMAT_CHOICES = [
  { value: 'in_person', label: 'In a room' },
  { value: 'online', label: 'Online' },
] as const satisfies readonly { value: ClassFormat; label: string }[];

export const VIDEO_LINK_LABEL = 'Video link (optional)';

/** Beside a template's link field: the link is stamped onto every class it makes. */
export const TEMPLATE_VIDEO_LINK_HINT =
  'Every class from this template gets this link. Use one that works each week, like a personal meeting room. If you make a new link for each class, leave this empty and add it to each class instead.';

/** Beside a one-off class's link field. */
export const CLASS_VIDEO_LINK_HINT = 'Only students who have booked see this link.';

/**
 * What a video link field holds, read the way the server reads it: `null` for
 * an empty field, the normalised href for a good link, or the message to show.
 */
export function readVideoLink(raw: string): { ok: true; url: string | null } | { ok: false; message: string } {
  if (raw.trim() === '') return { ok: true, url: null };
  const parsed = parseHttpsLink(raw, VIDEO_URL_MAX);
  return parsed.ok ? { ok: true, url: parsed.url } : { ok: false, message: VIDEO_LINK_MESSAGES[parsed.error] };
}

/** Two radios side by side, wrapping when the column is too narrow; each at least 44px tall. */
export function FormatChoice({
  value,
  onChange,
  name,
}: {
  value: ClassFormat;
  onChange: (format: ClassFormat) => void;
  name: string;
}) {
  return (
    <fieldset>
      <legend className="type-label mb-1">Format</legend>
      <div className="flex flex-wrap gap-x-6">
        {FORMAT_CHOICES.map((choice) => (
          <label key={choice.value} className="flex items-center gap-3 min-h-12 type-body">
            <input
              type="radio"
              className="h-5 w-5 accent-teal"
              name={name}
              checked={value === choice.value}
              onChange={() => onChange(choice.value)}
            />
            {choice.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function VideoLinkField({
  value,
  onChange,
  hint,
  error,
}: {
  value: string;
  onChange: (value: string) => void;
  hint: string;
  error?: string;
}) {
  return (
    <Input
      id="videoUrl"
      label={VIDEO_LINK_LABEL}
      inputMode="url"
      placeholder="https://"
      maxLength={VIDEO_URL_MAX * 2}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      hint={hint}
      error={error}
    />
  );
}
