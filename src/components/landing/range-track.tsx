import type { InputHTMLAttributes } from 'react';

interface RangeTrackProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'min' | 'max' | 'value' | 'className'> {
  value: number;
  min: number;
  max: number;
  /** Fill colour class for the stretch up to the thumb. */
  fillClass: string;
  /** Draws the ink tick the class cards use for a minimum. */
  tick?: number;
}

/**
 * Where `n` sits on the thumb's travel, which is the track less one thumb
 * width, so the fill ends and the tick stands under the thumb's centre.
 */
function along(n: number, min: number, max: number): string {
  const fraction = Math.round(((n - min) / (max - min)) * 1000) / 1000;
  return `calc(var(--thumb) / 2 + (100% - var(--thumb)) * ${fraction})`;
}

/**
 * A native range input that is its own progress bar: the track, fill and
 * tick are drawn underneath, and the input on top shows only its thumb.
 */
export function RangeTrack({ value, min, max, fillClass, tick, ...input }: RangeTrackProps) {
  return (
    <div className="range-track relative">
      <div aria-hidden="true" className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-2 rounded-[4px] bg-border">
        <div
          data-range-fill
          className={`absolute inset-y-0 left-0 rounded-[4px] ${fillClass}`}
          style={{ width: along(value, min, max) }}
        />
        {tick !== undefined && (
          <div
            data-range-tick
            className="absolute -top-[3px] -bottom-[3px] w-0.5 -ml-px bg-ink rounded-[1px]"
            style={{ left: along(tick, min, max) }}
          />
        )}
      </div>
      <input {...input} type="range" min={min} max={max} value={value} className="range-track-input relative block w-full" />
    </div>
  );
}
