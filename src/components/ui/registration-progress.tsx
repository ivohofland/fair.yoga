interface RegistrationProgressProps {
  registered: number;
  min: number;
  max: number;
  className?: string;
}

/**
 * The signature element on class cards. 8px track; fill is danger until the
 * minimum is met, teal from min to max; ink tick at the min mark. The label
 * separates the live count (the datum: 16px semibold, teal once viable)
 * from the configured "/ min–max" range (quiet 12px brown) — the bar
 * already marks both ends spatially.
 */
export function RegistrationProgress({ registered, min, max, className = '' }: RegistrationProgressProps) {
  const pct = Math.min(100, (registered / max) * 100);
  const minPct = Math.min(100, (min / max) * 100);
  const met = registered >= min;

  return (
    <div className={className}>
      <div className="flex items-baseline justify-end gap-2 mb-1">
        <span
          className={`text-base leading-none font-semibold tabular-nums ${met ? 'text-teal' : 'text-brown'}`}
        >
          {registered}
        </span>
        <span className="text-[12px] tabular-nums text-brown">
          / {min}–{max}
        </span>
      </div>
      <div className="relative h-2 bg-border rounded-[4px]">
        <div
          className={`absolute inset-y-0 left-0 rounded-[4px] ${met ? 'bg-teal' : 'bg-danger'}`}
          style={{ width: `${pct}%` }}
        />
        {min > 0 && min < max && (
          <div
            className="absolute -top-0.5 -bottom-0.5 w-0.5 bg-ink rounded-[1px]"
            style={{ left: `${minPct}%` }}
          />
        )}
      </div>
    </div>
  );
}
