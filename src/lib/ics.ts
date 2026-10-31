export type IcsEvent = {
  uid: string;
  start: Date;
  durationMinutes: number;
  summary: string;
  location: string | null;
  description: string;
  url: string | null;
  cancelled: boolean;
  sequence: number;
  lastModified: Date;
};

const MAX_OCTETS = 75;

/** `YYYYMMDDTHHMMSSZ` in UTC. */
function utc(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** RFC 5545 TEXT: backslash, semicolon, comma and line breaks. */
function escapeText(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/** Folds at 75 octets; a continuation starts with one space, which counts toward its 75. */
function fold(line: string): string {
  const parts: string[] = [];
  let current = '';
  let octets = 0;
  for (const ch of line) {
    const size = Buffer.byteLength(ch, 'utf8');
    const limit = parts.length === 0 ? MAX_OCTETS : MAX_OCTETS - 1;
    if (octets + size > limit) {
      parts.push(current);
      current = '';
      octets = 0;
    }
    current += ch;
    octets += size;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

export function buildIcs(input: { calendarName: string; events: IcsEvent[]; now: Date }): string {
  const { calendarName, events, now } = input;
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//fair.yoga//schedule feed//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(calendarName)}`,
  ];
  for (const e of events) {
    const end = new Date(e.start.getTime() + e.durationMinutes * 60_000);
    lines.push(
      'BEGIN:VEVENT',
      `UID:${e.uid}`,
      `DTSTAMP:${utc(now)}`,
      `LAST-MODIFIED:${utc(e.lastModified)}`,
      `SEQUENCE:${e.sequence}`,
      `DTSTART:${utc(e.start)}`,
      `DTEND:${utc(end)}`,
      `SUMMARY:${escapeText(e.summary)}`,
    );
    if (e.location) lines.push(`LOCATION:${escapeText(e.location)}`);
    if (e.description) lines.push(`DESCRIPTION:${escapeText(e.description)}`);
    if (e.url) lines.push(`URL:${e.url}`);
    lines.push(`STATUS:${e.cancelled ? 'CANCELLED' : 'CONFIRMED'}`, 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
