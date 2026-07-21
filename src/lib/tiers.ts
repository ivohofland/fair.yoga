// The middle tier: the default for new student profiles and the value
// erased profiles are reset to.
export const DEFAULT_INCOME_TIER = 3;

/** Tier display copy — accessible language, inviting, never guilt-inducing. */
export const TIER_INFO = [
  { tier: 1, label: 'Getting by', caption: 'Money is tight right now' },
  { tier: 2, label: 'Managing', caption: 'Covering the basics' },
  { tier: 3, label: 'Comfortable', caption: 'Comfortable, with some room' },
  { tier: 4, label: 'Doing well', caption: 'Doing well financially' },
  { tier: 5, label: 'Plenty to share', caption: 'Happy to support others' },
] as const;

export const TIER_QUOTE = {
  text: 'Yoga is not about touching your toes. It is about what you learn on the way down.',
  author: 'Judith Hanson Lasater',
} as const;
