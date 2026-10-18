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

/** `org_…` and the id's last four characters. */
export function maskOrganizationId(id: string): string {
  return `org_…${id.slice(-4)}`;
}

/** `pfl_…` and the id's last four characters. */
export function maskProfileId(id: string): string {
  return `pfl_…${id.slice(-4)}`;
}

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

/**
 * `takesMolliePayments`, on a server running in `config`'s mode: a connection
 * made in the other mode (its `testmode`) takes none here until a reconnect
 * stores one made in this mode. Every check made with a Mollie config uses
 * this one.
 */
export function takesMolliePaymentsIn(
  row: {
    organizationId: string; profileId: string | null; disconnectedAt: Date | null; scopes: readonly string[]; testmode: boolean;
  } | null,
  config: { testmode: boolean },
): boolean {
  return takesMolliePayments(row) && row !== null && row.testmode === config.testmode;
}

/** The attempt column `canRefundThroughGrant` reads, as a Prisma select fragment. */
export const ATTEMPT_GRANT_SELECT = { connection: { select: { revokedAt: true } } } as const;

/**
 * Whether fair.yoga can still refund an attempt through Mollie: the attempt
 * still has its connection (an erased teacher's attempts have none) and that
 * connection's grant is not revoked. Decision 17 holds only while this does
 * (`docs/superpowers/specs/2026-10-18-mollie-connect-design.md`).
 */
export function canRefundThroughGrant(attempt: { connection: { revokedAt: Date | null } | null }): boolean {
  return attempt.connection !== null && attempt.connection.revokedAt === null;
}
