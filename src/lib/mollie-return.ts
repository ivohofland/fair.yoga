/**
 * How the Mollie OAuth callback tells the profile settings what happened: the
 * value of the `mollie` query parameter it redirects with.
 */
export const MOLLIE_RETURNS = ['connected', 'choose', 'expired', 'cancelled', 'unavailable'] as const;
export type MollieReturn = (typeof MOLLIE_RETURNS)[number];

/** The return named by a `mollie` query value, or null for any other value. */
export function parseMollieReturn(value: string | string[] | undefined): MollieReturn | null {
  return MOLLIE_RETURNS.find((r) => r === value) ?? null;
}
