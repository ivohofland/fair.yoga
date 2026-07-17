/** Empty state: one subtitle + one body line + one action. */
export interface EmptyStateProps {
  /** Subtitle style (18 Georgia bold, ink). */
  title: string;
  /** One body line. */
  body?: string;
  actionLabel?: string;
  onAction?: () => void;
  style?: React.CSSProperties;
}
