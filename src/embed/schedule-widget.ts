/**
 * `<fair-yoga-schedule>`: a teacher's public schedule on their own website
 * (#916). This file runs on third-party pages, so it imports nothing, builds
 * every node with `textContent`, fetches without credentials and stores
 * nothing. `pnpm run build:embed` compiles it to `public/embed/v1.js`, which
 * appends the one line that defines the element; importing this module
 * defines nothing. Behaviour and copy: the spec's "The widget" section,
 * `docs/superpowers/specs/2026-10-30-share-your-schedule-design.md`.
 */

/** The widget's own copy of `PublicScheduleJson`; `schedule-widget.test.tsx` fails to compile if they drift. */
export type WidgetScheduleJson = {
  timezone: string;
  classes: {
    id: string;
    kind: 'class' | 'studio';
    start: string;
    durationMinutes: number;
    classType: string;
    location: { format: 'in_person' | 'online'; name: string | null };
    availability: 'open' | 'waitlist' | null;
    pricing: 'tiered' | 'donation' | null;
    bookingUrl: string | null;
  }[];
};

type WidgetClass = WidgetScheduleJson['classes'][number];

export type RenderOptions = {
  theme: 'themed' | 'unstyled';
  /** The `webcal://` feed link. */
  feedUrl: string;
  /** The fair.yoga origin the credit links to. */
  origin: string;
  /** Themed only; `auto` follows the visitor's `prefers-color-scheme`. Defaults to `light`. */
  colorScheme?: 'light' | 'dark' | 'auto';
};

const ELEMENT_NAME = 'fair-yoga-schedule';
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const KEY_PATTERN = /^[A-Za-z0-9_-]+$/;
const START_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const CSS = `
:host { display: block; }
.fy {
  --fy-a: var(--fy-accent, #1A5653);
  --fy-ink: #2D2D2D; --fy-muted: #71645A; --fy-card: #F0E9DC; --fy-line: #D4C9B8;
  --fy-wait: #7A6739; --fy-wait-line: #C4A96A; --fy-wait-bg: #F3ECDC;
  font-family: var(--fy-font, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
  font-size: 15px; line-height: 1.45; color: var(--fy-muted);
}
.fy[data-scheme="dark"] {
  --fy-a: var(--fy-accent, #8cc5c0);
  --fy-ink: #efe9df; --fy-muted: #b4aa9e; --fy-card: #28302f; --fy-line: #3a4544;
  --fy-wait: #d8c08a; --fy-wait-line: #d8c08a; --fy-wait-bg: transparent;
}
@media (prefers-color-scheme: dark) {
  .fy[data-scheme="auto"] {
    --fy-a: var(--fy-accent, #8cc5c0);
    --fy-ink: #efe9df; --fy-muted: #b4aa9e; --fy-card: #28302f; --fy-line: #3a4544;
    --fy-wait: #d8c08a; --fy-wait-line: #d8c08a; --fy-wait-bg: transparent;
  }
}
.fy ol { list-style: none; margin: 0; padding: 0; }
.fy-day-heading { font-family: Georgia, serif; font-weight: bold; color: var(--fy-ink); font-size: 15px; margin: 14px 0 6px; }
.fy-day:first-child .fy-day-heading { margin-top: 0; }
.fy-class { display: flex; align-items: center; gap: 12px; background: var(--fy-card); border: 1px solid var(--fy-line); border-radius: 14px; padding: 12px 14px; margin-bottom: 8px; }
.fy-class.fy-studio { background: transparent; border-style: dashed; }
.fy-time { font-variant-numeric: tabular-nums; color: var(--fy-a); font-weight: 600; width: 46px; flex: none; }
.fy-main { flex: 1; min-width: 0; }
.fy-type { display: block; color: var(--fy-ink); font-weight: 600; overflow-wrap: anywhere; }
.fy-meta { display: block; font-size: 12.5px; color: var(--fy-muted); overflow-wrap: anywhere; }
.fy-cta { flex: none; font-size: 13px; font-weight: 600; color: var(--fy-a); border: 1px solid var(--fy-a); border-radius: 10px; padding: 6px 10px; white-space: nowrap; text-decoration: none; }
.fy-cta.fy-wait { color: var(--fy-wait); border-color: var(--fy-wait-line); background: var(--fy-wait-bg); }
.fy-studio .fy-cta { border-style: dashed; }
.fy-cta:focus-visible, .fy-footer a:focus-visible { outline: 2px solid var(--fy-a); outline-offset: 2px; }
.fy-empty { margin: 0; color: var(--fy-muted); }
.fy-footer { display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: 4px 14px; margin: 10px 0 0; font-size: 11.5px; color: var(--fy-muted); }
.fy-footer a { color: inherit; }
.fy-credit { text-decoration: none; }
.fy-wordmark { font-family: Georgia, serif; font-size: 12.5px; }
.fy-dot { color: var(--fy-a); font-size: 15px; font-weight: bold; }
.fy-sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
`;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The URL itself when it may become a link here: https, or the widget's own origin (plain http in development). */
function linkable(url: string | null, origin: string): string | null {
  if (url === null) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol === 'https:' || parsed.origin === origin) return parsed.href;
  return null;
}

