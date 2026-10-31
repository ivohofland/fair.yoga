import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { waitFor } from '@testing-library/react';
import type { PublicScheduleJson } from '@/lib/public-schedule-json';
import {
  defineScheduleElement,
  renderSchedule,
  type RenderOptions,
  type ScheduleErrorDetail,
  type ScheduleEventMap,
  type ScheduleLoadDetail,
  type WidgetScheduleJson,
} from './schedule-widget';

// Compile-time tie: the widget cannot import, so it declares its own copy of
// the v1 shape. Each direction fails `tsc` if the two drift apart.
const toWidget = (x: PublicScheduleJson): WidgetScheduleJson => x;
const toPublic = (x: WidgetScheduleJson): PublicScheduleJson => x;
void toWidget;
void toPublic;

const ORIGIN = 'https://fair.example';
const FEED = 'webcal://fair.example/feed/k123.ics';
const XSS = '<img src=x onerror=alert(1)>';

type Row = PublicScheduleJson['classes'][number];

function row(over: Partial<Row>): Row {
  return {
    id: 'c1',
    kind: 'class',
    start: '2026-11-03T19:00:00+01:00',
    durationMinutes: 75,
    classType: 'Vinyasa',
    location: { format: 'in_person', name: 'De Pijp' },
    availability: 'open',
    pricing: 'tiered',
    bookingUrl: `${ORIGIN}/anna/book/c1`,
    ...over,
  };
}

const DATA: PublicScheduleJson = {
  timezone: 'Europe/Amsterdam',
  classes: [
    row({}),
    row({
      id: 'c2',
      start: '2026-11-04T09:00:00+01:00',
      durationMinutes: 60,
      classType: 'Yin',
      location: { format: 'online', name: null },
      availability: 'waitlist',
      pricing: 'donation',
      bookingUrl: `${ORIGIN}/anna/book/c2`,
    }),
    row({
      id: 's1',
      kind: 'studio',
      start: '2026-11-05T19:00:00+01:00',
      durationMinutes: 60,
      classType: 'Hatha',
      location: { format: 'in_person', name: 'Studio Zuid' },
      availability: null,
      pricing: null,
      bookingUrl: 'https://studiozuid.example/book',
    }),
    row({
      id: 's2',
      kind: 'studio',
      start: '2026-11-05T20:30:00+01:00',
      durationMinutes: 60,
      classType: 'Restorative',
      location: { format: 'in_person', name: 'Yoga West' },
      availability: null,
      pricing: null,
      bookingUrl: null,
    }),
  ],
};

const THEMES = ['themed', 'unstyled'] as const;

function rendered(
  theme: 'themed' | 'unstyled',
  data: PublicScheduleJson = DATA,
  extra: Partial<RenderOptions> = {},
): HTMLElement {
  const root = document.createElement('div');
  document.body.append(root);
  renderSchedule(root, data, { theme, feedUrl: FEED, origin: ORIGIN, ...extra });
  return root;
}

function classRows(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('li.fy-class')];
}

