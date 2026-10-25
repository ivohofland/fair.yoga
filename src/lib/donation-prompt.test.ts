import { describe, it, expect } from 'vitest';
import { canSeeGivePage, showsDonationPrompt, DONATION_PROMPT_DAYS } from './donation-prompt';

const invitedAt = new Date('2026-06-01T12:00:00.000Z');
const ELIGIBLE = {
  classStatus: 'completed', classCancelledAt: null, pricingMode: 'donation',
  registrationStatus: 'attended', donationInvitedAt: invitedAt,
} as const;

describe('canSeeGivePage', () => {
  it('(#912) is true for an invited booking that came to a completed donation class', () => {
    expect(canSeeGivePage(ELIGIBLE)).toBe(true);
    expect(canSeeGivePage({ ...ELIGIBLE, registrationStatus: 'registered' })).toBe(true);
  });
  it.each([
    ['not completed', { classStatus: 'in_progress' }],
    ['cancelled', { classCancelledAt: new Date() }],
    ['tiered', { pricingMode: 'tiered' }],
    ['no_show', { registrationStatus: 'no_show' }],
    ['late_cancel', { registrationStatus: 'late_cancel' }],
    ['cancelled booking', { registrationStatus: 'cancelled' }],
    ['never invited', { donationInvitedAt: null }],
  ] as const)('(#912) is false when %s', (_label, flip) => {
    expect(canSeeGivePage({ ...ELIGIBLE, ...flip })).toBe(false);
  });
});

describe('showsDonationPrompt', () => {
  const day = 86_400_000;
  it('(#912) shows within the window and not once hidden', () => {
    expect(showsDonationPrompt({ ...ELIGIBLE, donationPromptHiddenAt: null }, new Date(invitedAt.getTime() + day))).toBe(true);
    expect(showsDonationPrompt({ ...ELIGIBLE, donationPromptHiddenAt: new Date() }, new Date(invitedAt.getTime() + day))).toBe(false);
  });
  it('(#912) hides itself at exactly the window edge', () => {
    const edge = new Date(invitedAt.getTime() + DONATION_PROMPT_DAYS * day);
    expect(showsDonationPrompt({ ...ELIGIBLE, donationPromptHiddenAt: null }, new Date(edge.getTime() - 1))).toBe(true);
    expect(showsDonationPrompt({ ...ELIGIBLE, donationPromptHiddenAt: null }, edge)).toBe(false);
  });
  it('(#912) never shows where the give page would not render', () => {
    expect(showsDonationPrompt({ ...ELIGIBLE, registrationStatus: 'no_show', donationPromptHiddenAt: null }, invitedAt)).toBe(false);
  });
});
