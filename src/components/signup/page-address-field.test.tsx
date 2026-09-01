import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { act, useState } from 'react';
import { PageAddressField, slugFromName } from './page-address-field';

describe('slugFromName', () => {
  it('lowercases and hyphenates', () => {
    expect(slugFromName('Anna', 'de Vries')).toBe('anna-devries');
  });

  it('strips punctuation', () => {
    expect(slugFromName('Siobhán', "O'Malley")).toBe('siobhan-omalley');
  });

  // CLAUDE.md commits to international from day one. A name that derives
  // to nothing must leave the field empty for the teacher to fill — never
  // block, never emit a placeholder.
  it('returns empty for a name with no Latin characters', () => {
    expect(slugFromName('小林', '綾')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// The live availability check
// ---------------------------------------------------------------------------

/** A fetch the test decides the outcome of, and when. */
interface PendingCall {
  slug: string;
  settle: (response: unknown) => void;
}

/**
 * Every request is left HANGING until a test settles it by hand. The whole
 * point of this component is what it does in the window between asking and
 * being answered, and an auto-resolving stub closes that window before an
 * assertion can look into it.
 */
function stubFetch(): PendingCall[] {
  const calls: PendingCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => {
      const url = new URL(String(input), 'http://localhost');
      return new Promise((resolve) => {
        calls.push({ slug: url.searchParams.get('slug') ?? '', settle: resolve });
      });
    }),
  );
  return calls;
}

/** `respondOk({ available })` — the envelope `api-utils.ts` actually sends. */
const answered = (available: boolean) => ({
  ok: true,
  json: async () => ({ data: { available } }),
});

/** A 429 from the endpoint's rate limit, or anything else that is not a 200. */
const refused = () => ({ ok: false, json: async () => ({}) });

function advance(ms: number) {
  return act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

/** `noUncheckedIndexedAccess` is on, so an absent request is a thrown error
 *  naming the index rather than a `possibly undefined` at every call site. */
function settle(call: PendingCall | undefined, response: unknown) {
  if (call === undefined) throw new Error('no such request was made');
  return act(async () => {
    call.settle(response);
    // The component awaits twice — the response, then `.json()` — so the
    // render it triggers is two microtask ticks downstream of this line.
    await Promise.resolve();
    await Promise.resolve();
  });
}

function typeAddress(value: string) {
  fireEvent.change(screen.getByLabelText('Page address'), { target: { value } });
}

/** The field is controlled, so the test needs something to hold its value. */
function Harness({ error }: { error?: string } = {}) {
  const [value, setValue] = useState('');
  return <PageAddressField value={value} onChange={setValue} error={error} />;
}

describe('PageAddressField', () => {
  beforeEach(() => {
    // Only the debounce timer is faked. Faking `Date` or the microtask queue
    // would interfere with the promise chain these tests settle by hand.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('asks nothing until the debounce has elapsed', async () => {
    const calls = stubFetch();
    render(<Harness />);

    typeAddress('anna-devries');
    await advance(399);
    expect(calls).toHaveLength(0);

    await advance(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.slug).toBe('anna-devries');
  });

  it('asks once for a burst of keystrokes, about the last value only', async () => {
    const calls = stubFetch();
    render(<Harness />);

    typeAddress('ann');
    await advance(200);
    typeAddress('anna');
    await advance(200);
    typeAddress('annak');
    await advance(400);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.slug).toBe('annak');
  });

  it('reports a free address', async () => {
    const calls = stubFetch();
    render(<Harness />);

    typeAddress('anna-devries');
    await advance(400);
    await settle(calls[0], answered(true));

    expect(screen.getByText('Available')).toBeInTheDocument();
  });

  it('reports a taken address', async () => {
    const calls = stubFetch();
    render(<Harness />);

    typeAddress('anna-devries');
    await advance(400);
    await settle(calls[0], answered(false));

    expect(screen.getByText('That address is taken')).toBeInTheDocument();
  });

  // `pageSlugField` is the same validator the route parses with, so running it
  // here is not a guess about what the server would say — it is the answer.
  it('rejects a reserved address without asking the server', async () => {
    const calls = stubFetch();
    render(<Harness />);

    typeAddress('settings');
    await advance(400);

    expect(calls).toHaveLength(0);
    expect(screen.getByRole('alert')).toHaveTextContent('This slug is reserved');
  });

  it('rejects a malformed address without asking the server', async () => {
    const calls = stubFetch();
    render(<Harness />);

    typeAddress('Anna Smith');
    await advance(400);

    expect(calls).toHaveLength(0);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Slug must be lowercase alphanumeric with hyphens',
    );
  });

  // Silence, not a guess. A wrong "Available" is worse than nothing, because
  // the submit is where the answer actually binds.
  it('says nothing when the check could not be completed', async () => {
    const calls = stubFetch();
    render(<Harness />);

    typeAddress('anna-devries');
    await advance(400);
    await settle(calls[0], refused());

    expect(screen.queryByText('Available')).toBeNull();
    expect(screen.queryByText('That address is taken')).toBeNull();
  });

  /**
   * What `Answer`'s slug key is actually for, and the commonest case by far:
   * the gap between a keystroke and the answer about it. A verdict on screen
   * is about the address that was checked, not the one in the field, and those
   * stop agreeing the moment anyone types.
   *
   * Pins the key specifically. Verified by mutation: dropping
   * `answer.slug === value` leaves "Available" on screen for `alphax`, an
   * address nothing has ever asked about, and reddens this test. The race
   * test below does NOT catch that — `cancelled` gets there first — which is
   * why both exist.
   */
  it('stops vouching for an address the moment the field changes', async () => {
    const calls = stubFetch();
    render(<Harness />);

    typeAddress('alpha');
    await advance(400);
    await settle(calls[0], answered(true));
    expect(screen.getByText('Available')).toBeInTheDocument();

    // One more keystroke. Nothing has been asked about `alphax` yet, so there
    // is nothing to say about it.
    typeAddress('alphax');
    expect(screen.queryByText('Available')).toBeNull();
  });

  /**
   * The stale-response race: a reply that arrives after the field moved on.
   *
   * Pins the `cancelled` flag. Verified by mutation: dropping it lets the late
   * `alpha` answer overwrite `beta`'s in state, where its slug no longer
   * matches the field — so the keyed check renders nothing at all and the
   * SECOND assertion (beta's own verdict, silently clobbered) is what reddens.
   */
  it('never renders an answer about an address the field has moved on from', async () => {
    const calls = stubFetch();
    render(<Harness />);

    typeAddress('alpha');
    await advance(400);
    expect(calls).toHaveLength(1);

    // The teacher keeps typing while the first request is still in flight.
    typeAddress('beta');
    await advance(400);
    expect(calls).toHaveLength(2);

    await settle(calls[1], answered(false));
    expect(screen.getByText('That address is taken')).toBeInTheDocument();

    // `alpha` finally answers, and says something different. It is about an
    // address that is no longer in the field.
    await settle(calls[0], answered(true));
    expect(screen.queryByText('Available')).toBeNull();
    expect(screen.getByText('That address is taken')).toBeInTheDocument();
  });

  // A verdict that disagrees with the server is by definition the stale one:
  // the 409 at submit is the guard, this check is only advice.
  it('lets a server rejection outrank a live verdict', async () => {
    const calls = stubFetch();
    render(<Harness error="That address is taken — please pick another." />);

    typeAddress('anna-devries');
    await advance(400);
    await settle(calls[0], answered(true));

    expect(screen.queryByText('Available')).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'That address is taken — please pick another.',
    );
  });
});
