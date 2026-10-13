/** `Date` from a `@db.Time` column → the `"HH:MM"` every wire format uses. */
export function timeToHHmm(t: Date): string {
  return `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`;
}

/** `"HH:MM"` → the `Date` a `@db.Time` column accepts. Caller validates with `timeHHmm`. */
export function hhmmToTime(s: string): Date {
  return new Date(`1970-01-01T${s}:00Z`);
}

const START_TIME_STEP_SECONDS = 300;

/**
 * The `min` and `step` for a start-time input, given the stored `"HH:MM"` it
 * opens on (absent for a new row). Five-minute steps counted from midnight:
 * without `min`, the browser counts steps from the `value` attribute, so the
 * grid would follow whatever time the field holds. A stored time off that
 * grid gets a one-minute step, so the browser does not refuse to submit it
 * unchanged. Pass the stored value, not the field's live one: the step must
 * not change while the teacher edits.
 */
export function startTimeInputProps(saved?: string): { min: string; step: number } {
  const minutes = saved ? Number(saved.slice(3, 5)) : 0;
  const onGrid = minutes % (START_TIME_STEP_SECONDS / 60) === 0;
  return { min: '00:00', step: onGrid ? START_TIME_STEP_SECONDS : 60 };
}
