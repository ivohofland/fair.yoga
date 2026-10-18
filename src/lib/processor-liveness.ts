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
 * with a profile chosen — else null, as for no connection at all. Live as
 * `docs/superpowers/specs/2026-10-18-mollie-connect-design.md` (Data) defines it.
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
 * Whether this connection may take payments: it has a live payout identity
 * and its grant holds every requested scope. A narrower grant answers false
 * until a reconnect stores a full one.
 */
export function takesMolliePayments(
  row: { organizationId: string; profileId: string | null; disconnectedAt: Date | null; scopes: readonly string[] } | null,
): boolean {
  return livePayoutIdentity(row) !== null && row !== null && missingMollieScopes(row.scopes).length === 0;
}