function rowOf(root: ParentNode, classType: string): HTMLElement {
  const found = classRows(root).find((li) => li.querySelector('.fy-type')?.textContent === classType);
  if (!found) throw new Error(`no row for ${classType}`);
  return found;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe.each(THEMES)('renderSchedule (%s)', (theme) => {
  it('shows each row: time, class type, location, duration and pricing label', () => {
    const root = rendered(theme);
    expect(classRows(root)).toHaveLength(4);
    const vinyasa = rowOf(root, 'Vinyasa');
    expect(vinyasa.querySelector('.fy-time')?.textContent).toBe('19:00\u00a0–\u00a020:15');
    expect(vinyasa.querySelector('.fy-meta')?.textContent).toBe('De Pijp · 75 min · Income-based');
    expect(rowOf(root, 'Yin').querySelector('.fy-meta')?.textContent).toBe('Online · 60 min · Pay what you can');
    expect(rowOf(root, 'Hatha').querySelector('.fy-meta')?.textContent).toBe('at Studio Zuid · 60 min');
  });

  it('groups rows under day headings in an ordered list', () => {
    const root = rendered(theme);
    const schedule = root.querySelector('ol.fy-schedule');
    expect(schedule).not.toBeNull();
    const headings = [...root.querySelectorAll('.fy-day-heading')].map((h) => h.textContent);
    expect(headings).toEqual(['Tue 3 Nov', 'Wed 4 Nov', 'Thu 5 Nov']);
  });

  it('links Book ↗ for an open class and Waitlist ↗ for a full one', () => {
    const root = rendered(theme);
    const book = rowOf(root, 'Vinyasa').querySelector('a');
    expect(book?.textContent).toContain('Book ↗');
    expect(book?.getAttribute('href')).toBe(`${ORIGIN}/anna/book/c1`);
    const wait = rowOf(root, 'Yin').querySelector('a');
    expect(wait?.textContent).toContain('Waitlist ↗');
  });

  it('links a studio class only when it has a booking page', () => {
    const root = rendered(theme);
    const hatha = rowOf(root, 'Hatha').querySelector('a');
    expect(hatha?.textContent).toContain('Book ↗');
    expect(hatha?.getAttribute('href')).toBe('https://studiozuid.example/book');
    expect(rowOf(root, 'Restorative').querySelector('a')).toBeNull();
  });

  it('opens every row link in a new tab, without an opener, and says so', () => {
    const root = rendered(theme);
    const links = classRows(root).flatMap((li) => [...li.querySelectorAll('a')]);
    expect(links).toHaveLength(3);
    for (const a of links) {
      expect(a.getAttribute('target')).toBe('_blank');
      expect(a.getAttribute('rel')).toContain('noopener');
      expect(a.getAttribute('rel')).toContain('noreferrer');
      expect(a.textContent).toContain('(opens in a new tab)');
    }
  });

  it('links nothing whose scheme is not https', () => {
    const root = rendered(theme, {
      timezone: 'UTC',
      classes: [
        row({ id: 'x1', kind: 'studio', classType: 'Js', availability: null, pricing: null, bookingUrl: 'javascript:alert(1)' }),
        row({ id: 'x2', kind: 'studio', classType: 'Plain', availability: null, pricing: null, bookingUrl: 'http://studio.example/' }),
        row({ id: 'x3', kind: 'studio', classType: 'Junk', availability: null, pricing: null, bookingUrl: 'not a url' }),
      ],
    });
    expect(classRows(root)).toHaveLength(3);
    expect(root.querySelectorAll('li.fy-class a')).toHaveLength(0);
    expect(root.querySelector('a[href^="javascript"]')).toBeNull();
  });

  it('renders text that looks like HTML as literal text', () => {
    const root = rendered(theme, {
      timezone: 'UTC',
      classes: [row({ classType: XSS, location: { format: 'in_person', name: XSS } })],
    });
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('.fy-type')?.textContent).toBe(XSS);
    expect(root.querySelector('.fy-meta')?.textContent).toContain(XSS);
  });

  it('says so in one line when there are no classes', () => {
    const root = rendered(theme, { timezone: 'UTC', classes: [] });
    expect(root.textContent).toContain('No upcoming classes right now.');
    expect(root.querySelector('ol.fy-schedule')).toBeNull();
  });

  it('marks each row with its kind, availability and pricing, and its start in a <time>', () => {
    const root = rendered(theme);
    const vinyasa = rowOf(root, 'Vinyasa');
    expect(vinyasa.dataset).toMatchObject({ kind: 'class', availability: 'open', pricing: 'income-based' });
    expect(vinyasa.querySelector('time')?.getAttribute('datetime')).toBe('2026-11-03T19:00:00+01:00');
    expect(rowOf(root, 'Yin').dataset).toMatchObject({ kind: 'class', availability: 'waitlist', pricing: 'pay-what-you-can' });

    const hatha = rowOf(root, 'Hatha');
    expect(hatha.getAttribute('data-kind')).toBe('studio');
    expect(hatha.hasAttribute('data-availability')).toBe(false);
    expect(hatha.hasAttribute('data-pricing')).toBe(false);
    expect(hatha.querySelector('time')?.getAttribute('datetime')).toBe('2026-11-05T19:00:00+01:00');
    expect(hatha).toHaveClass('fy-class', 'fy-studio');
  });

  it('shows the end time from the start\'s wall clock, past midnight too', () => {
    const root = rendered(theme, {
      timezone: 'Europe/Amsterdam',
      classes: [
        row({ id: 'a', classType: 'Evening', start: '2026-11-03T18:00:00+01:00', durationMinutes: 75 }),
        row({ id: 'b', classType: 'Late', start: '2026-11-03T23:30:00+01:00', durationMinutes: 75 }),
      ],
    });
    expect(rowOf(root, 'Evening').querySelector('.fy-time')?.textContent).toBe('18:00\u00a0–\u00a019:15');
    const late = rowOf(root, 'Late');
    expect(late.querySelector('.fy-time')?.textContent).toBe('23:30\u00a0–\u00a000:45');
    expect(late.querySelector('time')?.getAttribute('datetime')).toBe('2026-11-03T23:30:00+01:00');
    expect(late.querySelector('.fy-meta')?.textContent).toContain('75 min');
  });

  it('limit="2" renders the first two classes, and no heading for a day the cap empties', () => {
    const root = rendered(theme, DATA, { limit: 2 });
    expect(classRows(root).map((li) => li.querySelector('.fy-type')?.textContent)).toEqual(['Vinyasa', 'Yin']);
    const headings = [...root.querySelectorAll('.fy-day-heading')].map((h) => h.textContent);
    expect(headings).toEqual(['Tue 3 Nov', 'Wed 4 Nov']);
    expect(root.textContent).not.toContain('No upcoming classes right now.');
  });

  it.each([0, -1, 1.5, Number.NaN])('limit %s renders every class', (limit) => {
    expect(classRows(rendered(theme, DATA, { limit }))).toHaveLength(4);
  });

  it('ends with the fair.yoga credit and the calendar link', () => {
    const root = rendered(theme);
    const footer = root.querySelector('.fy-footer');
    expect(footer?.textContent).toContain('Schedule by fair.yoga');
    const links = [...(footer?.querySelectorAll('a') ?? [])];
    const credit = links.find((a) => a.textContent?.includes('fair.yoga'));
    expect(credit?.getAttribute('href')).toBe(ORIGIN);
    expect(credit?.getAttribute('rel')).toContain('noopener');
    const feed = links.find((a) => a.textContent === 'Add this schedule to your calendar');
    expect(feed?.getAttribute('href')).toBe(FEED);
  });
});

