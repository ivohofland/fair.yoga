/** Lucide-style functional line icon. Words come first; icons only where text would be longer or less clear. */
export interface IconProps {
  /** One of: calendar, users, inbox, settings, chevron-right, arrow-left, plus, check, x, share */
  name: string;
  /** Square size in px. Default 24. */
  size?: number;
  style?: React.CSSProperties;
}
