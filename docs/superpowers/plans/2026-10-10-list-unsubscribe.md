# One-click unsubscribe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every opt-out-able email carries RFC 8058 `List-Unsubscribe` + `List-Unsubscribe-Post` headers and a footer link; one POST with a signed token flips exactly one existing preference; no essential or security email carries either.

**Architecture:** A pure, client-safe module names the unsubscribe kinds; a server module signs and verifies `v1.<kind>.<subjectId>` tokens with HMAC-SHA256 under `UNSUBSCRIBE_SECRET`. `EmailMessage` gains a required `unsubscribe` target so every send site decides; `sendEmail` spells the headers. A framework-agnostic service applies the opt-out; `/api/unsubscribe` (POST does it, GET 303s to the page) and a public `/unsubscribe` confirm page sit on top, the #786 payout-pause shape.

**Tech Stack:** Next.js 16 App Router, TypeScript strict, Prisma/PostgreSQL, `node:crypto`, Vitest (unit / components / integration projects).

**Spec:** `docs/superpowers/specs/2026-10-10-list-unsubscribe-design.md` — read it first; the switch table in Decision 3 is normative.

## Global Constraints

- No `any`. Exhaustive unions close with `const unhandled: never`; membership tethers use `satisfies Record<…>` (CLAUDE.md, *Comment Discipline*).
- Comments annotate the code they sit on — no counts, no member rosters, no history ("previously…"). Wider facts go in `docs/` and the comment links there.
- Every new error code is registered in `src/lib/api-error-codes.ts`; tests assert the **code**, never the message.
- "Already done" answers `respondUnchanged`, never an error.
- Tests run in the worktree against its own app: `pnpm run worktree:setup` once, `pnpm run worktree:up` before `--project integration`. Never touch the dev server on `:3000`.
- Node ≥ 24.15 (`export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"` if `node -v` is older).
- Stage exact paths; quote paths containing `(public)`. Never `git add -A`.
- Commit messages end with `(#801)` and the `Co-Authored-By` line from the session.
- Copy: calm, plain, second person, no exclamation marks; design tokens only (`type-*`, `text-teal`, `text-danger`), no new colours.

## Review Focus

1. **A webmail client POSTs with its own `Origin` and a `multipart/form-data` body** — the opt-out must still happen (Task 5: foreign-Origin test, multipart test).
2. **The token arrives URL-encoded or with trailing whitespace from a mail client** — `?t=` is read via `URLSearchParams`, which decodes; a base64url token contains no characters needing encoding, and verification refuses anything else with the uniform 404 rather than a 500 (Task 1: garbage inputs never throw).
3. **A teacher who is also a student unsubscribes from one hat's mail** — only that profile's switch moves (Task 4: two-hat isolation test).
4. **The invitation was edited to a new address (`PUT /api/invitations/[id]`) after the email went out** — a stranger at the *old* address pressing Unsubscribe must not decline the invitation or `TeacherBlock` the *new* address. The invitation token's subject binds the address it was sent to (`invitationSubject`, Task 1), and the service answers `invalid` when the row's current address no longer matches (Task 4).
5. **Production with `UNSUBSCRIBE_SECRET` unset** — mail still sends, with no header and no footer link, and verification refuses every token (Task 1 + Task 3 tests).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/unsubscribe-kind.ts` (create) | `UnsubscribeKind` union, `UNSUBSCRIBE_KINDS` tether, `UnsubscribeTarget`, `peekUnsubscribeKind` (client-safe, no crypto) |
| `src/lib/unsubscribe-token.ts` (create) | key resolution, `signUnsubscribeToken`, `verifyUnsubscribeToken`, `unsubscribeLinks` (server-only) |
| `src/services/notification-policy.ts` (modify) | per-type unsubscribe mapping beside `shouldEmail*` |
| `src/lib/email.ts`, `src/lib/email-templates.ts` (modify) | required `unsubscribe` field, headers, footer link |
| `src/services/email-fallback.ts`, `class-reminders.ts`, `invitations.ts`, `degradation-digest.ts` (modify) | pass targets |
| `src/services/unsubscribe.ts` (create) | `unsubscribe(db, target)` applies the opt-out |
| `src/app/api/unsubscribe/route.ts` (create) | POST / GET |
| `src/app/(public)/unsubscribe/page.tsx`, `unsubscribe-form.tsx` (create) | confirm page |

Task order is load-bearing: 1 → 2 → 3 → 4 → 5 → 6. Task 3 changes `EmailMessage` and will not compile until every call site passes `unsubscribe`, so it is one task.

---

### Task 1: Kinds and the signed token

**Files:**
- Create: `src/lib/unsubscribe-kind.ts`, `src/lib/unsubscribe-kind.test.ts`
- Create: `src/lib/unsubscribe-token.ts`, `src/lib/unsubscribe-token.test.ts`
- Modify: `docs/technical-architecture.md` (Environment Variables block near line 1497), `DEPLOYMENT.md` (env table near line 25)

**Interfaces:**
- Produces:
  - `type UnsubscribeKind = 'student_notifications' | 'teacher_bookings' | 'teacher_class_completed' | 'teacher_invitations' | 'student_reminders' | 'teacher_reminders' | 'invitation'`
  - `interface UnsubscribeTarget { kind: UnsubscribeKind; subjectId: string }`
  - `isUnsubscribeKind(value: string): value is UnsubscribeKind`
  - `peekUnsubscribeKind(token: string): UnsubscribeKind | null` — decodes the payload only; **not** a verification.
  - `signUnsubscribeToken(target: UnsubscribeTarget): string | null` (null when no key)
  - `verifyUnsubscribeToken(token: string): UnsubscribeTarget | null`
  - `unsubscribeLinks(target: UnsubscribeTarget): { oneClick: string; page: string } | null`
  - `invitationSubject(invitationId: string, email: string): string` — `${invitationId}~${addressTag(email)}`
  - `parseInvitationSubject(subjectId: string): { invitationId: string; tag: string } | null`
  - `addressTag(email: string): string` — first 22 chars of base64url SHA-256 of the lowercase address (no `.` or `~` can occur in it)

- [ ] **Step 1: Write failing tests for the kind module**

`src/lib/unsubscribe-kind.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { isUnsubscribeKind, peekUnsubscribeKind, UNSUBSCRIBE_KINDS } from './unsubscribe-kind';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