describe('renderSchedule styling', () => {
  it('themed carries its own stylesheet; unstyled adds none', () => {
    expect(rendered('themed').querySelector('style')).not.toBeNull();
    expect(rendered('unstyled').querySelector('style')).toBeNull();
  });

  it.each(THEMES)('%s hides the new-tab note visually with an inline style, and keeps its text', (theme) => {
    const notes = [...rendered(theme).querySelectorAll<HTMLElement>('.fy-new-tab')];
    expect(notes.length).toBeGreaterThan(0);
    for (const span of notes) {
      expect(span).toHaveClass('fy-sr');
      expect(span.getAttribute('style')).toContain('clip');
      expect(span.style.position).toBe('absolute');
      expect(span.textContent).toBe(' (opens in a new tab)');
    }
  });

  it('themed lists keep their list role; unstyled lists carry none of ours', () => {
    const themed = rendered('themed');
    const lists = [...themed.querySelectorAll('ol')];
    expect(lists.length).toBeGreaterThan(1);
    for (const ol of lists) expect(ol.getAttribute('role')).toBe('list');
    for (const ol of rendered('unstyled').querySelectorAll('ol')) expect(ol.hasAttribute('role')).toBe(false);
  });

  it('themed defaults to the light scheme', () => {
    expect(rendered('themed').querySelector('.fy')?.getAttribute('data-scheme')).toBe('light');
  });
});

