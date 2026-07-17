/** Status badge: radius 12, 13px medium, always text + color. Fill encodes time: outline = upcoming, tint = now, solid = done. */
export interface StatusBadgeProps {
  /** draft (outline brown-light) · registering (outline teal) · full | waitlist (gold tint) · in_progress (teal tint) · completed (solid teal) · cancelled (solid brown) · below_min (danger tint) · paid (deprecated — payment is glyph + word, never a badge) */
  status?: 'draft' | 'registering' | 'full' | 'waitlist' | 'in_progress' | 'completed' | 'cancelled' | 'below_min' | 'paid';
  /** Override the default label text. */
  children?: React.ReactNode;
  style?: React.CSSProperties;
}