describe('unsubscribe kinds', () => {
  it('recognises every registered kind and nothing else', () => {
    for (const kind of Object.keys(UNSUBSCRIBE_KINDS)) expect(isUnsubscribeKind(kind)).toBe(true);
    expect(isUnsubscribeKind('magic_link')).toBe(false);
    expect(isUnsubscribeKind('toString')).toBe(false);
  });

  it('peeks the kind from a token payload without verifying it', () => {
    expect(peekUnsubscribeKind(`${b64('v1.teacher_bookings.abc')}.sig`)).toBe('teacher_bookings');
  });

  it.each(['', 'nodot', `${b64('v2.teacher_bookings.abc')}.sig`, `${b64('v1.nope.abc')}.sig`, '%%%.sig'])(
    'answers null for %j',
    (token) => {
      expect(peekUnsubscribeKind(token)).toBeNull();
    },
  );
});
```

- [ ] **Step 2: Run, expect FAIL** — `pnpm exec vitest run --project unit src/lib/unsubscribe-kind.test.ts` → cannot resolve `./unsubscribe-kind`.

- [ ] **Step 3: Implement `src/lib/unsubscribe-kind.ts`**

Client-safe: no `node:` imports (the confirm page imports it). Decode base64url with `atob` after mapping `-`→`+`, `_`→`/` and padding, inside `try`.

```ts
/**
 * What an unsubscribe link can switch off, one member per preference it
 * flips (spec: docs/superpowers/specs/2026-10-10-list-unsubscribe-design.md,
 * Decision 3). Client-safe: the confirm page reads the kind to say what will
 * change.
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

/** Splits a token payload into its target; shared by `peekUnsubscribeKind` and verification. */
export function parseUnsubscribePayload(encoded: string): UnsubscribeTarget | null {
  const payload = decodeBase64Url(encoded);
  if (payload === null) return null;
  const [version, kind, subjectId, ...rest] = payload.split('.');
  if (version !== UNSUBSCRIBE_TOKEN_VERSION || kind === undefined || subjectId === undefined || subjectId === '' || rest.length > 0) return null;
  return isUnsubscribeKind(kind) ? { kind, subjectId } : null;
}

/** The kind a token claims. Not a verification: anyone can write a payload. */
export function peekUnsubscribeKind(token: string): UnsubscribeKind | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  return parseUnsubscribePayload(token.slice(0, dot))?.kind ?? null;
}
```

- [ ] **Step 4: Run, expect PASS.**

- [ ] **Step 5: Write failing tests for the token module**

`src/lib/unsubscribe-token.test.ts` — use `vi.stubEnv` / `vi.unstubAllEnvs` in `afterEach`; reset module state with `vi.resetModules()` + dynamic `import('./unsubscribe-token')` per test where the one-time warning matters.

```ts
import { describe, it, expect, afterEach, vi } from 'vitest';

const SECRET = 'x'.repeat(32);
async function load() {
  vi.resetModules();
  return import('./unsubscribe-token');
}
afterEach(() => vi.unstubAllEnvs());

