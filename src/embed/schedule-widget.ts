/**
 * `<fair-yoga-schedule>`: a teacher's public schedule on their own website
 * (#916). This file runs on third-party pages, so it imports nothing, builds
 * every node with `textContent`, fetches without credentials and stores
 * nothing. `pnpm run build:embed` compiles it to `public/embed/v1.js`, which
 * appends the one line that defines the element; importing this module
 * defines nothing. Behaviour and copy: the spec's "The widget" section,
 * `docs/superpowers/specs/2026-10-30-share-your-schedule-design.md`.
 */

/** The widget's own copy of `PublicScheduleJson`: it imports nothing, so the type is restated, and it must stay assignable both ways to the server's. */
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
  /** Renders only the first `limit` classes; anything but a positive integer renders them all. */
  limit?: number;
};

export type ScheduleLoadEventName = 'fair-yoga-schedule:load';
export type ScheduleErrorEventName = 'fair-yoga-schedule:error';

/** `count` is the number of classes rendered, after any `limit`. */
export type ScheduleLoadDetail = { count: number };

export type ScheduleErrorDetail =
  | { reason: 'invalid-key' | 'network' | 'data' }
  | { reason: 'http'; status: number };

/** What the element dispatches on itself, bubbling and composed, for `addEventListener` on the element or any ancestor. */
export type ScheduleEventMap = Record<ScheduleLoadEventName, CustomEvent<ScheduleLoadDetail>> &
  Record<ScheduleErrorEventName, CustomEvent<ScheduleErrorDetail>>;

/** The element's `data-state` attribute. */
export type ScheduleState = 'loading' | 'ready' | 'error';

const ELEMENT_NAME = 'fair-yoga-schedule';
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const KEY_PATTERN = /^[A-Za-z0-9_-]+$/;
const START_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LIMIT_PATTERN = /^[1-9]\d*$/;
const LOAD_EVENT: ScheduleLoadEventName = 'fair-yoga-schedule:load';
const ERROR_EVENT: ScheduleErrorEventName = 'fair-yoga-schedule:error';

/** Visually hidden, still read aloud. Applied inline as well as by `.fy-sr`, so unstyled mode hides it too. */
const SR_ONLY =
  'position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;';

/** Themed only: reserves room while the schedule loads, so the host page does not jump when it arrives. */
const HOST_CSS = `
:host { display: block; }
:host([data-state="loading"]) { min-height: 6rem; }
`;

const CSS = `${HOST_CSS}
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
.fy-time { font-variant-numeric: tabular-nums; color: var(--fy-a); font-weight: 600; white-space: nowrap; flex: none; }
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
.fy-sr { ${SR_ONLY} }
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

/** A link that opens in a new tab and hands the new page no opener or referrer; callers add `appendNewTabNote`. */
function newTabLink(href: string, className: string): HTMLAnchorElement {
  const a = el('a', className);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}

function appendNewTabNote(a: HTMLAnchorElement): void {
  const note = el('span', 'fy-sr fy-new-tab', ' (opens in a new tab)');
  // Through the CSSOM rather than a `style` attribute, which a host's CSP may refuse.
  note.style.cssText = SR_ONLY;
  a.append(note);
}

/**
 * "Tue 3 Nov" from the date part of `start`. Read as a UTC calendar date, so
 * the visitor's zone never moves it.
 */
function dayHeading(start: string): string {
  const [y, m, d] = start.slice(0, 10).split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return `${WEEKDAYS[date.getUTCDay()]} ${d} ${MONTHS[m - 1]}`;
}

/**
 * "18:00 – 19:15", spaced with no-break spaces so the range never wraps: the
 * start's wall-clock time plus the duration, by string
 * arithmetic on `start`, so the visitor's zone never moves it. Past midnight
 * it shows the clock time.
 */
function timeRange(c: WidgetClass): string {
  const start = c.start.slice(11, 16);
  const minutes = Number(start.slice(0, 2)) * 60 + Number(start.slice(3, 5)) + c.durationMinutes;
  if (!Number.isFinite(minutes)) throw new Error('Malformed duration in schedule data');
  const end = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${start}\u00a0–\u00a0${pad(Math.floor(end / 60))}:${pad(end % 60)}`;
}

const PRICING_HOOK = { tiered: 'income-based', donation: 'pay-what-you-can' } as const satisfies Record<
  NonNullable<WidgetClass['pricing']>,
  string
>;

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
  li.setAttribute('data-kind', c.kind);
  if (c.kind === 'class') {
    if (c.availability !== null) li.setAttribute('data-availability', c.availability);
    if (c.pricing !== null) li.setAttribute('data-pricing', PRICING_HOOK[c.pricing]);
  }
  const time = el('time', undefined, timeRange(c));
  time.dateTime = c.start;
  const timeCell = el('span', 'fy-time');
  timeCell.append(time);
  // The spaces keep the unstyled row readable as text; flex layout drops them in themed.
  li.append(timeCell, ' ');
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
 * Replaces `root`'s children with the schedule and returns how many classes
 * it rendered. Built off-document first, so a throw anywhere leaves `root` as
 * it was.
 */
