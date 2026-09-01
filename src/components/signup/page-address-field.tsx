'use client';

import { useEffect, useState } from 'react';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { pageSlugField } from '@/lib/schemas';

/**
 * One name part reduced to the slug alphabet. Everything outside `[a-z0-9]`
 * is DROPPED, not hyphenated — the separator is reserved for the boundary
 * between the two names, so "de Vries" is one part and derives to "devries".
 * NFKD splits an accented letter into its base plus a combining mark, and the
 * mark is then dropped with everything else: "Siobhán" -> "siobhan".
 *
 * A part written in a script with no Latin decomposition derives to the empty
 * string, which `slugFromName` filters out.
 */
function slugPart(part: string): string {
  return part
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/**
 * The address a name suggests. Advisory: the field it fills is editable, and
 * a name that derives to nothing yields the empty string rather than a
 * placeholder — CLAUDE.md commits to international from day one, so a teacher
 * whose name is written in another script gets an empty field to fill, never
 * a block and never a machine-made stand-in.
 */
export function slugFromName(firstName: string, lastName: string): string {
  return [slugPart(firstName), slugPart(lastName)].filter(Boolean).join('-');
}

/**
 * One completed check, carrying the address it answered ABOUT.
 *
 * Keyed that way rather than held as a bare verdict so an answer can never be
 * rendered against a different address than the one it was asked about — the
 * teacher keeps typing while a request is in flight, and the reply arrives
 * after the field has moved on.
 *
 * `available: null` is a check that could not be completed — a network
 * failure, or a 429 from the endpoint's rate limit. It deliberately says
 * nothing rather than guessing: a wrong "Available" is worse than silence,
 * because the submit is where the answer actually binds.
 */
interface Answer {
  slug: string;
  available: boolean | null;
}

const DEBOUNCE_MS = 400;

interface PageAddressFieldProps {
  value: string;
  onChange: (value: string) => void;
  /**
   * A field error the SERVER decided — the 409 `SLUG_TAKEN` at submit. It
   * outranks anything the live check has to say, because a live check that
   * disagrees is by definition the stale one.
   */
  error?: string;
}

/**
 * The public page address, checked as it is typed.
 *
 * The check is ADVISORY. There is always a gap between an answer and a
 * submit, and another teacher can claim the address inside it — the 409 the
 * route answers with is the guard, and this only saves the round trip in the
 * common case.
 *
 * `pageSlugField` runs here first, so a reserved or malformed value is
 * reported with no request at all. It is the same validator the route parses
 * with, so the field cannot accept something the route then rejects.
 */
export function PageAddressField({ value, onChange, error }: PageAddressFieldProps) {
  const [answer, setAnswer] = useState<Answer | null>(null);

  // Both derived on render rather than stored: each is a pure function of
  // `value`, and a second copy in state is a second thing that can disagree
  // with it. Nothing here is a "checking" state, because nothing is drawn for
  // one — a spinner on every keystroke is motion this design does not have.
  const parsed = value === '' ? null : pageSlugField.safeParse(value);
  const localError = parsed && !parsed.success ? parsed.error.issues[0]?.message : undefined;
  const verdict = answer !== null && answer.slug === value ? answer.available : null;

  useEffect(() => {
    // An empty or malformed value is answered without a request at all. The
    // route would answer `available: false` for both, which reads as "someone
    // has it" when the truth is "this is not an address".
    if (value === '' || !pageSlugField.safeParse(value).success) return;

    let cancelled = false;
    const timer = setTimeout(async () => {
      let available: boolean | null;
      try {
        const res = await fetch(
          `/api/teachers/slug-available?slug=${encodeURIComponent(value)}`,
        );
        const json: { data?: { available?: boolean } } = res.ok ? await res.json() : {};
        available = res.ok ? json.data?.available === true : null;
      } catch {
        available = null;
      }
      if (!cancelled) setAnswer({ slug: value, available });
    }, DEBOUNCE_MS);

    // Every keystroke supersedes the check before it: the timer is cleared,
    // and `cancelled` silences a response that is already in flight.
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [value]);

  return (
    <div className="flex flex-col gap-2">
      <Input
        label="Page address"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        error={error ?? localError}
        placeholder="anna-devries"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
      />
      <p className="type-caption">
        Your booking page: fair.yoga/{value || 'your-name'}
      </p>
      {/* Silent unless there is something to say: a check still running, and
          one that failed, both draw nothing. An error outranks the verdict,
          because a verdict that disagrees with the server is the stale one. */}
      {!error && !localError && verdict === true && (
        <p role="status" className="type-caption text-teal flex items-center gap-1">
          <Icon name="check" size={14} />
          Available
        </p>
      )}
      {!error && !localError && verdict === false && (
        <p role="status" className="type-caption text-danger flex items-center gap-1">
          <Icon name="x" size={14} />
          That address is taken
        </p>
      )}
    </div>
  );
}