describe('unsubscribe token', () => {
  it('round-trips a target', async () => {
    vi.stubEnv('UNSUBSCRIBE_SECRET', SECRET);
    const { signUnsubscribeToken, verifyUnsubscribeToken } = await load();
    const token = signUnsubscribeToken({ kind: 'student_reminders', subjectId: 'stu_1' });
    expect(token).not.toBeNull();
    expect(verifyUnsubscribeToken(token!)).toEqual({ kind: 'student_reminders', subjectId: 'stu_1' });
  });

  it('refuses a tampered payload, a tampered MAC, and another key', async () => {
    vi.stubEnv('UNSUBSCRIBE_SECRET', SECRET);
    const mod = await load();
    const token = mod.signUnsubscribeToken({ kind: 'teacher_bookings', subjectId: 't_1' })!;
    const [payload, mac] = token.split('.');
    const forgedPayload = Buffer.from('v1.teacher_bookings.t_2').toString('base64url');
    expect(mod.verifyUnsubscribeToken(`${forgedPayload}.${mac}`)).toBeNull();
    expect(mod.verifyUnsubscribeToken(`${payload}.${mac!.slice(0, -2)}AA`)).toBeNull();
    vi.stubEnv('UNSUBSCRIBE_SECRET', 'y'.repeat(32));
    const other = await load();
    expect(other.verifyUnsubscribeToken(token)).toBeNull();
  });

  it.each(['', '.', 'a.b.c', 'garbage', `${'A'.repeat(5000)}.x`, 'v1%2E.x'])('never throws on %j', async (t) => {
    vi.stubEnv('UNSUBSCRIBE_SECRET', SECRET);
    const { verifyUnsubscribeToken } = await load();
    expect(verifyUnsubscribeToken(t)).toBeNull();
  });

  it('in production without a secret: signs nothing, verifies nothing, warns once', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('UNSUBSCRIBE_SECRET', '');
    const { log } = await import('@/lib/log');
    const warn = vi.spyOn(log, 'warn');
    const { signUnsubscribeToken, unsubscribeLinks } = await load();
    expect(signUnsubscribeToken({ kind: 'invitation', subjectId: 'i' })).toBeNull();
    expect(unsubscribeLinks({ kind: 'invitation', subjectId: 'i' })).toBeNull();
    expect(warn.mock.calls.filter(([, m]) => String(m).includes('UNSUBSCRIBE_SECRET'))).toHaveLength(1);
  });

  it('treats a secret shorter than 32 bytes as unset in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('UNSUBSCRIBE_SECRET', 'short');
    const { signUnsubscribeToken } = await load();
    expect(signUnsubscribeToken({ kind: 'invitation', subjectId: 'i' })).toBeNull();
  });

  it('uses a development key outside production', async () => {
    vi.stubEnv('UNSUBSCRIBE_SECRET', '');
    const { signUnsubscribeToken, verifyUnsubscribeToken } = await load();
    const token = signUnsubscribeToken({ kind: 'invitation', subjectId: 'i' })!;
    expect(verifyUnsubscribeToken(token)).toEqual({ kind: 'invitation', subjectId: 'i' });
  });

  it('binds an invitation subject to its address', async () => {
    const { invitationSubject, parseInvitationSubject, addressTag } = await load();
    const subject = invitationSubject('inv_1', 'Ana@Example.test');
    expect(subject).not.toContain('.');
    expect(parseInvitationSubject(subject)).toEqual({ invitationId: 'inv_1', tag: addressTag('ana@example.test') });
    expect(addressTag('ana@example.test')).not.toBe(addressTag('ana@example.tesT'.replace('T', 'x')));
    expect(parseInvitationSubject('inv_1')).toBeNull();
  });

  it('builds the one-click URL and the fragment page URL', async () => {
    vi.stubEnv('UNSUBSCRIBE_SECRET', SECRET);
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://fair.yoga');
    const { unsubscribeLinks, signUnsubscribeToken } = await load();
    const token = signUnsubscribeToken({ kind: 'invitation', subjectId: 'i' })!;
    expect(unsubscribeLinks({ kind: 'invitation', subjectId: 'i' })).toEqual({
      oneClick: `https://fair.yoga/api/unsubscribe?t=${token}`,
      page: `https://fair.yoga/unsubscribe#t=${token}`,
    });
  });
});
```

If `@/lib/log` cannot be imported under the unit project (`server-only`), follow the alias described in its header — the unit project already aliases it.

- [ ] **Step 6: Run, expect FAIL.**

- [ ] **Step 7: Implement `src/lib/unsubscribe-token.ts`**

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';
import { log } from '@/lib/log';
import { parseUnsubscribePayload, UNSUBSCRIBE_TOKEN_VERSION, type UnsubscribeTarget } from '@/lib/unsubscribe-kind';

const MIN_SECRET_BYTES = 32;
const DEV_KEY = 'fair.yoga development unsubscribe key, never used in production';
const MAC_DOMAIN = 'unsubscribe:';

let warnedNoSecret = false;

/** The signing key; null in production without a usable secret, which disables unsubscribe links. */
function key(): string | null {
  const secret = process.env.UNSUBSCRIBE_SECRET?.trim() ?? '';
  if (Buffer.byteLength(secret) >= MIN_SECRET_BYTES) return secret;
  if (process.env.NODE_ENV !== 'production') return DEV_KEY;
  if (!warnedNoSecret) {
    warnedNoSecret = true;
    log.warn({}, 'UNSUBSCRIBE_SECRET is unset or shorter than 32 bytes; mail is sent without unsubscribe links');
  }
  return null;
}

function mac(k: string, payload: string): Buffer {
  return createHmac('sha256', k).update(MAC_DOMAIN + payload).digest();
}

export function signUnsubscribeToken(target: UnsubscribeTarget): string | null {
  const k = key();
  if (k === null) return null;
  const payload = Buffer.from(`${UNSUBSCRIBE_TOKEN_VERSION}.${target.kind}.${target.subjectId}`, 'utf8').toString('base64url');
  return `${payload}.${mac(k, payload).toString('base64url')}`;
}

/** The target a token was signed for, or null. Never throws and never reads the database. */
export function verifyUnsubscribeToken(token: string): UnsubscribeTarget | null {
  const k = key();
  if (k === null) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, presented] = parts as [string, string];
  if (!/^[A-Za-z0-9_-]+$/.test(presented)) return null;
  const expected = mac(k, payload);
  const given = Buffer.from(presented, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return parseUnsubscribePayload(payload);
}

/** The header URL (POST target) and the page URL (token in the fragment). */
export function unsubscribeLinks(target: UnsubscribeTarget): { oneClick: string; page: string } | null {
  const token = signUnsubscribeToken(target);
  if (token === null) return null;
  const base = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  return { oneClick: `${base}/api/unsubscribe?t=${token}`, page: `${base}/unsubscribe#t=${token}` };
}
```

Also in this module (uses `createHash` from `node:crypto`):

```ts
/**
 * An invitation is addressed mail, and its address can be edited after the
 * email went out; the subject carries the address it was sent to so a link
 * at an old address cannot decline for a new one.
 */
export function addressTag(email: string): string {
  return createHash('sha256').update(email.toLowerCase()).digest('base64url').slice(0, 22);
}

export function invitationSubject(invitationId: string, email: string): string {
  return `${invitationId}~${addressTag(email)}`;
}

