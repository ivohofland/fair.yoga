import { describe, it, expect } from 'vitest';
import { buildIcs, type IcsEvent } from './ics';
import { classStartInstant } from './timezone';

const NOW = new Date('2026-10-20T08:00:00Z');

function event(over: Partial<IcsEvent> = {}): IcsEvent {
  return {
    uid: 'entry-1@fair.yoga',
    start: new Date('2026-10-26T18:00:00Z'),
    durationMinutes: 60,
    summary: 'Hatha',
    location: null,
    description: '',
    url: null,
    cancelled: false,
    sequence: 1,
    lastModified: new Date('2026-10-19T10:00:00Z'),
    ...over,
  };
}

const build = (events: IcsEvent[]) => buildIcs({ calendarName: 'Anna', events, now: NOW });
const unfold = (s: string) => s.replace(/\r\n[ \t]/g, '');

describe('buildIcs', () => {
  it('ends every line with CRLF and carries the calendar header', () => {
    const out = build([event()]);
    expect(out.endsWith('\r\n')).toBe(true);
    expect(out.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    expect(out).toContain('BEGIN:VCALENDAR\r\n');
    expect(out).toContain('METHOD:PUBLISH\r\n');
    expect(out).toContain('X-WR-CALNAME:Anna\r\n');
    expect(out).toContain('DTSTAMP:20261020T080000Z\r\n');
    expect(out).toContain('DTEND:20261026T190000Z\r\n');
    expect(out).toContain('SEQUENCE:1\r\n');
  });

  it('folds a long summary at 75 octets and unfolding restores it', () => {
    const summary = 'x'.repeat(200);
    const out = build([event({ summary })]);
    for (const line of out.split('\r\n')) expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
    expect(unfold(out)).toContain(`SUMMARY:${summary}\r\n`);
  });

  it('never splits a multi-byte character when folding', () => {
    const summary = 'Yin yoga — ontspanning ✨ '.repeat(8);
    const out = build([event({ summary })]);
    for (const line of out.split('\r\n')) {
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
      expect(line).not.toContain('�');
    }
    expect(unfold(out)).toContain(`SUMMARY:${summary}\r\n`);
  });

  it('escapes backslash, semicolon, comma and newline in TEXT properties', () => {
    const out = build([event({ summary: 'Hatha; slow, deep\nflow', location: 'A\\B; C, D', description: 'x\ny' })]);
    expect(out).toContain('SUMMARY:Hatha\\; slow\\, deep\\nflow\r\n');
    expect(out).toContain('LOCATION:A\\\\B\\; C\\, D\r\n');
    expect(out).toContain('DESCRIPTION:x\\ny\r\n');
    expect(out).toContain('Hatha\\;');
    expect(out).not.toContain('Hatha;');
  });

  it('cannot be made to start a new property by a line break in a summary', () => {
    for (const summary of ['Flow\r\nATTENDEE:mailto:x@example.com', 'Flow\rATTENDEE:mailto:x@example.com']) {
      const out = build([event({ summary })]);
      expect(out.split('\r\n').some((l) => l.startsWith('ATTENDEE'))).toBe(false);
      const lines = unfold(out).split('\r\n').filter((l) => l.startsWith('SUMMARY'));
      expect(lines).toEqual(['SUMMARY:Flow\\nATTENDEE:mailto:x@example.com']);
    }
  });

  it('leaves the URL unescaped', () => {
    expect(build([event({ url: 'https://fair.yoga/a/book/1?x=1,2' })])).toContain('URL:https://fair.yoga/a/book/1?x=1,2\r\n');
  });

  it('marks a cancelled event STATUS:CANCELLED and a live one CONFIRMED', () => {
    expect(build([event({ cancelled: true })])).toContain('STATUS:CANCELLED\r\n');
    expect(build([event()])).toContain('STATUS:CONFIRMED\r\n');
  });

  it('writes an Amsterdam 19:00 class after the clocks change as 18:00Z', () => {
    const start = classStartInstant(
      { date: new Date('2026-10-26T00:00:00Z'), startTime: new Date('1970-01-01T19:00:00Z') },
      'Europe/Amsterdam',
    );
    expect(build([event({ start })])).toContain('DTSTART:20261026T180000Z\r\n');
  });
});
