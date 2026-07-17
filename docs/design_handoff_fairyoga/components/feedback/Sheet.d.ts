/** Bottom sheet (mobile, drag handle, 20px top radius) or centered modal (desktop, max 480px). */
export interface SheetProps {
  open: boolean;
  onClose?: () => void;
  /** Modal title in Subtitle style. */
  title?: string;
  children: React.ReactNode;
  /** Render as a centered desktop modal instead of a bottom sheet. */
  desktop?: boolean;
  style?: React.CSSProperties;
}