export function parseInvitationSubject(subjectId: string): { invitationId: string; tag: string } | null {
  const [invitationId, tag, ...rest] = subjectId.split('~');
  if (!invitationId || !tag || rest.length > 0) return null;
  return { invitationId, tag };
}
```

`@/lib/log` imports `server-only`, which is what keeps this module out of client bundles.

- [ ] **Step 8: Run both test files, expect PASS.**

- [ ] **Step 9: Prove the MAC check bites.** Temporarily replace the `timingSafeEqual` condition with `false` (`if (false)`) → the tamper test must FAIL; record the failing assertion text in the task report; restore; re-run PASS.

- [ ] **Step 10: Document the secret.** Add to the env block in `docs/technical-architecture.md` (beside `LETTERMINT_CLASS_ROUTE`):

```
UNSUBSCRIBE_SECRET=         # ≥32 bytes; signs unsubscribe links. Unset in production: mail sends without them
```

and a row to `DEPLOYMENT.md`'s env table:

```
| `UNSUBSCRIBE_SECRET` | `openssl rand -hex 32` — signs the one-click unsubscribe links. Unset or shorter than 32 bytes, mail still sends but carries no `List-Unsubscribe` header and no footer link. Rotating it voids every unsubscribe link already sent |
```

- [ ] **Step 11: Commit** — `feat: signed unsubscribe tokens and their kinds (#801)`.

---

### Task 2: Which notification types carry an unsubscribe

**Files:**
- Modify: `src/services/notification-policy.ts`
- Modify: `src/services/notification-policy.test.ts`

**Interfaces:**
- Consumes: `UnsubscribeKind`, `UnsubscribeTarget` (Task 1).
- Produces:
  - `studentUnsubscribeKind(type: NotificationType): UnsubscribeKind | null`
  - `teacherUnsubscribeKind(type: TeacherNotificationType): UnsubscribeKind | null`

- [ ] **Step 1: Write failing tests** (append to `notification-policy.test.ts`):

```ts
import { $Enums } from '@prisma/client';
import { studentUnsubscribeKind, teacherUnsubscribeKind, shouldEmailStudent, shouldEmailTeacher, type TeacherNotificationType, type TeacherNotificationPrefs } from './notification-policy';

describe('unsubscribe classification', () => {
  it('a student type carries an unsubscribe exactly when the student can switch its email off', () => {
    for (const type of Object.values($Enums.NotificationType)) {
      const optional = shouldEmailStudent(type, false) === false;
      expect(studentUnsubscribeKind(type), type).toBe(optional ? 'student_notifications' : null);
    }
  });

  it('a teacher type carries an unsubscribe exactly when its email depends on a preference', () => {
    const on: TeacherNotificationPrefs = { bookingNotifications: 'inbox_and_email', emailOnClassCompleted: true, emailOnInvitation: true, classReminder: 'morning_of', classReminderChannel: 'inbox_and_email' };
    const off: TeacherNotificationPrefs = { ...on, bookingNotifications: 'inbox_only', emailOnClassCompleted: false, emailOnInvitation: false };
    const types: TeacherNotificationType[] = ['booking_confirmed', 'class_cancelled', 'payment_request', 'teacher_invitation', 'class_reminder'];
    for (const type of types) {
      const dependsOnPreference = shouldEmailTeacher(type, on) !== shouldEmailTeacher(type, off);
      expect(teacherUnsubscribeKind(type) !== null, type).toBe(dependsOnPreference);
    }
    expect(teacherUnsubscribeKind('booking_confirmed')).toBe('teacher_bookings');
    expect(teacherUnsubscribeKind('payment_request')).toBe('teacher_class_completed');
    expect(teacherUnsubscribeKind('teacher_invitation')).toBe('teacher_invitations');
  });
});
```

The `types` array in the teacher test is a list in a test; tether it with `satisfies Record<TeacherNotificationType, true>` as an object and iterate `Object.keys`, so a new member fails here too.

- [ ] **Step 2: Run, expect FAIL** — `pnpm exec vitest run --project unit src/services/notification-policy.test.ts`.

- [ ] **Step 3: Implement** beside `shouldEmailStudent` / `TEACHER_EMAIL_POLICY`:

```ts
import type { UnsubscribeKind } from '@/lib/unsubscribe-kind';

/** The student has one email switch, so every optional type unsubscribes through it. */
export function studentUnsubscribeKind(type: NotificationType): UnsubscribeKind | null {
  return isEssential(type) ? null : 'student_notifications';
}

/**
 * Which preference a teacher's unsubscribe flips, per type; `null` where no
 * preference governs the email. Kept beside `TEACHER_EMAIL_POLICY` so a new
 * type is classified for both at once.
 */
const TEACHER_UNSUBSCRIBE = {
  class_cancelled: null,
  booking_confirmed: 'teacher_bookings',
  payment_request: 'teacher_class_completed',
  teacher_invitation: 'teacher_invitations',
  class_reminder: null,
} as const satisfies Record<TeacherNotificationType, UnsubscribeKind | null>;

export function teacherUnsubscribeKind(type: TeacherNotificationType): UnsubscribeKind | null {
  return TEACHER_UNSUBSCRIBE[type];
}
```

- [ ] **Step 4: Run, expect PASS.**

- [ ] **Step 5: Prove the tether bites.** Change `payment_request: 'teacher_class_completed'` to `null` → the "depends on a preference" test FAILS; restore. Remove `'payment_request'` from `ESSENTIAL_NOTIFICATION_TYPES` → the student test FAILS; restore. Record both error texts.

- [ ] **Step 6: Commit** — `feat: classify which notification types carry an unsubscribe (#801)`.

---

### Task 3: Every send decides — headers and footer link

**Files:**
- Modify: `src/lib/email.ts`, `src/lib/email.test.ts` (and `email.wire.test.ts` if it builds `EmailMessage` literals)
- Modify: `src/lib/email-templates.ts`, `src/lib/email-templates.test.ts`
- Modify: `src/services/email-fallback.ts`, `src/services/class-reminders.ts`, `src/services/invitations.ts`, `src/services/degradation-digest.ts`
- Modify: their existing tests that assert `sendEmail` calls (find with `grep -rln "sendEmail" src tests | grep test`)
- Modify: `docs/technical-architecture.md` line ~168 (the `sendEmail` signature sentence)

**Interfaces:**
- Consumes: `UnsubscribeTarget`, `unsubscribeLinks` (Task 1); `studentUnsubscribeKind`, `teacherUnsubscribeKind` (Task 2).
- Produces:
  - `EmailMessage.unsubscribe: UnsubscribeTarget | null` (required)
  - `wrapEmail(heading, blocks, footer, unsubscribeUrl?: string)`
  - `renderNotificationEmail(notification, baseUrl?, footer?, unsubscribeUrl?)`
  - `renderInvitationEmail(teacherName, signInUrl, unsubscribeUrl?)`
  - `sendInvitationEmail(to, teacherName, signInUrl, invitationId: string)`

- [ ] **Step 1: Failing tests in `email.test.ts`** (follow the file's existing pattern for capturing the Lettermint payload — it mocks `deliverViaLettermint`):

```ts
it('adds both RFC 8058 headers for an unsubscribe target', async () => {
  // token configured, not dry-run (copy the file's existing setup for a real send)
  await sendEmail({ to: 'a@b.test', audience: 'class', content, unsubscribe: { kind: 'student_notifications', subjectId: 's1' } });
  const payload = deliverMock.mock.calls[0]![0];
  expect(payload.headers?.['List-Unsubscribe']).toMatch(/^<https?:\/\/[^>]+\/api\/unsubscribe\?t=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+>$/);
  expect(payload.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
});

it('adds neither header for a null target', async () => {
  await sendEmail({ to: 'a@b.test', audience: 'platform', content, unsubscribe: null });
  const payload = deliverMock.mock.calls[0]![0];
  expect(payload.headers?.['List-Unsubscribe']).toBeUndefined();
  expect(payload.headers?.['List-Unsubscribe-Post']).toBeUndefined();
});

it.each([
  ['magic link', () => sendMagicLinkEmail('a@b.test', link)],
  ['passkey added', () => sendPasskeyAddedEmail('a@b.test', new Date())],
  ['passkey removed', () => sendPasskeyRemovedEmail('a@b.test', new Date())],
  ['payout changed', () => sendPayoutChangedEmail('a@b.test', payoutInput)],
])('the %s email carries no List-Unsubscribe', async (_, send) => {
  await send();
  expect(deliverMock.mock.calls[0]![0].headers?.['List-Unsubscribe']).toBeUndefined();
});

it('the invitation email carries an invitation unsubscribe', async () => {
  await sendInvitationEmail('a@b.test', 'Ana', 'https://x/login', 'inv_1');
  const h = deliverMock.mock.calls[0]![0].headers!;
  expect(h['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
});

it('production without UNSUBSCRIBE_SECRET still sends, without the headers', async () => {
  // stub NODE_ENV=production, UNSUBSCRIBE_SECRET='', token set
  const r = await sendEmail({ to: 'a@b.test', audience: 'class', content, unsubscribe: { kind: 'student_notifications', subjectId: 's1' } });
  expect(r.ok).toBe(true);
  expect(deliverMock.mock.calls[0]![0].headers?.['List-Unsubscribe']).toBeUndefined();
});
```

Reuse the file's existing `link` / `payoutInput` fixtures, or build them the way existing tests do. Also add the digest sender's assertion in its own test file (`degradation-digest` test) — operator digest carries no `List-Unsubscribe`.

- [ ] **Step 2: Failing tests in `email-templates.test.ts`:**

```ts
it('renders an unsubscribe link in the footer, html and text, when given one', () => {
  const r = renderNotificationEmail(sampleNotification, 'https://fair.yoga', UNREAD_FALLBACK_FOOTER, 'https://fair.yoga/unsubscribe#t=abc.def');
  expect(r.html).toContain('href="https://fair.yoga/unsubscribe#t=abc.def"');
  expect(r.html).toContain('>Unsubscribe</a>');
  expect(r.text).toContain('Unsubscribe: https://fair.yoga/unsubscribe#t=abc.def');
});

it('renders no unsubscribe link without one', () => {
  expect(renderMagicLinkEmail('https://x').html).not.toContain('Unsubscribe');
});
```

- [ ] **Step 3: Run, expect FAIL (and type errors).**

- [ ] **Step 4: Implement `email-templates.ts`.** `wrapEmail` gains `unsubscribeUrl?: string`. In html, after `${escapeHtml(footer)}`, when present: `<br><a href="${escapeHtml(unsubscribeUrl)}" style="color:#1A5653;">Unsubscribe</a>`. In text, append `\nUnsubscribe: ${unsubscribeUrl}` to the footer block. `renderNotificationEmail` and `renderInvitationEmail` gain a trailing optional `unsubscribeUrl` and pass it through. Leave the footer sentences unchanged.

- [ ] **Step 5: Implement `email.ts`.**
  - `EmailMessage` gains `unsubscribe: UnsubscribeTarget | null;` with docblock: "`null` for mail the recipient cannot switch off; a target adds RFC 8058's two headers (when a signing key is configured). Required so every sender decides."
  - In `sendEmail`, compute `const links = message.unsubscribe === null ? null : unsubscribeLinks(message.unsubscribe);` inside the existing `try`, and merge headers: `{ ...message.headers, ...(links !== null && { 'List-Unsubscribe': `<${links.oneClick}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }) }`, passing `headers` only if the merged object is non-empty.
  - Magic link, passkey ×2, payout: `unsubscribe: null`.
  - `sendInvitationEmail(to, teacherName, signInUrl, invitationId)`: `const target = { kind: 'invitation', subjectId: invitationSubject(invitationId, to) } as const; const links = unsubscribeLinks(target);` render with `links?.page`, send with `unsubscribe: target`.

- [ ] **Step 6: Call sites.**
  - `invitations.ts` (`notifyInvitee`, stranger branch): pass `input.invitationId` as the fourth argument.
  - `degradation-digest.ts`: `unsubscribe: null`.
  - `class-reminders.ts` `emailReminder`: build `const target = { kind: recipientType === 'student' ? 'student_reminders' : 'teacher_reminders', subjectId: context.recipientId } as const;` render with `unsubscribeLinks(target)?.page` as the 4th argument, send with `unsubscribe: target`.
  - `email-fallback.ts`: compute the kind where the recipient is resolved — student branch `studentUnsubscribeKind(notification.type)`; teacher branch `isTeacherNotificationType(notification.type) ? teacherUnsubscribeKind(notification.type) : null` (outside the union it is emailed ignoring preferences, so there is no switch to offer). `const target = kind === null ? null : { kind, subjectId: notification.recipientId };` Pass `unsubscribeLinks(target)?.page` to `renderNotificationEmail` (4th arg, keeping `baseUrl` default by passing `undefined` and `UNREAD_FALLBACK_FOOTER` explicitly) and `unsubscribe: target` to `sendEmail`.

- [ ] **Step 7: Fix existing tests** that assert exact `sendEmail` argument objects (add `unsubscribe`) and add, in `email-fallback.test.ts` and the class-reminders test, one assertion each: an opt-out-able student fallback is sent with `unsubscribe: { kind: 'student_notifications', subjectId: <studentId> }`; an essential type (`class_cancelled`) with `unsubscribe: null`; a teacher `booking_confirmed` with `teacher_bookings`; a reminder with `student_reminders` / `teacher_reminders`.

- [ ] **Step 8: Run** `pnpm exec tsc --noEmit` (no errors) and `pnpm exec vitest run --project unit src/lib/email src/services/email-fallback src/services/class-reminders src/services/invitations src/services/degradation-digest` → PASS.

- [ ] **Step 9: Prove the regression test bites.** Give `sendMagicLinkEmail` `unsubscribe: { kind: 'student_notifications', subjectId: 'x' }` → the magic-link test FAILS; restore.

- [ ] **Step 10: Update** `docs/technical-architecture.md` line ~168: signature becomes `sendEmail({ to, audience, content, unsubscribe, headers?, idempotencyKey? })`, plus one sentence: "`unsubscribe` is required: `null` for mail the recipient cannot switch off, otherwise the target whose `List-Unsubscribe` headers `sendEmail` adds (see *One-click unsubscribe*)."

- [ ] **Step 11: Commit** — `feat: opt-out-able mail carries List-Unsubscribe and a footer link (#801)`.

---

### Task 4: The unsubscribe service

**Files:**
- Create: `src/services/unsubscribe.ts`, `src/services/unsubscribe.test.ts`
- Modify: `src/services/invitations.ts` (extract the decline write)

**Interfaces:**
- Consumes: `UnsubscribeTarget` (Task 1); `isErasedAddress` (`src/lib/erased-address.ts`).
- Produces:
  - `type UnsubscribeOutcome = { status: 'done' } | { status: 'unchanged' } | { status: 'invalid' }`
  - `unsubscribe(db: PrismaClient, target: UnsubscribeTarget): Promise<UnsubscribeOutcome>`
  - In `invitations.ts`: `declinePending(tx: Prisma.TransactionClient, invitation: { id: string; teacherId: string; email: string }): Promise<boolean>` — true when it moved `pending → declined` and wrote the block.

- [ ] **Step 1: Extract `declinePending` from `declineInvitation`.** Move the `updateMany({ status: 'pending' } → declined)` and the `teacherBlock.upsert` (keep their comments, they annotate that code) into `declinePending`, returning `updated.count > 0` (and upserting only then). `declineInvitation` calls it and keeps its own post-miss classification. Run `pnpm exec vitest run --project unit src/services/invitations.decline.test.ts` → PASS unchanged (pure refactor).

- [ ] **Step 2: Write failing service tests** `src/services/unsubscribe.test.ts` (DB-backed, the `payout-pause.test.ts` pattern: real `PrismaClient`, `uniqueSuffix()`, cleanup in `afterAll`). Cases:

| Case | Arrange | Expect |
|---|---|---|
| student_notifications | student `emailNotifications: true` | `done`; now false; second call `unchanged` |
| teacher_bookings | `inbox_and_email` | `done` → `inbox_only`; second `unchanged`; starting `off` → `unchanged` and still `off` |
| teacher_class_completed / teacher_invitations | boolean true | `done` → false |
| student_reminders, channel `inbox_and_email` | | `done` → channel `inbox`, `classReminder` unchanged |
| student_reminders, channel `email` | `classReminder: 'morning_of'` | `done` → `classReminder: 'off'`, channel unchanged |
| teacher_reminders, channel `inbox` | | `unchanged` |
| reminders, `classReminder: 'off'` | channel `email` | `unchanged` |
| invitation pending | | `done`; status `declined`; `TeacherBlock(teacherId, email)` exists |
| invitation declined / accepted | | `unchanged`; no new block for accepted |
| invitation readdressed after send (Review Focus 4) | token minted for the old address, then `update email` to a new one | `invalid`; status still `pending`; no `TeacherBlock` for either address |
| invitation, malformed subject | `subjectId: invitationId` without `~tag` | `invalid` |
| unknown id (each kind) | `crypto.randomUUID()` | `invalid` |
| erased student / teacher | `deletedAt: new Date()` | `invalid` |
| tombstoned invitation | email = `erasedAddress(uuid)` | `invalid` |
| two-hat isolation (Review Focus 3) | account with Teacher + Student; unsubscribe `student_notifications` | student flag false; teacher's three prefs unchanged |
| isolation | two students; unsubscribe one | the other's flag unchanged |

- [ ] **Step 3: Run, expect FAIL.**

- [ ] **Step 4: Implement `src/services/unsubscribe.ts`.** One `db.$transaction` per call. Each branch: a conditional `updateMany` whose `where` names the live subject (`deletedAt: null`) **and** the "still on" state; `count === 1` → `done`; otherwise a `findFirst({ where: { id, deletedAt: null } })` decides `unchanged` (row exists) vs `invalid`. Shape:

```ts
export async function unsubscribe(db: PrismaClient, target: UnsubscribeTarget): Promise<UnsubscribeOutcome> {
  const { kind, subjectId: id } = target;
  return db.$transaction(async (tx) => {
    switch (kind) {
      case 'student_notifications':
        return flip(await tx.student.updateMany({ where: { id, deletedAt: null, emailNotifications: true }, data: { emailNotifications: false } }), () => tx.student.count({ where: { id, deletedAt: null } }));
      case 'teacher_bookings':
        return flip(await tx.teacher.updateMany({ where: { id, deletedAt: null, bookingNotifications: 'inbox_and_email' }, data: { bookingNotifications: 'inbox_only' } }), () => tx.teacher.count({ where: { id, deletedAt: null } }));
      case 'teacher_class_completed': /* emailOnClassCompleted true → false, same shape */
      case 'teacher_invitations':     /* emailOnInvitation true → false, same shape */
      case 'student_reminders':
        return reminders(tx.student, id);
      case 'teacher_reminders':
        return reminders(tx.teacher, id);
      case 'invitation':
        return declineByToken(tx, id);
      default: {
        const unhandled: never = kind;
        throw new Error(`unhandled unsubscribe kind: ${String(unhandled)}`);
      }
    }
  });
}
```

Write the two elided cases out in full. `flip(result, exists)` → `result.count > 0 ? done : (await exists()) > 0 ? unchanged : invalid`. `reminders(delegate, id)`: first `updateMany where { id, deletedAt: null, classReminder: { not: 'off' }, classReminderChannel: 'inbox_and_email' } → { classReminderChannel: 'inbox' }`; if 0, `updateMany where { …, classReminderChannel: 'email' } → { classReminder: 'off' }`; if 0, existence check. Write it twice (student, teacher) rather than abstracting over Prisma delegates if the delegate types do not unify cleanly — no `any`. `declineByToken`: `parseInvitationSubject(subjectId)` (null → `invalid`); `findUnique` invitation `{ id, teacherId, email, status }`; missing, `isErasedAddress(email)`, or `addressTag(email) !== tag` → `invalid`; `status !== 'pending'` → `unchanged`; else `declinePending(tx, …)` → `done`, or `unchanged` if it lost a race.

- [ ] **Step 5: Run, expect PASS.**

- [ ] **Step 6: Prove a guard bites.** Drop `deletedAt: null` from the `student_notifications` `where` and existence check → the erased-student test FAILS; restore.

- [ ] **Step 7: Commit** — `feat: the unsubscribe service flips exactly one preference (#801)`.

---

### Task 5: `/api/unsubscribe`

**Files:**
- Create: `src/app/api/unsubscribe/route.ts`
- Create: `tests/integration/unsubscribe-api.test.ts`
- Modify: `src/lib/api-error-codes.ts` (`UNSUBSCRIBE_LINK_INVALID: 404`)
- Modify: `src/lib/rate-limit.ts` (`'unsubscribe'` in `RateLimitPrefix`, `PREFIX_CAPACITIES` at `1_000`, `IpRateLimitPrefix`)
- Modify: `src/lib/api-utils.ts` (`withErrorHandler` option), `src/lib/api-utils.test.ts` or a new census test
- Modify: `docs/technical-architecture.md` (*Cross-site writes*, *Unauthenticated API routes* census, new *One-click unsubscribe* subsection beside the email seam paragraph)

**Interfaces:**
- Consumes: `verifyUnsubscribeToken` (Task 1), `unsubscribe` (Task 4).
- Produces: `withErrorHandler(handler, options?: { crossOrigin?: 'enforce' | 'token-authorised' })`.

- [ ] **Step 1: Failing integration tests** `tests/integration/unsubscribe-api.test.ts` (pattern: `payout-pause-api.test.ts`; mint tokens in-process with `signUnsubscribeToken` — the test process and the worktree app both fall back to the development key, so they agree unless `UNSUBSCRIBE_SECRET` is set in only one; if minted tokens 404 unexpectedly, check that first):

```ts
const post = (t: string, init: { body?: BodyInit; headers?: Record<string, string> } = {}) =>
  fetch(`${BASE_URL}/api/unsubscribe?t=${encodeURIComponent(t)}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { ...freshIp(), ...init.headers },
    body: init.body ?? new URLSearchParams({ 'List-Unsubscribe': 'One-Click' }),
  });