/** A link that opens in a new tab, tells a screen reader so, and hands the new page no opener or referrer. */
function newTabLink(href: string, className: string): HTMLAnchorElement {
  const a = el('a', className);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}

function appendNewTabNote(a: HTMLAnchorElement): void {
  a.append(el('span', 'fy-sr fy-new-tab', ' (opens in a new tab)'));
}

/**
 * "Tue 3 Nov" from the date part of `start`, which the server writes in the
 * teacher's zone. Read as a UTC calendar date, so the visitor's zone never
 * moves it.
 */
function dayHeading(start: string): string {
  const [y, m, d] = start.slice(0, 10).split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return `${WEEKDAYS[date.getUTCDay()]} ${d} ${MONTHS[m - 1]}`;
}

function metaLine(c: WidgetClass): string {
  const parts: string[] = [];
  if (c.location.format === 'online') parts.push('Online');
  else if (c.location.name) parts.push(c.kind === 'studio' ? `at ${c.location.name}` : c.location.name);
  parts.push(`${c.durationMinutes} min`);
  if (c.pricing === 'tiered') parts.push('Income-based');
  else if (c.pricing === 'donation') parts.push('Pay what you can');
  return parts.join(' · ');
}

function classRow(c: WidgetClass, origin: string): HTMLLIElement {
  const li = el('li', c.kind === 'studio' ? 'fy-class fy-studio' : 'fy-class');
  // The spaces keep the unstyled row readable as text; flex layout drops them in themed.
  li.append(el('span', 'fy-time', c.start.slice(11, 16)), ' ');
  const main = el('span', 'fy-main');
  main.append(el('span', 'fy-type', c.classType), ' ', el('span', 'fy-meta', metaLine(c)));
  li.append(main);

  const href = linkable(c.bookingUrl, origin);
  if (href !== null) {
    const waitlist = c.availability === 'waitlist';
    const a = newTabLink(href, waitlist ? 'fy-cta fy-wait' : 'fy-cta');
    const arrow = el('span', undefined, '↗');
    arrow.setAttribute('aria-hidden', 'true');
    a.append(waitlist ? 'Waitlist ' : 'Book ', arrow);
    appendNewTabNote(a);
    li.append(' ', a);
  }
  return li;
}

function footer(opts: RenderOptions): HTMLParagraphElement {
  const p = el('p', 'fy-footer');
  const credit = newTabLink(opts.origin, 'fy-credit');
  const mark = el('span', 'fy-wordmark');
  mark.append('fair', el('span', 'fy-dot', '.'), 'yoga');
  credit.append('Schedule by ', mark);
  appendNewTabNote(credit);

  const feed = el('a', 'fy-feed', 'Add this schedule to your calendar');
  feed.href = opts.feedUrl;
  p.append(credit, ' ', feed);
  return p;
}

/**
 * Replaces `root`'s children with the schedule. Built off-document first, so
 * a throw anywhere leaves `root` as it was.
 */
