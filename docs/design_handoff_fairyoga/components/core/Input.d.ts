/** 48px text input on sand, radius 12, label above with 8px gap. */
export interface InputProps {
  /** Label rendered above the field (14 medium, brown). */
  label?: string;
  value?: string;
  onChange?: (e: any) => void;
  placeholder?: string;
  /** Error message; also switches the field to danger border + danger-tint background. */
  error?: string;
  /** Helper text below (13, brown light). Hidden while an error shows. */
  helper?: string;
  type?: string;
  disabled?: boolean;
  style?: React.CSSProperties;
}