describe('the own-origin exception to https-only links', () => {
  const HTTP_ORIGIN = 'http://fair.example';

  function linkFor(bookingUrl: string): HTMLAnchorElement | null {
    const root = document.createElement('div');
    renderSchedule(
      root,
      { timezone: 'UTC', classes: [row({ bookingUrl })] },
      { theme: 'unstyled', feedUrl: FEED, origin: HTTP_ORIGIN },
    );
    return root.querySelector('li.fy-class a');
  }

  it('links a plain-http URL on the widget origin', () => {
    expect(linkFor('http://fair.example/x/book/1')?.getAttribute('href')).toBe('http://fair.example/x/book/1');
  });

  it.each(['http://fair.example.evil/', 'http://fair.example:8080/'])('does not link %s', (url) => {
    expect(linkFor(url)).toBeNull();
  });
});

describe('day grouping follows the teacher, not the visitor', () => {
  const ORIGINAL_TZ = process.env.TZ;
  afterEach(() => {
    process.env.TZ = ORIGINAL_TZ;
  });

  // 23:30 at +01:00 is the next day east of UTC+0:30; 00:30 at +01:00 is the
  // previous day anywhere west of UTC+1. Each zone below moves one of them.
  const late = row({ id: 'late', classType: 'Late', start: '2026-11-03T23:30:00+01:00' });
  const early = row({ id: 'early', classType: 'Early', start: '2026-11-05T00:30:00+01:00' });

  it.each(['Pacific/Kiritimati', 'America/Los_Angeles', 'UTC'])('in %s', (zone) => {
    process.env.TZ = zone;
    const root = rendered('unstyled', { timezone: 'Europe/Amsterdam', classes: [late, early] });
    const days = [...root.querySelectorAll('li.fy-day')].map((d) => ({
      heading: d.querySelector('.fy-day-heading')?.textContent,
      rows: [...d.querySelectorAll('.fy-type')].map((t) => t.textContent),
      times: [...d.querySelectorAll('.fy-time')].map((t) => t.textContent),
    }));
    expect(days).toEqual([
      { heading: 'Tue 3 Nov', rows: ['Late'], times: ['23:30\u00a0–\u00a000:45'] },
      { heading: 'Thu 5 Nov', rows: ['Early'], times: ['00:30\u00a0–\u00a001:45'] },
    ]);
  });
});