```

Cases:
- student token → 200; DB flag false; repeat → 200 with `outcome: 'unchanged'` (`expectApplied` / the unchanged assertion helper in `tests/api-assertions.ts`).
- `multipart/form-data` body (`FormData` with the field) → 200.
- `Origin: https://mail.example.com` + `Sec-Fetch-Site: cross-site` → 200 (not 403 `CROSS_ORIGIN`).
- JSON body `{"List-Unsubscribe":"One-Click"}` → 400; form body with `List-Unsubscribe=Other` → 400; flag still true.
- forged MAC, unknown subject, erased student, tombstoned invitation, missing `t` → each 404 `UNSUBSCRIBE_LINK_INVALID`, and the four response bodies are byte-identical (compare `await res.text()`).
- GET with a valid token → 303, `Location` ends with `/unsubscribe#t=<token>`; DB unchanged.
- GET with garbage token → 303 too (the page answers invalid on POST); no DB read needed.
- 61 POSTs from one `freshIp()` → the 61st is 429.

- [ ] **Step 2: Run, expect FAIL** — `pnpm run worktree:up` then `pnpm exec vitest run --project integration tests/integration/unsubscribe-api.test.ts`.

- [ ] **Step 3: `withErrorHandler` option.** Add `options: { crossOrigin?: 'enforce' | 'token-authorised' } = {}`; skip `crossOriginRefusal` only when `options.crossOrigin === 'token-authorised'`. Docblock: "`'token-authorised'` is for a route whose request carries its own credential and reads no session, so a foreign Origin forges nothing." Add a unit test (in the existing write-handler census test or a sibling) that greps `src/app/api/**/route.ts` for `'token-authorised'` and expects exactly `['unsubscribe/route.ts']` — the list in a test is the tether, not prose.

