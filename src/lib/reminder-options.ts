import type { ReminderChannel, ReminderTiming } from '@prisma/client';
import type { NoneOf } from './type-pins';

export const REMINDER_TIMING_OPTIONS = [
  { value: 'evening_before', label: 'Evening before' },
  { value: 'morning_of', label: 'Morning of class' },
  { value: 'one_hour_before', label: '1 hour before' },
  { value: 'off', label: 'Off' },
] as const satisfies ReadonlyArray<{ value: ReminderTiming; label: string }>;

export const REMINDER_CHANNEL_OPTIONS = [
  { value: 'inbox', label: 'In the app' },
  { value: 'email', label: 'By email' },
  { value: 'inbox_and_email', label: 'In the app and by email' },
] as const satisfies ReadonlyArray<{ value: ReminderChannel; label: string }>;

const _everyTiming: NoneOf<Exclude<ReminderTiming, (typeof REMINDER_TIMING_OPTIONS)[number]['value']>> = true;
const _everyChannel: NoneOf<Exclude<ReminderChannel, (typeof REMINDER_CHANNEL_OPTIONS)[number]['value']>> = true;
void _everyTiming;
void _everyChannel;

export function isReminderTiming(v: string): v is ReminderTiming {
  return REMINDER_TIMING_OPTIONS.some((o) => o.value === v);
}
export function isReminderChannel(v: string): v is ReminderChannel {
  return REMINDER_CHANNEL_OPTIONS.some((o) => o.value === v);
}
