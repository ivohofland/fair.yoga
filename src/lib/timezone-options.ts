import { isValidTimeZone, modernTimeZone } from '@/lib/iana-timezone';

export interface TimeZoneOption { value: string; label: string }
export interface TimeZoneGroup { region: string; options: TimeZoneOption[] }

/**
 * The Settings timezone picker's contents. `standalone` holds the options
 * outside the region groups: an enumerated zone with no `Region/` prefix, and
 * the stored zone when the list lacks it — which is what keeps a controlled
 * `<select>` from showing blank and a first touch from replacing a correct
 * zone.
 */
export interface TimeZoneOptions { standalone: TimeZoneOption[]; groups: TimeZoneGroup[] }

/** `GMT+13`, `GMT+5:30` — the zone's offset at `now`, so it tracks daylight saving. */
function offsetAt(zone: string, now: Date): string | undefined {
  return new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' })
    .formatToParts(now)
    .find((part) => part.type === 'timeZoneName')?.value;
}

function withOffset(name: string, zone: string, now: Date): string {
  const offset = offsetAt(zone, now);
  return offset ? `${name} (${offset})` : name;
}

/**
 * Every zone this runtime enumerates, under its current IANA name, grouped by
 * region. Call it on the server and pass the result to the client form: a
 * list computed during a client component's render would be Node's on the
 * server and the browser's on hydration.
 *
 * A stored zone `Intl` cannot resolve is still offered, under its bare
 * identifier — the page must render so the teacher can pick a real one.
 */
export function timeZoneOptions(stored: string, now: Date): TimeZoneOptions {
  const standalone: TimeZoneOption[] = [];
  const byRegion = new Map<string, TimeZoneOption[]>();
  const seen = new Set<string>();

  for (const zone of Intl.supportedValuesOf('timeZone').map(modernTimeZone)) {
    if (seen.has(zone)) continue;
    seen.add(zone);
    const slash = zone.indexOf('/');
    if (slash === -1) {
      standalone.push({ value: zone, label: withOffset(zone, zone, now) });
      continue;
    }
    const region = zone.slice(0, slash);
    const city = zone.slice(slash + 1).replaceAll('/', ' / ').replaceAll('_', ' ');
    const options = byRegion.get(region) ?? [];
    options.push({ value: zone, label: withOffset(city, zone, now) });
    byRegion.set(region, options);
  }

  if (!seen.has(stored)) {
    standalone.unshift({
      value: stored,
      label: isValidTimeZone(stored) ? withOffset(stored, stored, now) : stored,
    });
  }

  const byLabel = (a: TimeZoneOption, b: TimeZoneOption): number => a.label.localeCompare(b.label, 'en');
  const groups = [...byRegion.entries()]
    .sort(([a], [b]) => a.localeCompare(b, 'en'))
    .map(([region, options]) => ({ region, options: options.sort(byLabel) }));

  return { standalone, groups };
}