- [ ] **Step 4: Register code and prefix** (`UNSUBSCRIBE_LINK_INVALID: 404`; `'unsubscribe'` in all three rate-limit places).

- [ ] **Step 5: Implement the route.**

```ts
const WINDOW_MS = 15 * 60 * 1000;
const PER_IP_LIMIT = 60;
const INVALID = 'This unsubscribe link no longer works. You can change your email settings after signing in.';

/**
 * RFC 8058 one-click unsubscribe. Needs no session: the signed token is the
 * credential and can flip one preference. Mailbox providers POST here
 * server-side, webmail clients from the browser, hence the cross-origin
 * exemption. One 404 for every token that cannot act.
 */
export const POST = withErrorHandler(async (request: NextRequest) => {
  const limit = checkIpRateLimit('unsubscribe', clientIp(request), PER_IP_LIMIT, WINDOW_MS, 'unsubscribe');
  if (!limit.allowed) return respondRateLimited(limit, 'Too many attempts.');

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return respondError('Send List-Unsubscribe=One-Click as a form body.', 400);
  }
  if (form.get('List-Unsubscribe') !== 'One-Click') return respondError('Send List-Unsubscribe=One-Click as a form body.', 400);

  const target = verifyUnsubscribeToken(request.nextUrl.searchParams.get('t') ?? '');
  if (target === null) return respondError(INVALID, 404, 'UNSUBSCRIBE_LINK_INVALID');

  const outcome = await unsubscribe(prisma, target);
  switch (outcome.status) {
    case 'done': return respondTyped<{ unsubscribed: true }>({ unsubscribed: true });
    case 'unchanged': return respondUnchanged<{ unsubscribed: true }>({ unsubscribed: true });
    case 'invalid': return respondError(INVALID, 404, 'UNSUBSCRIBE_LINK_INVALID');
    default: { const unhandled: never = outcome; throw new Error(`unhandled unsubscribe outcome: ${String((unhandled as { status?: unknown }).status)}`); }
  }
}, { crossOrigin: 'token-authorised' });

/** A client that opens the header link in a browser lands on the confirm page; nothing changes on GET. */
export const GET = withErrorHandler(async (request: NextRequest) => {
  const token = request.nextUrl.searchParams.get('t') ?? '';
  const base = process.env.NEXT_PUBLIC_APP_URL || request.nextUrl.origin;
  return NextResponse.redirect(`${base}/unsubscribe#t=${encodeURIComponent(token)}`, 303);
});
```

Confirm `respondError(message, 400)` without a code is accepted (it is in `parseBody`); if a code is required for 400, use the existing generic one.

- [ ] **Step 6: Run integration, expect PASS.**

- [ ] **Step 7: Prove two guards bite.** (a) Remove the `{ crossOrigin: 'token-authorised' }` option → the foreign-Origin test FAILS with 403; restore. (b) Change the GET to call `unsubscribe` → the "GET changes nothing" test FAILS; restore. Warm the route with a curl after each mutation before judging.

- [ ] **Step 8: Docs.** In `docs/technical-architecture.md`:
  - *Cross-site writes*: one sentence — `/api/unsubscribe` is the one route that opts out (`crossOrigin: 'token-authorised'`), because its credential is the signed token in the URL and it reads no session; the census test pins it.
  - *Unauthenticated API routes*: re-run the re-derive loop shown there and update the three numbers from its output (expected 79 / 13 / 8 — add `unsubscribe` to the rate-limited list). Show the arithmetic in the PR body, not the doc.
  - New subsection *One-click unsubscribe* after the email seam paragraph: token format and key, what each kind flips (link to the spec's table rather than copying it), the routes, the uniform 404, the GET-never-mutates rule, rotation consequence.
  - `DEPLOYMENT.md`: under the email/cut-over checklist add "Check that Lettermint's DKIM signature covers `List-Unsubscribe` and `List-Unsubscribe-Post` (send one fallback email to a Gmail address and read *Show original* → `DKIM-Signature: h=`)" and "Before deploying, confirm no teacher holds the slug `unsubscribe`: `SELECT id FROM \"Teacher\" WHERE \"pageSlug\" = 'unsubscribe';`".

