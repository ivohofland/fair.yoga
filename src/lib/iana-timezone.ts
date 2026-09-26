/**
 * Whether `Intl` can resolve an IANA timezone identifier.
 *
 * A construct-probe rather than `Intl.supportedValuesOf`, because the question
 * this answers is "can the calendar functions interpret this string", and the
 * probe accepts exactly what they accept — aliases and `backward` links
 * included, which `supportedValuesOf` does not promise to enumerate.
 *
 * ITS OWN MODULE, WITH NO IMPORTS, and that is the whole reason this file
 * exists rather than the function living beside its consumers in
 * `timezone.ts`. Two callers need it from opposite sides of the client
 * boundary: `schemas.ts`, which many `'use client'` components import, and the
 * server-only audit sweep. `timezone.ts` imports `@/lib/log` (pino), so
 * hosting the probe there would pull a server-only logger into the client
 * bundle. Same split, same reason, as `tiers.ts` against `tiers.server.ts`.
 *
 * Keep this file dependency-free. An import added here is an import added to
 * every client bundle that reaches `schemas.ts`.
 *
 * Refuses offset identifiers (`+18:00`, `-0530`), which the probe alone
 * accepts: real IANA zones only, because `cancelCandidateDates` depends on
 * the IANA offset range. IANA's fixed-offset zones spell themselves
 * `Etc/GMT±N`, so no IANA name starts with a sign. Both the input and the
 * resolved name are checked: Intl normalises some inputs that do not start
 * with an ASCII sign — `−18:00` with U+2212 — into an offset.
 */
export function isValidTimeZone(tz: string): boolean {
  const isOffset = (s: string) => s.startsWith('+') || s.startsWith('-');
  if (isOffset(tz)) return false;
  try {
    return !isOffset(new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone);
  } catch {
    return false;
  }
}

/**
 * Current IANA spelling for each zone V8 still enumerates under a name IANA
 * has since changed. Keys are what `Intl.supportedValuesOf('timeZone')` and a
 * browser's `resolvedOptions().timeZone` may report; values are what the
 * database stores. Which pairs, and the command that re-derives them:
 * `docs/data-model.md`, Design Notes → "Teacher timezones are stored under
 * their current IANA name".
 */
export const MODERN_ZONE_NAMES: ReadonlyMap<string, string> = new Map([
  ['Africa/Asmera', 'Africa/Asmara'],
  ['America/Buenos_Aires', 'America/Argentina/Buenos_Aires'],
  ['America/Catamarca', 'America/Argentina/Catamarca'],
  ['America/Coral_Harbour', 'America/Atikokan'],
  ['America/Cordoba', 'America/Argentina/Cordoba'],
  ['America/Godthab', 'America/Nuuk'],
  ['America/Indianapolis', 'America/Indiana/Indianapolis'],
  ['America/Jujuy', 'America/Argentina/Jujuy'],
  ['America/Louisville', 'America/Kentucky/Louisville'],
  ['America/Mendoza', 'America/Argentina/Mendoza'],
  ['Asia/Calcutta', 'Asia/Kolkata'],
  ['Asia/Katmandu', 'Asia/Kathmandu'],
  ['Asia/Rangoon', 'Asia/Yangon'],
  ['Asia/Saigon', 'Asia/Ho_Chi_Minh'],
  ['Atlantic/Faeroe', 'Atlantic/Faroe'],
  ['Europe/Kiev', 'Europe/Kyiv'],
  ['Pacific/Enderbury', 'Pacific/Kanton'],
  ['Pacific/Ponape', 'Pacific/Pohnpei'],
  ['Pacific/Truk', 'Pacific/Chuuk'],
]);

/** `tz` under its current IANA name, or `tz` itself when it has no other. */
export function modernTimeZone(tz: string): string {
  return MODERN_ZONE_NAMES.get(tz) ?? tz;
}
