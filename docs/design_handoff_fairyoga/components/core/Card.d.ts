/** Sand surface card: 1px border, radius 16, padding 20. */
export interface CardProps {
  children: React.ReactNode;
  /** Makes the card tappable (pointer + sand-hover). */
  onClick?: () => void;
  /** Show a trailing chevron — required on tappable cards. */
  chevron?: boolean;
  /** Teal-tint selected state. */
  selected?: boolean;
  style?: React.CSSProperties;
}
