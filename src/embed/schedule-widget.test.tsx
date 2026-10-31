import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { waitFor } from '@testing-library/react';
import type { PublicScheduleJson } from '@/lib/public-schedule-json';
import { defineScheduleElement, renderSchedule, type WidgetScheduleJson } from './schedule-widget';

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

function rendered(theme: 'themed' | 'unstyled', data: PublicScheduleJson = DATA): HTMLElement {
  const root = document.createElement('div');
  document.body.append(root);
  renderSchedule(root, data, { theme, feedUrl: FEED, origin: ORIGIN });
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
    expect(vinyasa.querySelector('.fy-time')?.textContent).toBe('19:00');
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
      { heading: 'Tue 3 Nov', rows: ['Late'], times: ['23:30'] },
      { heading: 'Thu 5 Nov', rows: ['Early'], times: ['00:30'] },
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
    const el = mount({ key: 'k123' });
    await waitFor(() => expect(classRows(surface(el))).toHaveLength(4));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${ORIGIN}/api/public/v1/schedule/k123`);
    expect(init).toMatchObject({ credentials: 'omit' });
    expect(el.shadowRoot).not.toBeNull();
    const feed = [...surface(el).querySelectorAll('a')].find((a) => a.textContent === 'Add this schedule to your calendar');
    expect(feed?.getAttribute('href')).toBe('webcal://fair.example/feed/k123.ics');
  });

  it('sets no cookie and writes no storage', async () => {
    fetchMock.mockResolvedValue(ok(DATA));
    const el = mount({ key: 'k123' });
    await waitFor(() => expect(classRows(surface(el))).toHaveLength(4));
    expect(document.cookie).toBe('');
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('leaves the fallback link in place when the fetch fails', async () => {
    fetchMock.mockRejectedValue(new TypeError('network'));
    const el = mount({ key: 'k123' });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(el.shadowRoot).toBeNull();
    expect(el.querySelector('a')?.textContent).toBe('See my schedule');
  });

  it('leaves the fallback link in place on a 404', async () => {
    fetchMock.mockResolvedValue(new Response('{"error":"Not found."}', { status: 404 }));
    const el = mount({ key: 'gone' });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(el.shadowRoot).toBeNull();
    expect(el.querySelector('a')?.textContent).toBe('See my schedule');
  });

  it('survives being defined twice, and two elements both render', async () => {
    expect(() => defineScheduleElement({ origin: ORIGIN })).not.toThrow();
    fetchMock.mockImplementation(async () => ok(DATA));
    const a = mount({ key: 'k1' });
    const b = mount({ key: 'k2', theme: 'unstyled' });
    await waitFor(() => {
      expect(classRows(surface(a))).toHaveLength(4);
      expect(classRows(surface(b))).toHaveLength(4);
    });
  });

  it('renders unstyled into the light DOM with no style, whatever color-scheme says', async () => {
    fetchMock.mockResolvedValue(ok(DATA));
    const el = mount({ key: 'k123', theme: 'unstyled', 'color-scheme': 'dark' });
    await waitFor(() => expect(classRows(el)).toHaveLength(4));
    expect(el.shadowRoot).toBeNull();
    expect(el.querySelector('style')).toBeNull();
    expect(document.querySelector('style')).toBeNull();
    expect(el.textContent).not.toContain('See my schedule');
  });

  it('marks the themed root dark for color-scheme="dark"', async () => {
    fetchMock.mockResolvedValue(ok(DATA));
    const el = mount({ key: 'k123', 'color-scheme': 'dark' });
    await waitFor(() => expect(classRows(surface(el))).toHaveLength(4));
    expect(el.shadowRoot?.querySelector('.fy')?.getAttribute('data-scheme')).toBe('dark');
  });
});
