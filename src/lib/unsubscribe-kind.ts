/**
 * What an unsubscribe link can switch off, one member per preference it
 * flips (spec: docs/superpowers/specs/2026-10-10-list-unsubscribe-design.md,
 * Decision 3). Imports nothing server-only.
 */
export type UnsubscribeKind =
  | 'student_notifications'
  | 'teacher_bookings'
  | 'teacher_class_completed'
  | 'teacher_invitations'
  | 'student_reminders'
  | 'teacher_reminders'
  | 'invitation';

export const UNSUBSCRIBE_KINDS = {
  student_notifications: true,
  teacher_bookings: true,
  teacher_class_completed: true,
  teacher_invitations: true,
  student_reminders: true,
  teacher_reminders: true,
  invitation: true,
} as const satisfies Record<UnsubscribeKind, true>;

export interface UnsubscribeTarget {
  kind: UnsubscribeKind;
  subjectId: string;
}

export const UNSUBSCRIBE_TOKEN_VERSION = 'v1';

export function isUnsubscribeKind(value: string): value is UnsubscribeKind {
  return Object.hasOwn(UNSUBSCRIBE_KINDS, value);
}

function decodeBase64Url(segment: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return null;
  try {
    const b64 = segment.replaceAll('-', '+').replaceAll('_', '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    return new TextDecoder().decode(Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

/** Splits a token payload into its target, or null when it is malformed. */
export function parseUnsubscribePayload(encoded: string): UnsubscribeTarget | null {
  const payload = decodeBase64Url(encoded);
  if (payload === null) return null;
  const [version, kind, subjectId, ...rest] = payload.split('.');
  if (
    version !== UNSUBSCRIBE_TOKEN_VERSION ||
    kind === undefined ||
    subjectId === undefined ||
    subjectId === '' ||
    rest.length > 0
  ) {
    return null;
  }
  return isUnsubscribeKind(kind) ? { kind, subjectId } : null;
}

/** The kind a token claims. Not a verification: anyone can write a payload. */
export function peekUnsubscribeKind(token: string): UnsubscribeKind | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  return parseUnsubscribePayload(token.slice(0, dot))?.kind ?? null;
}
