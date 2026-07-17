interface RegistrationProgressProps {
  registered: number;
  min: number;
  max: number;
  className?: string;
}

/**
 * The signature element on class cards. 8px track; fill is danger until the
 * minimum is met, teal from min to max; ink tick at the min mark; tabular
 * fraction label above right ("8 / 6–14").
 */
export function RegistrationProgress({ registered, min, max, className = '' }: RegistrationProgressProps) {
  const pct = Math.min(100, (registered / max) * 100);
  const minPct = Math.min(100, (min / max) * 100);
  const met = registered >= min;

  return (
    <div className={className}>
      <div className="flex justify-end mb-1">
        <span
          className={`text-[13px] font-semibold tabular-nums ${met ? 'text-teal' : 'text-brown'}`}
        >
          {registered} / {min}–{max}
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