export function renderSchedule(root: ParentNode, data: WidgetScheduleJson, opts: RenderOptions): number {
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

  const limit = opts.limit;
  const capped = limit !== undefined && Number.isInteger(limit) && limit > 0;
  const shown = capped ? data.classes.slice(0, limit) : data.classes;
  if (data.classes.length === 0) {
    container.append(el('p', 'fy-empty', 'No upcoming classes right now.'));
  } else {
    const themed = opts.theme === 'themed';
    const schedule = el('ol', 'fy-schedule');
    // `list-style: none` costs a list its role in Safari; themed restores it. Unstyled leaves the host's CSS to decide.
    if (themed) schedule.setAttribute('role', 'list');
    let day: { date: string; list: HTMLOListElement } | null = null;
    // A day heading is only made when a class is appended under it, so a day the cap empties never appears.
    for (const c of shown) {
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
  return shown.length;
}

function schemeOf(value: string | null): 'light' | 'dark' | 'auto' {
  return value === 'dark' || value === 'auto' ? value : 'light';
}

function limitOf(value: string | null): number | undefined {
  return value !== null && LIMIT_PATTERN.test(value) ? Number(value) : undefined;
}

function validKey(value: string | null): value is string {
  return value !== null && KEY_PATTERN.test(value);
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
    static observedAttributes = ['schedule-key'];

    private started = false;
    /** The key of the latest load started. */
    private key: string | null = null;
    /** Bumped by every load; a response whose load is no longer the latest renders nothing. */
    private loads = 0;
    /** Read at fetch time, so a caller can set it after the element is defined. */
    cache: RequestCache | undefined = opts.cache;

    connectedCallback(): void {
      const key = this.getAttribute('schedule-key');
      if (!this.started) {
        this.started = true;
        this.begin(key);
      } else if (validKey(key) && key !== this.key) {
        this.begin(key);
      }
    }

    attributeChangedCallback(_name: string, _old: string | null, value: string | null): void {
      if (!this.started || !this.isConnected) return;
      if (value !== this.key) this.begin(value);
    }

    private begin(key: string | null): void {
      const load = ++this.loads;
      this.key = key;
      if (!validKey(key)) {
        this.setAttribute('data-state', 'error');
        // Deferred, so a listener added just after the element is inserted still hears it.
        queueMicrotask(() => {
          if (load === this.loads) this.fail({ reason: 'invalid-key' });
        });
        return;
      }
      this.setAttribute('data-state', 'loading');
      void this.load(key, load);
    }

    private fail(detail: ScheduleErrorDetail): void {
      this.setAttribute('data-state', 'error');
      this.dispatchEvent(new CustomEvent(ERROR_EVENT, { detail, bubbles: true, composed: true }));
    }

    private async load(key: string, load: number): Promise<void> {
      const themed = this.getAttribute('theme') !== 'unstyled';
      if (themed && this.shadowRoot === null) {
        // Until the schedule arrives the shadow root holds only the loading reservation and a slot, so the snippet's fallback stays visible.
        const style = el('style');
        style.textContent = HOST_CSS;
        this.attachShadow({ mode: 'open' }).replaceChildren(style, el('slot'));
      } else if (!themed && this.shadowRoot !== null) {
        // An earlier themed load left a shadow root; a slot shows the light DOM the unstyled render writes to.
        this.shadowRoot.replaceChildren(el('slot'));
      }

      const encoded = encodeURIComponent(key);
      let data: WidgetScheduleJson;
      try {
        let res: Response;
        try {
          res = await fetch(`${origin}/api/public/v1/schedule/${encoded}`, {
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
            ...(this.cache === undefined ? {} : { cache: this.cache }),
          });
        } catch {
          if (load === this.loads) this.fail({ reason: 'network' });
          return;
        }
        if (load !== this.loads) return;
        if (!res.ok) {
          this.fail({ reason: 'http', status: res.status });
          return;
        }
        data = (await res.json()) as WidgetScheduleJson;
      } catch {
        // The snippet's own fallback link stays: a failure shows that, not an empty box.
        if (load === this.loads) this.fail({ reason: 'data' });
        return;
      }
      if (load !== this.loads) return;

      const renderOpts: RenderOptions = {
        theme: themed ? 'themed' : 'unstyled',
        feedUrl: `webcal://${new URL(origin).host}/feed/${encoded}.ics`,
        origin,
        colorScheme: schemeOf(this.getAttribute('color-scheme')),
        limit: limitOf(this.getAttribute('limit')),
      };
      const target = themed ? document.createElement('div') : this;
      let count: number;
      try {
        count = renderSchedule(target, data, renderOpts);
      } catch {
        // Malformed data renders nothing; the fallback link stays.
        this.fail({ reason: 'data' });
        return;
      }
      if (themed && this.shadowRoot !== null) {
        this.shadowRoot.replaceChildren(...target.childNodes);
        this.replaceChildren();
      }
      this.setAttribute('data-state', 'ready');
      const detail: ScheduleLoadDetail = { count };
      this.dispatchEvent(new CustomEvent(LOAD_EVENT, { detail, bubbles: true, composed: true }));
    }
  }

  customElements.define(ELEMENT_NAME, FairYogaSchedule);
}
