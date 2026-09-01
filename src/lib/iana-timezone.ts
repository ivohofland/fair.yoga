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
 */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
