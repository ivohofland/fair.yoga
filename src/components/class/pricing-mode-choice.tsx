import type { PricingMode } from '@/lib/prisma-client';

const PRICING_MODE_LABELS = {
  tiered: 'Tiered',
  donation: 'By donation',
} as const satisfies Record<PricingMode, string>;

const MODES = Object.keys(PRICING_MODE_LABELS) as readonly PricingMode[];

export function PricingModeChoice({
  value,
  onChange,
  disabled,
  name,
  describedBy,
}: {
  value: PricingMode;
  onChange: (mode: PricingMode) => void;
  disabled?: boolean;
  name: string;
  /** The id of the caption that says why the choice is disabled. */
  describedBy?: string;
}) {
  return (
    <fieldset disabled={disabled} aria-describedby={describedBy}>
      <legend className="type-label">Pricing</legend>
      {MODES.map((mode) => (
        <label key={mode} className="flex items-center gap-3 min-h-11 type-body">
          <input
            type="radio"
            name={name}
            value={mode}
            checked={value === mode}
            onChange={() => onChange(mode)}
            className="h-5 w-5 accent-teal"
          />
          {PRICING_MODE_LABELS[mode]}
        </label>
      ))}
    </fieldset>
  );
}
