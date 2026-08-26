import type { ClassStatus } from '@prisma/client';

export type BadgeVariant =
  | 'draft'
  | 'registering'
  | 'full'
  | 'waitlist'
  | 'in_progress'
  | 'below_min'
  | 'completed'
  | 'cancelled';

// Fill encodes time: outline = upcoming, tint = now, solid = done.
// Payment states are never badges — render glyph + word in text color.
const VARIANTS: Record<BadgeVariant, { classes: string; label: string }> = {
  draft: { classes: 'border-brown-light text-brown', label: 'Draft' },
  registering: { classes: 'border-teal text-teal', label: 'Open for registration' },
  full: { classes: 'border-transparent bg-gold-tint text-gold-deep', label: 'Full' },
  waitlist: { classes: 'border-transparent bg-gold-tint text-gold-deep', label: 'Waitlist' },
  in_progress: { classes: 'border-transparent bg-teal-tint text-teal', label: 'In progress' },
  below_min: { classes: 'border-transparent bg-danger-tint text-danger', label: 'Below minimum' },
  completed: { classes: 'border-transparent bg-teal text-cream', label: 'Completed' },
  cancelled: { classes: 'border-transparent bg-brown text-cream', label: 'Cancelled' },
};

interface StatusBadgeProps {
  variant: BadgeVariant;
  children?: string;
}

// Radius 12, 13px medium — color is always paired with a text label.
export function StatusBadge({ variant, children }: StatusBadgeProps) {
  const v = VARIANTS[variant];
  return (
    <span
      className={`inline-block border rounded-field px-2.5 py-[3px] text-[13px] font-medium leading-[1.4] whitespace-nowrap ${v.classes}`}
    >
      {children ?? v.label}
    </span>
  );
}

// Maps a class's lifecycle status + cancellation + registration counts to a
// badge variant. Replaces the old deriveDotShape/deriveDisplayStatus helpers.
//
// `cancelled` is a SEPARATE parameter since #327, not a `ClassStatus` member:
// cancellation moved to `CalendarEntry.cancelledAt`, so a cancelled class
// still carries a live status and a switch over `status` alone would render it
// as "Open for registration". Second in the list, beside the status, because
// the two together are what liveness is now — and required rather than
// optional, so every call site has to answer it.
export function deriveBadgeVariant(
  status: ClassStatus,
  cancelled: boolean,
  registrations: number,
  minStudents: number,
  maxStudents: number,
): BadgeVariant {
  if (cancelled) return 'cancelled';
  switch (status) {
    case 'draft':
      return 'draft';
    case 'open':
      return registrations >= maxStudents ? 'full' : 'registering';
    case 'in_progress':
      return registrations < minStudents ? 'below_min' : 'in_progress';
    case 'completed':
      return 'completed';
  }
}
