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
 * Refuses ECMA-402 offset identifiers (`+18:00`, `-0530`), which the probe
 * alone accepts: an offset can lie outside UTC−12..UTC+14, the range
 * `cancelCandidateDates` depends on. IANA's fixed-offset zones spell
 * themselves `Etc/GMT±N`, so no IANA name starts with a sign.
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
