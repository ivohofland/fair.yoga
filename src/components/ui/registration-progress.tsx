import type { SkeletonSurface } from '@/components/ui/skeleton';
import { Skeleton } from '@/components/ui/skeleton';

interface RegistrationProgressProps {
  registered: number;
  min: number;
  max: number;
  className?: string;
}

// The count row and the track, shared by the real bar and its skeleton so
// neither can drift from the other's shape.
const COUNT_ROW = 'flex items-baseline justify-end gap-[5px] mb-1';
const TRACK = 'relative h-2';

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
      <div className={COUNT_ROW}>
        <span
          className={`text-base leading-none font-semibold tabular-nums ${met ? 'text-teal' : 'text-brown'}`}
        >
          {registered}
        </span>
        <span className="text-[12px] tabular-nums text-brown">
          / {min}–{max}
        </span>
      </div>
      <div className={`${TRACK} bg-border rounded-[4px]`}>
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

interface RegistrationProgressSkeletonProps {
  className?: string;
  surface?: SkeletonSurface;
}

// A placeholder the shape of the real bar: a transparent count row (so the
// line box keeps its height) above a surface-filled track.
export function RegistrationProgressSkeleton({ className = '', surface = 'page' }: RegistrationProgressSkeletonProps) {
  return (
    <div aria-hidden="true" className={className}>
      <div className={COUNT_ROW}>
        <span className="text-base leading-none font-semibold tabular-nums text-transparent">0</span>
        <span className="text-[12px] tabular-nums text-transparent">/ 0–0</span>
      </div>
      <Skeleton surface={surface} className={TRACK} />
    </div>
  );
}
