'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/sheet';
import { defineScheduleElement } from '@/embed/schedule-widget';
import { buildEmbedSnippet } from '@/lib/embed-snippet';
import { logRequestFailure, readErrorMessage } from '@/lib/client-errors';
import type { ScheduleShareState } from '@/services/schedule-share';

const ENDPOINT = '/api/account/schedule-share';
const WEEK_CHOICES = [1, 2, 3, 4] as const;
const STYLE_CHOICES = [
  { value: 'themed', label: 'fair.yoga' },
  { value: 'unstyled', label: 'Your site’s' },
] as const;
const COLOUR_CHOICES = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'auto', label: 'Auto' },
] as const;

type Theme = (typeof STYLE_CHOICES)[number]['value'];
type ColorScheme = (typeof COLOUR_CHOICES)[number]['value'];
type Pending = 'enable' | 'weeks' | 'studio' | 'disable' | 'reset';

const cardClass = 'bg-sand-soft border border-border rounded-card p-5 mb-4';
const codeClass = 'bg-cream border border-border rounded-field p-3 text-sm text-ink font-mono whitespace-pre-wrap break-all mb-3';

interface ShareScheduleProps {
  origin: string;
  slug: string;
  initial: ScheduleShareState;
}

function Segmented<T extends string | number>({
  label,
  options,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex border border-border rounded-pill overflow-hidden">
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onChange(o.value)}
            className={`min-h-11 px-4 type-label ${selected ? 'bg-teal-tint text-teal font-semibold' : 'bg-transparent text-brown hover:bg-sand'} disabled:opacity-50`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-3 border-t border-border first:border-t-0">
      <div>
        <div className="type-label text-ink">{label}</div>
        {hint && <div className="type-caption">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

/** Mounts a fresh `<fair-yoga-schedule>`; the element reads its attributes once at connect, so the parent re-keys it on every change. */
function LivePreview({ shareKey, origin, theme, colorScheme }: { shareKey: string; origin: string; theme: Theme; colorScheme: ColorScheme }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = host.current;
    if (node === null) return;
    defineScheduleElement({ origin });
    const element = document.createElement('fair-yoga-schedule');
    element.setAttribute('key', shareKey);
    element.setAttribute('theme', theme);
    if (theme === 'themed') element.setAttribute('color-scheme', colorScheme);
    node.replaceChildren(element);
    return () => node.replaceChildren();
  }, [shareKey, origin, theme, colorScheme]);

  const surface =
    theme === 'unstyled'
      ? 'bg-cream'
      : colorScheme === 'dark'
        ? 'bg-[#1f2423]'
        : colorScheme === 'auto'
          ? 'bg-[#fbfaf7] dark:bg-[#1f2423]'
          : 'bg-[#fbfaf7]';
  return <div ref={host} className={`${surface} border border-border rounded-field p-3 min-h-16`} />;
}

export function ShareSchedule({ origin, slug, initial }: ShareScheduleProps) {
  const [state, setState] = useState(initial);
  const [theme, setTheme] = useState<Theme>('themed');
  const [colorScheme, setColorScheme] = useState<ColorScheme>('light');
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState('');
  const [sheet, setSheet] = useState<'reset' | 'off' | null>(null);
  const [copied, setCopied] = useState<'code' | 'feed' | null>(null);

  async function send(action: Pending, url: string, method: string, body?: unknown): Promise<boolean> {
    setPending(action);
    setError('');
    try {
      const res = await fetch(url, {
        method,
        ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      });
      if (!res.ok) {
        setError(await readErrorMessage(res, 'Something went wrong. Please try again.'));
        return false;
      }
      const json: { data: ScheduleShareState } = await res.json();
      setState(json.data);
      return true;
    } catch (err) {
      logRequestFailure('share-schedule', { action }, err);
      setError('Network error. Please try again.');
      return false;
    } finally {
      setPending(null);
    }
  }

  async function copy(which: 'code' | 'feed', text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      setError('');
    } catch (err) {
      logRequestFailure('share-schedule', { action: 'copy' }, err);
      setError('Couldn’t copy. Select the text and copy it yourself.');
    }
  }

  if (state.key === null) {
    return (
      <div>
        <p className="type-body mb-5">
          Show your schedule on your own website, and let students subscribe to it in their calendar app. Visitors
          book here, on fair.yoga.
        </p>
        {error && <p role="alert" className="type-label text-danger mb-4">{error}</p>}
        <Button onClick={() => send('enable', ENDPOINT, 'POST')} disabled={pending !== null}>Turn on</Button>
      </div>
    );
  }

  const key = state.key;
  const snippet = buildEmbedSnippet({ origin, key, slug, theme, colorScheme });
  const feedUrl = `${origin}/feed/${key}.ics`;
  const busy = pending !== null;

  return (
    <div>
      <p className="type-body mb-5">
        Show your schedule on your own website. Visitors book here, on fair.yoga, in a new tab.
      </p>
      {error && <p role="alert" className="type-label text-danger mb-4">{error}</p>}

      <section className={cardClass}>
        <h2 className="type-subtitle">Your schedule</h2>
        <p className="type-caption mb-2">Saved for all your embeds and your calendar feed.</p>
        <Field label="Weeks ahead">
          <Segmented
            label="Weeks ahead"
            options={WEEK_CHOICES.map((w) => ({ value: w, label: String(w) }))}
            value={state.weeks}
            disabled={busy}
            onChange={(weeks) => void send('weeks', ENDPOINT, 'PATCH', { weeks })}
          />
        </Field>
        <Field label="Show studio classes" hint="Classes you teach for a studio">
          <button
            type="button"
            role="switch"
            aria-checked={state.includeStudio}
            aria-label="Show studio classes"
            disabled={busy}
            onClick={() => void send('studio', ENDPOINT, 'PATCH', { includeStudio: !state.includeStudio })}
            className={`relative h-8 w-14 shrink-0 rounded-pill border ${state.includeStudio ? 'bg-teal border-teal' : 'bg-sand border-border'} disabled:opacity-50`}
          >
            <span className={`absolute top-0.5 h-6 w-6 rounded-pill bg-cream ${state.includeStudio ? 'left-7' : 'left-0.5'}`} />
          </button>
        </Field>
      </section>

      <section className={cardClass}>
        <h2 className="type-subtitle">Look</h2>
        <p className="type-caption mb-2">Only changes the code below.</p>
        <Field label="Style">
          <Segmented label="Style" options={STYLE_CHOICES} value={theme} onChange={setTheme} />
        </Field>
        {theme === 'themed' && (
          <>
            <Field label="Colours">
              <Segmented label="Colours" options={COLOUR_CHOICES} value={colorScheme} onChange={setColorScheme} />
            </Field>
            <p className="type-caption">Auto follows the visitor’s dark mode. Pick it if your site does too.</p>
          </>
        )}
      </section>

      <section className={cardClass}>
        <h2 className="type-subtitle mb-2">Preview</h2>
        <LivePreview
          key={`${theme}-${colorScheme}-${state.weeks}-${state.includeStudio}-${key}`}
          shareKey={key}
          origin={origin}
          theme={theme}
          colorScheme={colorScheme}
        />
        {theme === 'unstyled' && <p className="type-caption mt-2">On your site this takes your own fonts and colours.</p>}
      </section>

      <section className={cardClass}>
        <h2 className="type-subtitle">Your code</h2>
        <p className="type-caption mb-2">Paste this where the schedule should appear. It updates as you change the options above.</p>
        <pre className={codeClass}>{snippet}</pre>
        <Button variant="secondary" onClick={() => void copy('code', snippet)}>
          {copied === 'code' ? 'Copied' : 'Copy code'}
        </Button>
      </section>

      <section className={cardClass}>
        <h2 className="type-subtitle">Calendar feed</h2>
        <p className="type-caption mb-2">
          Students can subscribe to this in their calendar app. Also works on site builders that block scripts.
        </p>
        <p className={codeClass}>{feedUrl}</p>
        <Button variant="secondary" onClick={() => void copy('feed', feedUrl)}>
          {copied === 'feed' ? 'Copied' : 'Copy link'}
        </Button>
      </section>

      <div className="flex flex-col gap-3 mt-6">
        <button type="button" onClick={() => setSheet('reset')} className="type-label text-danger text-left min-h-11">
          Reset embed key…
        </button>
        <p className="type-caption">
          Takes your schedule off sites you can’t edit anymore, like an old website or a page someone copied your code
          to. Your own site needs the new code afterwards, and the calendar feed link changes, so students who
          subscribed will need the new link.
        </p>
        <button type="button" onClick={() => setSheet('off')} className="type-label text-danger text-left min-h-11">
          Turn off sharing…
        </button>
      </div>

      {sheet === 'reset' && (
        <Sheet title="Reset embed key?" onClose={() => setSheet(null)} dismissible={!busy}>
          <p className="type-body mb-5">Students subscribed to your calendar feed will stop getting updates.</p>
          <div className="flex flex-col gap-3">
            <Button
              variant="destructive"
              disabled={busy}
              onClick={async () => { if (await send('reset', `${ENDPOINT}/reset`, 'POST')) setSheet(null); }}
            >
              Reset key
            </Button>
            <Button variant="ghost" autoFocus onClick={() => setSheet(null)} disabled={busy}>Cancel</Button>
          </div>
        </Sheet>
      )}

      {sheet === 'off' && (
        <Sheet title="Turn off sharing?" onClose={() => setSheet(null)} dismissible={!busy}>
          <ul className="type-body list-disc pl-5 mb-5 flex flex-col gap-2">
            <li>Your schedule disappears from every website where you pasted the code. Visitors see only a link to your fair.yoga page.</li>
            <li>Students subscribed to your calendar feed stop getting updates.</li>
            <li>If you turn sharing on again, you get new code and a new feed link — the old ones won’t come back.</li>
          </ul>
          <div className="flex flex-col gap-3">
            <Button autoFocus onClick={() => setSheet(null)} disabled={busy}>Keep sharing</Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={async () => { if (await send('disable', ENDPOINT, 'DELETE')) setSheet(null); }}
            >
              Turn off
            </Button>
          </div>
        </Sheet>
      )}
    </div>
  );
}
