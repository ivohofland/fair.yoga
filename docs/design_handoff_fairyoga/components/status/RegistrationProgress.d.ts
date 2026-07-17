/**
 * Registration progress bar — the signature element on class cards.
 * @startingPoint section="Components" subtitle="Danger→teal fill with min-mark tick" viewport="700x200"
 */
export interface RegistrationProgressProps {
  /** Current registered students. */
  registered: number;
  /** Minimum for the class to go ahead — marked with an ink tick. */
  min: number;
  /** Class capacity. */
  max: number;
  style?: React.CSSProperties;
}
