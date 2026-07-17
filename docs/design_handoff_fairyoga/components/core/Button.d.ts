/**
 * Pill button, 48px tall, sans semibold 16.
 * @startingPoint section="Components" subtitle="Primary, secondary, destructive, ghost" viewport="700x260"
 */
export interface ButtonProps {
  /** primary: teal fill / cream text. secondary: teal outline. destructive: danger outline, never filled. ghost: teal text only. Default primary. */
  variant?: 'primary' | 'secondary' | 'destructive' | 'ghost';
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  /** Full-width in mobile forms. */
  fullWidth?: boolean;
  type?: 'button' | 'submit';
  style?: React.CSSProperties;
}
