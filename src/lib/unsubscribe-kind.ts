/**
 * What an unsubscribe link can act on (spec:
 * docs/superpowers/specs/2026-10-10-list-unsubscribe-design.md, Decision 3).
 * Imports nothing, so the client form can use it.
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

/**
 * An invitation's subject: its id and a tag of the address it was sent to,
 * joined by `~`. Minted only by `invitationSubject` (`unsubscribe-token.ts`)
 * and by `parseUnsubscribePayload` after a shape check.
 */
export type InvitationSubject = string & { readonly __brand: 'InvitationSubject' };

export type UnsubscribeTarget =
  | { kind: Exclude<UnsubscribeKind, 'invitation'>; subjectId: string }
  | { kind: 'invitation'; subjectId: InvitationSubject };

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
  if (!isUnsubscribeKind(kind)) return null;
  if (kind !== 'invitation') return { kind, subjectId };
  return isInvitationShape(subjectId) ? { kind, subjectId: subjectId as InvitationSubject } : null;
}

/** Exactly one `~`, with something on both sides of it. */
function isInvitationShape(subjectId: string): boolean {
  const halves = subjectId.split('~');
  return halves.length === 2 && halves[0] !== '' && halves[1] !== '';
}

/** The kind a token claims. Not a verification: anyone can write a payload. */
export function peekUnsubscribeKind(token: string): UnsubscribeKind | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  return parseUnsubscribePayload(token.slice(0, dot))?.kind ?? null;
}