- [ ] **Step 9: Commit** — `feat: POST /api/unsubscribe performs the opt-out; GET leads to the confirm page (#801)`.

---

### Task 6: The `/unsubscribe` confirm page

**Files:**
- Create: `src/app/(public)/unsubscribe/page.tsx`, `src/app/(public)/unsubscribe/unsubscribe-form.tsx`, `src/app/(public)/unsubscribe/unsubscribe-form.test.tsx`
- Modify: `src/lib/schemas.ts` (`'unsubscribe'` in `RESERVED_SLUGS`)

**Interfaces:**
- Consumes: `peekUnsubscribeKind`, `UnsubscribeKind` (Task 1); `POST /api/unsubscribe` (Task 5).

- [ ] **Step 1: Confirm the slug tether fails first.** Create `page.tsx` as a stub, run `pnpm exec vitest run --project unit src/lib/schemas.test.ts` → "reserves every static top-level route segment" FAILS naming `unsubscribe`. Add `'unsubscribe'` to `RESERVED_SLUGS` → PASS.

- [ ] **Step 2: Failing component tests** (`payout-pause-form.test.tsx` is the pattern: `stubFetch`, `respond`, set `window.location.hash`):
  - per kind, the description line matches the copy table below (iterate `Object.keys(UNSUBSCRIBE_KINDS)` and assert each has a non-empty description, plus exact text for `invitation` and `student_reminders`).
  - the button POSTs to `/api/unsubscribe?t=<token>` with body `List-Unsubscribe=One-Click` (form-encoded: assert `init.body` is a `URLSearchParams` whose string is `List-Unsubscribe=One-Click`).
  - 200 → success state (`role="status"`), and the fragment is dropped (`history.replaceState` called).
  - 200 with `outcome: 'unchanged'` → the same success state.
  - 404 `UNSUBSCRIBE_LINK_INVALID` → invalid state with a sign-in link.
  - no fragment / an unparseable token → "This link is incomplete" state, no button.
  - 429 → "too many attempts" message; network error → "nothing changed, try again".