export function renderSchedule(root: ParentNode, data: WidgetScheduleJson, opts: RenderOptions): void {
  const frame = document.createDocumentFragment();
  let container: ParentNode = frame;
  if (opts.theme === 'themed') {
    const style = el('style');
    style.textContent = CSS;
    const wrap = el('div', 'fy');
    wrap.setAttribute('data-scheme', opts.colorScheme ?? 'light');
    frame.append(style, wrap);
    container = wrap;
  }

  if (data.classes.length === 0) {
    container.append(el('p', 'fy-empty', 'No upcoming classes right now.'));
  } else {
    const themed = opts.theme === 'themed';
    const schedule = el('ol', 'fy-schedule');
    // `list-style: none` costs a list its role in Safari; themed restores it. Unstyled leaves the host's CSS to decide.
    if (themed) schedule.setAttribute('role', 'list');
    let day: { date: string; list: HTMLOListElement } | null = null;
    for (const c of data.classes) {
      // Everything below slices `start` by position; a value without that shape throws, and the caller's catch keeps the fallback.
      if (!START_PATTERN.test(c.start)) throw new Error('Malformed start in schedule data');
      const date = c.start.slice(0, 10);
      if (day === null || day.date !== date) {
        const li = el('li', 'fy-day');
        const list = el('ol', 'fy-classes');
        if (themed) list.setAttribute('role', 'list');
        li.append(el('h3', 'fy-day-heading', dayHeading(c.start)), list);
        schedule.append(li);
        day = { date, list };
      }
      day.list.append(classRow(c, opts.origin));
    }
    container.append(schedule);
  }
  container.append(footer(opts));
  root.replaceChildren(frame);
}

function schemeOf(value: string | null): 'light' | 'dark' | 'auto' {
  return value === 'dark' || value === 'auto' ? value : 'light';
}

/**
 * Registers `<fair-yoga-schedule>` against `origin`. A second call, from the
 * script included twice on one page, finds the element registered and
 * returns, so `cache` only takes effect for the first call; an element can
 * also set its own `cache` property before it connects, which always wins.
 * `cache` is passed to `fetch` as given; unset, the browser's default applies.
 */
export function defineScheduleElement(opts: { origin: string; cache?: RequestCache }): void {
  if (customElements.get(ELEMENT_NAME)) return;
  const origin = opts.origin;

  class FairYogaSchedule extends HTMLElement {
    private started = false;
    /** Read at fetch time, so a preview can set it after the element is defined. */
    cache: RequestCache | undefined = opts.cache;

    connectedCallback(): void {
      if (this.started) return;
      const key = this.getAttribute('key');
      if (key === null || !KEY_PATTERN.test(key)) return;
      this.started = true;
      void this.load(key);
    }

    private async load(key: string): Promise<void> {
      const encoded = encodeURIComponent(key);
      let data: WidgetScheduleJson;
      try {
        const res = await fetch(`${origin}/api/public/v1/schedule/${encoded}`, {
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          ...(this.cache === undefined ? {} : { cache: this.cache }),
        });
        if (!res.ok) return;
        data = (await res.json()) as WidgetScheduleJson;
      } catch {
        // The snippet's own fallback link stays: a failure shows that, not an empty box.
        return;
      }

      const themed = this.getAttribute('theme') !== 'unstyled';
      const renderOpts: RenderOptions = {
        theme: themed ? 'themed' : 'unstyled',
        feedUrl: `webcal://${new URL(origin).host}/feed/${encoded}.ics`,
        origin,
        colorScheme: schemeOf(this.getAttribute('color-scheme')),
      };
      const target = themed ? document.createElement('div') : this;
      try {
        renderSchedule(target, data, renderOpts);
      } catch {
        // Malformed data renders nothing; the fallback link stays.
        return;
      }
      if (!themed) return;

      const shadow = this.shadowRoot ?? this.attachShadow({ mode: 'open' });
      shadow.replaceChildren(...target.childNodes);
      this.replaceChildren();
    }
  }

  customElements.define(ELEMENT_NAME, FairYogaSchedule);
}
