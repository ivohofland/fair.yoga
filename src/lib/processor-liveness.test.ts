import { describe, it, expect } from 'vitest';
import { MOLLIE_SCOPES, livePayoutIdentity, missingMollieScopes, takesMolliePayments, takesMolliePaymentsIn } from './processor-liveness';

const live = { organizationId: 'org_a', profileId: 'pfl_1', disconnectedAt: null, scopes: [...MOLLIE_SCOPES] };

describe('livePayoutIdentity', () => {
  it('is the organization and profile of a connected row with a profile', () => {
    expect(livePayoutIdentity(live)).toEqual({ organizationId: 'org_a', profileId: 'pfl_1' });
  });
  it('is null with no row, with no profile, or once disconnected', () => {
    expect(livePayoutIdentity(null)).toBeNull();
    expect(livePayoutIdentity({ ...live, profileId: null })).toBeNull();
    expect(livePayoutIdentity({ ...live, disconnectedAt: new Date() })).toBeNull();
  });
});

describe('missingMollieScopes', () => {
  it('names each requested scope the grant lacks, in request order', () => {
    expect(missingMollieScopes([...MOLLIE_SCOPES])).toEqual([]);
    expect(missingMollieScopes(['refunds.write', 'payments.read'])).toEqual(['payments.write', 'refunds.read', 'profiles.read', 'organizations.read']);
  });
});

describe('takesMolliePayments', () => {
  it('needs a live identity and every requested scope', () => {
    expect(takesMolliePayments(live)).toBe(true);
    expect(takesMolliePayments({ ...live, scopes: ['payments.read'] })).toBe(false);
    expect(takesMolliePayments({ ...live, profileId: null })).toBe(false);
    expect(takesMolliePayments({ ...live, disconnectedAt: new Date() })).toBe(false);
    expect(takesMolliePayments(null)).toBe(false);
  });
});

describe('takesMolliePaymentsIn', () => {
  it('is takesMolliePayments for a connection made in the server’s mode', () => {
    expect(takesMolliePaymentsIn({ ...live, testmode: true }, { testmode: true })).toBe(true);
    expect(takesMolliePaymentsIn({ ...live, testmode: false }, { testmode: false })).toBe(true);
    expect(takesMolliePaymentsIn({ ...live, testmode: true, scopes: ['payments.read'] }, { testmode: true })).toBe(false);
    expect(takesMolliePaymentsIn(null, { testmode: true })).toBe(false);
  });
  it('is false for a connection made in the other mode', () => {
    expect(takesMolliePaymentsIn({ ...live, testmode: true }, { testmode: false })).toBe(false);
    expect(takesMolliePaymentsIn({ ...live, testmode: false }, { testmode: true })).toBe(false);
  });
});
