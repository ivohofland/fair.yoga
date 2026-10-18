/** The OAuth scopes fair.yoga asks Mollie for, in request order. */
export const MOLLIE_SCOPES = [
  'payments.read',
  'payments.write',
  'refunds.read',
  'refunds.write',
  'profiles.read',
  'organizations.read',
] as const;

/**
 * Where a Mollie connection's payments land: the organization and the profile
 * whose balance they are credited to.
 */
export type LiveIdentity = { organizationId: string; profileId: string };

/**
 * The connection's payout identity while it is live — not disconnected, and
 * with a profile chosen — else null, as for no connection at all. The one
 * spelling of "live" (spec, Data).
 */
export function livePayoutIdentity(
  row: { organizationId: string; profileId: string | null; disconnectedAt: Date | null } | null,
): LiveIdentity | null {
  return row !== null && row.disconnectedAt === null && row.profileId !== null
    ? { organizationId: row.organizationId, profileId: row.profileId }
    : null;
}

/** The requested scopes a grant lacks, in request order. */
export function missingMollieScopes(granted: readonly string[]): string[] {
  const have = new Set(granted);
  return MOLLIE_SCOPES.filter((scope) => !have.has(scope));
}

/**
 * Whether students may pay through this connection: it has a live payout
 * identity and its grant holds every requested scope. A narrower grant is
 * stored but takes no payments until the teacher reconnects.
 */
export function takesMolliePayments(
  row: { organizationId: string; profileId: string | null; disconnectedAt: Date | null; scopes: readonly string[] } | null,
): boolean {
  return livePayoutIdentity(row) !== null && row !== null && missingMollieScopes(row.scopes).length === 0;
}