describe('<fair-yoga-schedule>', () => {
  const fetchMock = vi.fn<typeof fetch>();

  function ok(data: PublicScheduleJson): Response {
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  function mount(attrs: Record<string, string>): HTMLElement {
    const el = document.createElement('fair-yoga-schedule');
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    const fallback = document.createElement('a');
    fallback.href = `${ORIGIN}/anna`;
    fallback.textContent = 'See my schedule';
    el.append(fallback);
    document.body.append(el);
    return el;
  }

  function surface(el: HTMLElement): ParentNode {
    return el.shadowRoot ?? el;
  }

  /** The snippet's link is still the light DOM's, and nothing of ours covers it: no shadow root, or one that only slots it. */
  function expectFallback(el: HTMLElement): void {
    expect(el.querySelector('a')?.textContent).toBe('See my schedule');
    if (el.shadowRoot !== null) {
      expect(el.shadowRoot.querySelector('slot')).not.toBeNull();
      expect(el.shadowRoot.querySelector('.fy')).toBeNull();
    }
  }

  type Heard = { load: ScheduleLoadDetail[]; error: ScheduleErrorDetail[]; bubbles: boolean[]; composed: boolean[] };

  /** Mounts with listeners added before the element connects. */
  function mountHeard(attrs: Record<string, string>): { el: HTMLElement; heard: Heard } {
    const el = document.createElement('fair-yoga-schedule');
    const heard: Heard = { load: [], error: [], bubbles: [], composed: [] };
    const on = <K extends keyof ScheduleEventMap>(name: K, push: (e: ScheduleEventMap[K]) => void): void =>
      el.addEventListener(name, (e) => {
        heard.bubbles.push(e.bubbles);
        heard.composed.push(e.composed);
        push(e as ScheduleEventMap[K]);
      });
    on('fair-yoga-schedule:load', (e) => heard.load.push(e.detail));
    on('fair-yoga-schedule:error', (e) => heard.error.push(e.detail));
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    const fallback = document.createElement('a');
    fallback.href = `${ORIGIN}/anna`;
    fallback.textContent = 'See my schedule';
    el.append(fallback);
    document.body.append(el);
    return { el, heard };
  }

  function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    defineScheduleElement({ origin: ORIGIN });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches its key once, without credentials, and renders the rows', async () => {
    fetchMock.mockResolvedValue(ok(DATA));
    const el = mount({ 'schedule-key': 'k123' });
    await waitFor(() => expect(classRows(surface(el))).toHaveLength(4));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${ORIGIN}/api/public/v1/schedule/k123`);
    expect(init).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer' });
    expect(el.shadowRoot).not.toBeNull();
    const feed = [...surface(el).querySelectorAll('a')].find((a) => a.textContent === 'Add this schedule to your calendar');
    expect(feed?.getAttribute('href')).toBe('webcal://fair.example/feed/k123.ics');
  });

  it('fetches without a cache option unless the element sets one', async () => {
    fetchMock.mockResolvedValue(ok(DATA));
    const el = mount({ 'schedule-key': 'k123' });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]![1]).not.toHaveProperty('cache');
    await waitFor(() => expect(classRows(surface(el))).toHaveLength(4));
  });

  it('passes an element-level cache option to fetch', async () => {
    fetchMock.mockResolvedValue(ok(DATA));
    const el = document.createElement('fair-yoga-schedule') as HTMLElement & { cache?: RequestCache };
    el.setAttribute('schedule-key', 'k124');
    el.cache = 'no-store';
    document.body.append(el);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ cache: 'no-store' });
  });

  it('sets no cookie and writes no storage', async () => {
    fetchMock.mockResolvedValue(ok(DATA));
    const el = mount({ 'schedule-key': 'k123' });
    await waitFor(() => expect(classRows(surface(el))).toHaveLength(4));
    expect(document.cookie).toBe('');
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('leaves the fallback link in place when the fetch fails', async () => {
    fetchMock.mockRejectedValue(new TypeError('network'));
    const el = mount({ 'schedule-key': 'k123' });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 0));
    expectFallback(el);
  });

  it('leaves the fallback link in place on a 404', async () => {
    fetchMock.mockResolvedValue(new Response('{"error":"Not found."}', { status: 404 }));
    const el = mount({ 'schedule-key': 'gone' });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 0));
    expectFallback(el);
  });

  it('survives being defined twice, and two elements both render', async () => {
    expect(() => defineScheduleElement({ origin: ORIGIN })).not.toThrow();
    fetchMock.mockImplementation(async () => ok(DATA));
    const a = mount({ 'schedule-key': 'k1' });
    const b = mount({ 'schedule-key': 'k2', theme: 'unstyled' });
    await waitFor(() => {
      expect(classRows(surface(a))).toHaveLength(4);
      expect(classRows(surface(b))).toHaveLength(4);
    });
  });

  it('renders unstyled into the light DOM with no style, whatever color-scheme says', async () => {
    fetchMock.mockResolvedValue(ok(DATA));
    const el = mount({ 'schedule-key': 'k123', theme: 'unstyled', 'color-scheme': 'dark' });
    await waitFor(() => expect(classRows(el)).toHaveLength(4));
    expect(el.shadowRoot).toBeNull();
    expect(el.querySelector('style')).toBeNull();
    expect(document.querySelector('style')).toBeNull();
    expect(el.textContent).not.toContain('See my schedule');
  });

  it('treats an absent color-scheme as light', async () => {
    fetchMock.mockResolvedValue(ok(DATA));
    const el = mount({ 'schedule-key': 'k123' });
    await waitFor(() => expect(classRows(surface(el))).toHaveLength(4));
    expect(el.shadowRoot?.querySelector('.fy')?.getAttribute('data-scheme')).toBe('light');
  });

  it.each(['..', 'a/b'])('fetches nothing for the key %j and keeps the fallback', async (key) => {
    const el = mount({ 'schedule-key': key });
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(el.shadowRoot).toBeNull();
    expect(el.querySelector('a')?.textContent).toBe('See my schedule');
  });

  const noLocation: Partial<Row> = row({});
  delete noLocation.location;
  it.each([
    ['{}', {}],
    ['null', null],
    ['a row without location', { timezone: 'UTC', classes: [noLocation] }],
    ['a row with a malformed start', { timezone: 'UTC', classes: [row({ start: 'soon' })] }],
  ])('keeps the fallback for %s', async (_label, body) => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    const el = mount({ 'schedule-key': 'k123' });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 0));
    expectFallback(el);
  });

  it('dispatches load with the rendered count, bubbling and composed, and moves data-state loading → ready', async () => {
    const res = deferred<Response>();
    fetchMock.mockReturnValue(res.promise);
    const { el, heard } = mountHeard({ 'schedule-key': 'k123', limit: '3' });
    expect(el.getAttribute('data-state')).toBe('loading');
    res.resolve(ok(DATA));
    await waitFor(() => expect(heard.load).toEqual([{ count: 3 }]));
    expect(heard.error).toEqual([]);
    expect(heard.bubbles).toEqual([true]);
    expect(heard.composed).toEqual([true]);
    expect(el.getAttribute('data-state')).toBe('ready');
    expect(classRows(surface(el))).toHaveLength(3);
  });

  it('reserves height while loading in themed mode only', async () => {
    fetchMock.mockReturnValue(new Promise<Response>(() => {}));
    const themed = mount({ 'schedule-key': 'k1' });
    const unstyled = mount({ 'schedule-key': 'k2', theme: 'unstyled' });
    expect(themed.shadowRoot?.querySelector('style')?.textContent).toContain(':host([data-state="loading"])');
    expect(themed.shadowRoot?.querySelector('slot')).not.toBeNull();
    expect(unstyled.shadowRoot).toBeNull();
    expect(unstyled.getAttribute('data-state')).toBe('loading');
  });

  it.each<[string, () => Promise<Response>, ScheduleErrorDetail]>([
    ['network', () => Promise.reject(new TypeError('network')), { reason: 'network' }],
    ['http', async () => new Response('{}', { status: 404 }), { reason: 'http', status: 404 }],
    ['data (bad JSON)', async () => new Response('not json', { status: 200 }), { reason: 'data' }],
    ['data (render throw)', async () => ok({ timezone: 'UTC', classes: [row({ start: 'soon' })] }), { reason: 'data' }],
  ])('dispatches error for %s, keeps the fallback, and moves data-state loading → error', async (_label, answer, detail) => {
    const gate = deferred<void>();
    fetchMock.mockImplementation(async () => {
      await gate.promise;
      return answer();
    });
    const { el, heard } = mountHeard({ 'schedule-key': 'k123' });
    expect(el.getAttribute('data-state')).toBe('loading');
    gate.resolve();
    await waitFor(() => expect(heard.error).toEqual([detail]));
    expect(heard.bubbles).toEqual([true]);
    expect(heard.load).toEqual([]);
    expect(el.getAttribute('data-state')).toBe('error');
    expectFallback(el);
  });

  it('dispatches error invalid-key for a bad key shape, without fetching', async () => {
    const { el, heard } = mountHeard({ 'schedule-key': 'a/b' });
    await waitFor(() => expect(heard.error).toEqual([{ reason: 'invalid-key' }]));
    expect(heard.bubbles).toEqual([true]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(el.getAttribute('data-state')).toBe('error');
    expectFallback(el);
  });

  it('renders the first N classes for limit="2" and all of them for 0, -1 and abc', async () => {
    fetchMock.mockImplementation(async () => ok(DATA));
    const two = mount({ 'schedule-key': 'k1', limit: '2' });
    const others = ['0', '-1', 'abc'].map((limit) => mount({ 'schedule-key': 'k1', limit }));
    await waitFor(() => {
      expect(classRows(surface(two))).toHaveLength(2);
      for (const el of others) expect(classRows(surface(el))).toHaveLength(4);
    });
  });

  it('fetches again when schedule-key changes, and not when it is set to the same value', async () => {
    const other: PublicScheduleJson = { timezone: 'UTC', classes: [row({ id: 'z', classType: 'Kundalini' })] };
    fetchMock.mockImplementation(async (url) => ok(String(url).endsWith('/k2') ? other : DATA));
    const { el, heard } = mountHeard({ 'schedule-key': 'k1' });
    await waitFor(() => expect(heard.load).toHaveLength(1));
    el.setAttribute('schedule-key', 'k1');
    el.setAttribute('schedule-key', 'k2');
    await waitFor(() => expect(heard.load).toHaveLength(2));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${ORIGIN}/api/public/v1/schedule/k1`,
      `${ORIGIN}/api/public/v1/schedule/k2`,
    ]);
    expect(classRows(surface(el)).map((li) => li.querySelector('.fy-type')?.textContent)).toEqual(['Kundalini']);
    expect(heard.load[1]).toEqual({ count: 1 });
  });

  it('answers a change to an invalid schedule-key with invalid-key, as at first load', async () => {
    fetchMock.mockImplementation(async () => ok(DATA));
    const { el, heard } = mountHeard({ 'schedule-key': 'k1' });
    await waitFor(() => expect(heard.load).toHaveLength(1));
    el.setAttribute('schedule-key', '../x');
    await waitFor(() => expect(heard.error).toEqual([{ reason: 'invalid-key' }]));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(el.getAttribute('data-state')).toBe('error');
  });

  it('renders the latest key when the earlier response arrives last', async () => {
    const slow = deferred<Response>();
    const other: PublicScheduleJson = { timezone: 'UTC', classes: [row({ id: 'z', classType: 'Kundalini' })] };
    fetchMock.mockImplementation((url) => (String(url).endsWith('/k1') ? slow.promise : Promise.resolve(ok(other))));
    const { el, heard } = mountHeard({ 'schedule-key': 'k1' });
    el.setAttribute('schedule-key', 'k2');
    await waitFor(() => expect(heard.load).toEqual([{ count: 1 }]));
    slow.resolve(ok(DATA));
    await new Promise((r) => setTimeout(r, 10));
    expect(heard.load).toEqual([{ count: 1 }]);
    expect(classRows(surface(el)).map((li) => li.querySelector('.fy-type')?.textContent)).toEqual(['Kundalini']);
    expect(el.getAttribute('data-state')).toBe('ready');
  });

  it('marks the themed root dark for color-scheme="dark"', async () => {
    fetchMock.mockResolvedValue(ok(DATA));
    const el = mount({ 'schedule-key': 'k123', 'color-scheme': 'dark' });
    await waitFor(() => expect(classRows(surface(el))).toHaveLength(4));
    expect(el.shadowRoot?.querySelector('.fy')?.getAttribute('data-scheme')).toBe('dark');
  });
});