- [ ] **Step 3: Run, expect FAIL** — `pnpm exec vitest run --project components "src/app/(public)/unsubscribe"`.

- [ ] **Step 4: Implement.** Mirror `payout-pause-form.tsx`'s structure (hash via `useSyncExternalStore`, `tokenFromHash`, state machine, `readError`, `logRequestFailure`), simplified: an unsubscribe is idempotent, so a network failure is "nothing changed — try again" rather than the pause form's "unknown". Copy, keyed by an object `satisfies Record<UnsubscribeKind, { what: string; settings: string | null }>`:

| kind | what | settings |
|---|---|---|
| `student_notifications` | You'll stop getting an email when a message in the app goes unread. Messages about your own bookings, cancellations and payments still come by email. | `/account/notifications` |
| `teacher_bookings` | You'll stop getting booking emails. New bookings still show in your inbox. | `/settings/notifications` |
| `teacher_class_completed` | You'll stop getting an email when a class completes. | `/settings/notifications` |
| `teacher_invitations` | You'll stop getting an email when someone invites you to connect. | `/settings/notifications` |
| `student_reminders` | Class reminders stop coming by email. If email was the only way you got them, reminders turn off. | `/account/notifications` |
| `teacher_reminders` | (same as `student_reminders`) | `/settings/notifications` |
| `invitation` | This declines the invitation, and that teacher can't add your address again. | `null` |

Page (`page.tsx`, server component, like `payout-pause/page.tsx`): `<h1 className="type-display mb-5">Unsubscribe</h1>` then `<UnsubscribeForm />`. Form renders the `what` line (`type-body`), a full-width `Button` "Unsubscribe", and — when `settings` is non-null — "Or choose exactly what you get in your <Link>notification settings</Link>." Success: `type-subtitle` "You're unsubscribed" plus "You can change this any time in your notification settings." (settings link when non-null). The POST:

```ts
await fetch(`/api/unsubscribe?t=${encodeURIComponent(token)}`, {
  method: 'POST',
  body: new URLSearchParams({ 'List-Unsubscribe': 'One-Click' }),
});
```

- [ ] **Step 5: Run, expect PASS.**

- [ ] **Step 6: Drive it once in the running worktree app** (`verify` skill): mint a token for a seeded student via a one-off `tsx` script calling `unsubscribeLinks`, open the `page` URL in Playwright, press Unsubscribe, confirm the student's `emailNotifications` is false. Screenshot at 375px wide for the PR.

- [ ] **Step 7: Commit** — `feat: the /unsubscribe confirm page (#801)`.

---

## After the tasks

- Whole-branch review (6 tasks), one fix wave, one scoped re-review.
- `pnpm run verify` and `pnpm run build` in the worktree; Playwright via `worktree:up`.
- PR body: premise corrections from the spec, the census arithmetic (78 + 1 = 79 routes; 12 + 1 = 13 unguarded; 7 + 1 = 8 rate-limited), the guard-bite records from each task, integration files touched (`tests/integration/unsubscribe-api.test.ts`), and "#800 is unaffected".
