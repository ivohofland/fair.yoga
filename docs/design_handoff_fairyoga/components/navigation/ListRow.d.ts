/** List row: min 56px, 1px bottom divider, no alternating backgrounds. */
export interface ListRowProps {
  children: React.ReactNode;
  /** Right-aligned content (amount, badge, toggle). */
  trailing?: React.ReactNode;
  onClick?: () => void;
  chevron?: boolean;
  /** Teal-tint selected state. */
  selected?: boolean;
  /** Default true. */
  divider?: boolean;
  style?: React.CSSProperties;
}
