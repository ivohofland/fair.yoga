/** `Date` from a `@db.Time` column → the `"HH:MM"` every wire format uses. */
export function timeToHHmm(t: Date): string {
  return `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`;
}

/** `"HH:MM"` → the `Date` a `@db.Time` column accepts. Caller validates with `timeHHmm`. */
export function hhmmToTime(s: string): Date {
  return new Date(`1970-01-01T${s}:00Z`);
}
