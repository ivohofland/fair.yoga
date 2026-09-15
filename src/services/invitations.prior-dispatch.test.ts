import { describe, it, expect } from 'vitest';
import { priorDispatchFor } from './invitations';

describe('priorDispatchFor (#172)', () => {
  const email = 'invitee@test.local';

  it('is a repeat when the last dispatch went to this address and recorded no failure', () => {
    expect(priorDispatchFor({ email, lastNotifiedEmail: email, lastNotifyFailedAt: null }))
      .toBe('same_address');
  });

  it('is a first dispatch when nothing has been sent yet', () => {
    expect(priorDispatchFor({ email, lastNotifiedEmail: null, lastNotifyFailedAt: null }))
      .toBe('none');
  });

  it('is a first dispatch when the row was readdressed since the last one', () => {
    expect(priorDispatchFor({ email, lastNotifiedEmail: 'typo@test.local', lastNotifyFailedAt: null }))
      .toBe('none');
  });

  it('is a first dispatch when the last one recorded a failure', () => {
    expect(priorDispatchFor({ email, lastNotifiedEmail: email, lastNotifyFailedAt: new Date() }))
      .toBe('none');
  });
});
