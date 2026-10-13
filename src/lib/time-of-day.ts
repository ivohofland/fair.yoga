/** `Date` from a `@db.Time` column → the `"HH:MM"` every wire format uses. */
export function timeToHHmm(t: Date): string {
  return `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`;
}

/** `"HH:MM"` → the `Date` a `@db.Time` column accepts. Caller validates with `timeHHmm`. */
export function hhmmToTime(s: string): Date {
  return new Date(`1970-01-01T${s}:00Z`);
}

/** A start-time input's `step`, in seconds: five minutes, the grid classes start on. */
export const START_TIME_STEP_SECONDS = 300;

/**
 * The `step` for a start-time input opened on `saved` — the row's stored
 * `"HH:MM"`, never the value being typed. Off the five-minute grid it falls
 * back to one minute, so the browser does not refuse a row saved before the
 * step existed.
 */
export function startTimeStep(saved?: string): number {
  if (!saved) return START_TIME_STEP_SECONDS;
  const minutes = Number(saved.slice(3, 5));
  return minutes % (START_TIME_STEP_SECONDS / 60) === 0 ? START_TIME_STEP_SECONDS : 60;
}
