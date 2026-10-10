# Email Provider Seam Implementation Plan (#800)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every outgoing email goes through one app-owned `sendEmail` seam backed by a Lettermint HTTP adapter, carries a text part, a Reply-To and a route chosen by audience, and fails loudly in production without a key.

**Architecture:** `src/lib/email-lettermint.ts` is the only file that knows the provider (plain `fetch`, no SDK). `src/lib/email.ts` owns `sendEmail` — the never-throwing seam with the dry-run/production rule, From, Reply-To and route — and the five throwing wrappers built on it. `src/lib/email-templates.ts` renders every email from a list of blocks into `{ subject, html, text }`.

**Tech Stack:** Next.js 16, TypeScript strict, Vitest (`unit` and `unit-sweeps` projects), Node `fetch` and `node:crypto`.

**Spec:** `docs/superpowers/specs/2026-10-10-email-provider-seam-design.md` — read it before any task; this plan argues from it.

## Global Constraints

- TypeScript `strict: true`; no `any`, no casts to silence the compiler.
- Test-first in every task: write the failing test, run it red, implement, run it green.
- No file outside `src/lib/email-lettermint.ts` talks to Lettermint; after Task 4 the `resend` package is gone and no file imports it.
- Tests mock `@/lib/email-lettermint` (where they used to mock `resend`) or `@/lib/email` (where they already did). Never a vendor module.
- Env names, exactly: `LETTERMINT_API_TOKEN`, `LETTERMINT_CLASS_ROUTE`, `EMAIL_FROM` (default `noreply@fair.yoga`), `EMAIL_REPLY_TO` (default `hello@fair.yoga`), `EMAIL_DRY_RUN`. An env var set to the empty string counts as unset.
- Missing-key reason string, exactly: `LETTERMINT_API_TOKEN is not configured`.
- Audience map: `platform` = magic link, passkey added, passkey removed, payout changed, degradation digest. `class` = email-fallback (every notification type), class reminders, invitation.
- The dev console lines `[DEV] Magic link for ${to}: ${magicLink}` and `[DEV] Invitation email for ${to} from ${teacherName}: ${signInUrl}` keep their exact format — `.claude/skills/verify/SKILL.md` tells people to read the first one.
- Comment Discipline (CLAUDE.md): comments state what is true now about the code they sit on; no counts or member lists in prose; correction history goes in the PR body, not comments.
- Stage exact paths; never `git add -A` / `git add .`. Quote paths containing parentheses.
- Never stop or restart a dev server on :3000.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and name `(#800)`.

## Review Focus

The inputs the spec implies but does not spell out, most likely to bite first. Each has a test in the task that owns the code.

1. **An env var set to `""`** (`LETTERMINT_CLASS_ROUTE=""`, `EMAIL_REPLY_TO=""`, `LETTERMINT_API_TOKEN=""` — what an `.env` copied from `.env.example` holds): treated as unset. Never `route: ""` (which Lettermint would refuse on every class mail), never an empty Reply-To, never "configured" — Task 3.
2. **A 202 with an empty or non-JSON body:** still `ok: true`; the adapter never parses a success body — Task 1.
3. **A non-JSON error body** (an HTML 502 page from a proxy): the reason is `lettermint 502: <status text>`, never the page — Task 1.
4. **Teacher-authored text with `&`, `<`, quotes** in a title, body or name: escaped once in html, verbatim in text (no `&amp;` in the text part); an href containing `&` is `&amp;` in html and raw in text — Task 2.
5. **A request that never answers:** the adapter's timeout aborts it and answers `ok: false`; the caller is not left hanging — Task 1.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/lib/email-lettermint.ts` (new) | The one call to Lettermint's HTTP API: payload → `{ ok } \| { ok: false, reason }` | 1 |
| `src/lib/email-lettermint.test.ts` (new) | Adapter behaviour against a mocked `fetch` | 1 |
| `src/lib/email-templates.ts` | Block model, `wrapEmail` → `{ html, text }`, every renderer returns `RenderedEmail`, required footers | 2 |
| `src/lib/email-templates.test.ts` | Text-part and footer tests; existing content/escaping tests kept | 2 |
| `src/lib/email.ts` | `sendEmail` seam, the production rule, From / Reply-To / route, the five throwing wrappers; `sendHtmlEmail` deleted | 3 |
| `src/lib/email.test.ts` | Seam and wrapper tests against a mocked adapter | 3 |
| `src/services/class-reminders.ts`, `src/services/degradation-digest.ts` | Call `sendEmail` | 3 |
| `src/services/{class-reminders,degradation-digest,invitations.notify,invitations.deliver}.test.ts` | Mock the adapter / `sendEmail` instead of `resend` / `sendHtmlEmail` | 3 |
| `src/services/email-fallback.ts` | Own client and dry-run branch removed; `sendEmail` with idempotency key | 4 |
| `src/services/email-fallback{,.consent}.test.ts` | Mock the adapter | 4 |
| `package.json`, `pnpm-lock.yaml` | `resend` removed | 4 |
| `.env.example`, `.github/workflows/ci.yml`, `.github/workflows/e2e-flake-repro.yml`, `DEPLOYMENT.md`, `docs/technical-architecture.md`, `docs/data-model.md`, comments in `src/lib/notify-health.ts` / `src/services/invitations.ts` | Configuration and docs | 5 |

**Task order is load-bearing.** Task 2's `RenderedEmail` and Task 1's adapter are both consumed by Task 3. Task 3 must migrate every test that mocks `resend` *for a sender in `email.ts`* (the invitation tests included), because after it `email.ts` no longer touches `resend` and those mocks would catch nothing. Task 4 removes the package only after `email-fallback.ts` — its last importer — has moved.

---

### Task 1: The Lettermint adapter

**Files:**
- Create: `src/lib/email-lettermint.ts`
- Test: `src/lib/email-lettermint.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export interface LettermintPayload {
    from: string; to: string; replyTo?: string; route?: string;
    subject: string; html: string; text: string;
    headers?: Record<string, string>; idempotencyKey?: string;
  }
  export type LettermintResult = { ok: true } | { ok: false; reason: string };
  export async function deliverViaLettermint(
    payload: LettermintPayload, token: string, options?: { timeoutMs?: number },
  ): Promise<LettermintResult>;
  ```
  It never throws. A rejected `fetch` or an abort becomes `ok: false`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { deliverViaLettermint, type LettermintPayload } from './email-lettermint';

const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const base: LettermintPayload = {
  from: 'noreply@fair.yoga', to: 'a@test.local', subject: 'Hi', html: '<p>Hi</p>', text: 'Hi',
};
const accepted = () => new Response(JSON.stringify({ message_id: 'm1', status: 'pending' }), { status: 202 });
const sentBody = () => JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)) as Record<string, unknown>;
const sentHeaders = () => new Headers(fetchMock.mock.calls[0]![1]!.headers);

describe('deliverViaLettermint', () => {
  it('posts to the send endpoint with the token header and answers ok on 202', async () => {
    fetchMock.mockResolvedValue(accepted());
    expect(await deliverViaLettermint(base, 'lm_tok')).toEqual({ ok: true });
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.lettermint.co/v1/send');
    expect(fetchMock.mock.calls[0]![1]!.method).toBe('POST');
    expect(sentHeaders().get('x-lettermint-token')).toBe('lm_tok');
    expect(sentHeaders().get('content-type')).toBe('application/json');
  });

  it('sends to as an array, text and html, and omits absent optional fields', async () => {
    fetchMock.mockResolvedValue(accepted());
    await deliverViaLettermint(base, 'lm_tok');
    expect(sentBody()).toEqual({ from: 'noreply@fair.yoga', to: ['a@test.local'], subject: 'Hi', html: '<p>Hi</p>', text: 'Hi' });
  });

  it('sends reply_to as an array, route and headers as given', async () => {
    fetchMock.mockResolvedValue(accepted());
    await deliverViaLettermint(
      { ...base, replyTo: 'hello@fair.yoga', route: 'class-mail', headers: { 'List-Unsubscribe': '<https://x>' } },
      'lm_tok',
    );
    expect(sentBody()).toMatchObject({
      reply_to: ['hello@fair.yoga'], route: 'class-mail', headers: { 'List-Unsubscribe': '<https://x>' },
    });
  });

  it('answers ok on a 202 whose body is empty or not JSON', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 202 }));
    expect(await deliverViaLettermint(base, 'lm_tok')).toEqual({ ok: true });
  });

  it.each([
    ['{ message }', { message: 'Unauthenticated.' }, 401, 'lettermint 401: Unauthenticated.'],
    ['{ error: { code, message } }', { error: { code: 'RATE_LIMITED', message: 'Slow down' } }, 429, 'lettermint 429: Slow down'],
    ['{ message, errors }', { message: 'The given data was invalid.', errors: { reply_to: ['bad'], subject: ['bad'] } }, 422,
      'lettermint 422: The given data was invalid. (reply_to, subject)'],
  ])('answers ok:false with the message from a %s error body', async (_shape, body, status, reason) => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status }));
    expect(await deliverViaLettermint(base, 'lm_tok')).toEqual({ ok: false, reason });
  });

  it('answers with the status text, never the body, for a non-JSON error', async () => {
    fetchMock.mockResolvedValue(new Response('<html>Bad Gateway page</html>', { status: 502, statusText: 'Bad Gateway' }));
    expect(await deliverViaLettermint(base, 'lm_tok')).toEqual({ ok: false, reason: 'lettermint 502: Bad Gateway' });
  });

  it('answers ok:false when fetch rejects', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    expect(await deliverViaLettermint(base, 'lm_tok')).toEqual({ ok: false, reason: 'lettermint request failed: fetch failed' });
  });

  it('aborts a request that never answers and answers ok:false', async () => {
    fetchMock.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason));
    }));
    const result = await deliverViaLettermint(base, 'lm_tok', { timeoutMs: 10 });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/^lettermint request failed: /);
  });

  describe('idempotency', () => {
    it('sends no Idempotency-Key without a key', async () => {
      fetchMock.mockResolvedValue(accepted());
      await deliverViaLettermint(base, 'lm_tok');
      expect(sentHeaders().has('idempotency-key')).toBe(false);
    });

    it('sends the key salted with a hash of the exact body sent', async () => {
      fetchMock.mockResolvedValue(accepted());
      await deliverViaLettermint({ ...base, idempotencyKey: 'notification-abc' }, 'lm_tok');
      const body = String(fetchMock.mock.calls[0]![1]!.body);
      const hash = createHash('sha256').update(body).digest('hex').slice(0, 16);
      expect(sentHeaders().get('idempotency-key')).toBe(`notification-abc-${hash}`);
      expect(JSON.parse(body)).not.toHaveProperty('idempotencyKey');
    });

    it('sends a different key when the body differs, the same key when it does not', async () => {
      fetchMock.mockImplementation(async () => accepted());
      await deliverViaLettermint({ ...base, idempotencyKey: 'k' }, 'lm_tok');
      await deliverViaLettermint({ ...base, idempotencyKey: 'k' }, 'lm_tok');
      await deliverViaLettermint({ ...base, html: '<p>Changed</p>', idempotencyKey: 'k' }, 'lm_tok');
      const keys = fetchMock.mock.calls.map(([, init]) => new Headers(init!.headers).get('idempotency-key'));
      expect(keys[0]).toBe(keys[1]);
      expect(keys[2]).not.toBe(keys[0]);
    });
  });
});
```

- [ ] **Step 2: Run them red**

Run: `pnpm exec vitest run --project unit src/lib/email-lettermint.test.ts`
Expected: FAIL — cannot resolve `./email-lettermint`.

- [ ] **Step 3: Implement**

```ts
import { createHash } from 'node:crypto';

/**
 * The one call to Lettermint's sending API. Every outcome comes back as a
 * value: a non-2xx answer, a network failure and a timeout are all
 * `ok: false`, so the seam above (`sendEmail`, lib/email.ts) never has to know
 * how this provider reports failure.
 */

const SEND_URL = 'https://api.lettermint.co/v1/send';
const DEFAULT_TIMEOUT_MS = 10_000;
/** Lettermint caps the header at 255; the salt adds a dash and 16 hex characters. */
const MAX_CALLER_KEY_LENGTH = 255 - 17;

export interface LettermintPayload {
  from: string;
  to: string;
  replyTo?: string;
  route?: string;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
  /**
   * A caller-stable id for a send that may be retried. Sent salted with a
   * hash of the body: Lettermint returns the original response for the same
   * key and body within 24 hours, and answers 409 for the same key with a
   * different body — the salt turns a changed body into a new send instead.
   */
  idempotencyKey?: string;
}

export type LettermintResult = { ok: true } | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The message from any of the error bodies Lettermint documents; the status text when the body is not JSON. */
async function errorMessage(res: Response): Promise<string> {
  let body: unknown;
  try {
    body = JSON.parse(await res.text());
  } catch {
    return res.statusText || 'error without a body';
  }
  if (!isRecord(body)) return res.statusText || 'error without a message';
  if (isRecord(body.error) && typeof body.error.message === 'string') return body.error.message;
  if (typeof body.message === 'string') {
    return isRecord(body.errors) ? `${body.message} (${Object.keys(body.errors).join(', ')})` : body.message;
  }
  return res.statusText || 'error without a message';
}

export async function deliverViaLettermint(
  payload: LettermintPayload,
  token: string,
  options: { timeoutMs?: number } = {},
): Promise<LettermintResult> {
  const body = JSON.stringify({
    from: payload.from,
    to: [payload.to],
    ...(payload.replyTo !== undefined && { reply_to: [payload.replyTo] }),
    ...(payload.route !== undefined && { route: payload.route }),
    subject: payload.subject,
    html: payload.html,
    text: payload.text,
    ...(payload.headers !== undefined && { headers: payload.headers }),
  });
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-lettermint-token': token,
  };
  if (payload.idempotencyKey !== undefined) {
    const salt = createHash('sha256').update(body).digest('hex').slice(0, 16);
    headers['idempotency-key'] = `${payload.idempotencyKey.slice(0, MAX_CALLER_KEY_LENGTH)}-${salt}`;
  }

  let res: Response;
  try {
    res = await fetch(SEND_URL, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, reason: `lettermint request failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (res.ok) return { ok: true };
  return { ok: false, reason: `lettermint ${res.status}: ${await errorMessage(res)}` };
}
```

If `pnpm run lint` flags the bare `catch` in `errorMessage`, follow whatever form the repo's rule asks for (see `docs/superpowers/plans/2026-09-29-bare-catch-logging.md`); the behaviour must stay "not JSON → status text".

- [ ] **Step 4: Run green**

Run: `pnpm exec vitest run --project unit src/lib/email-lettermint.test.ts` — expected: all pass. Then `pnpm run typecheck && pnpm run lint`.

- [ ] **Step 5: Prove the guards bite.** For each, apply the break, run the test file, record the failing test name and assertion text for the report, restore, re-run green:
  1. In `errorMessage`'s catch, return `await res.text()`-derived raw text instead of the status text → the non-JSON test must fail.
  2. Remove the `try`/`catch` around `fetch` → the rejection and timeout tests must fail (a thrown error, not `ok: false`).
  3. Hash `JSON.stringify(payload)` instead of `body` → the "exact body" test must fail.

- [ ] **Step 6: Commit**

```bash
git add src/lib/email-lettermint.ts src/lib/email-lettermint.test.ts
git commit -m "feat: the Lettermint adapter — one fetch, every failure a value, salted idempotency key (#800)"
```

---

### Task 2: Block-model templates with a text part and honest footers

**Files:**
- Modify: `src/lib/email-templates.ts` (`wrapEmail` and every `render*Email`)
- Test: `src/lib/email-templates.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  ```ts
  export type RenderedEmail = { subject: string; html: string; text: string };
  export type ParagraphTone = 'body' | 'intro' | 'note' | 'strong';
  export type EmailBlock =
    | { kind: 'paragraph'; lines: readonly string[]; tone?: ParagraphTone }
    | { kind: 'button'; label: string; href: string };
  export function wrapEmail(heading: string, blocks: readonly EmailBlock[], footer: string): { html: string; text: string };
  ```
  Every `render*Email` returns `RenderedEmail`. Signatures are otherwise unchanged, including `renderNotificationEmail(notification, baseUrl?, footer?)`. Callers that destructure `{ subject, html }` keep compiling. `UNREAD_FALLBACK_FOOTER` and `CLASS_REMINDER_EMAIL_FOOTER` stay exported names (add `export` to the first).

**Behaviour:**
- `wrapEmail` escapes the heading and every line, label and href exactly once. Renderers pass **plain strings** and no longer call `escapeHtml` themselves. `escapeHtml` stays exported.
- Footer is **required**. The new constants, with copy verbatim from the spec's *Footers* table:
  - `UNREAD_FALLBACK_FOOTER` becomes `'You get emails like this when an in-app message goes unread; turn them off in your settings. Replies to this email are not read.'`
  - `CLASS_REMINDER_EMAIL_FOOTER` becomes `'You get this email because you chose class reminders by email; change that in your notification settings. Replies to this email are not read.'`
  - `INVITATION_FOOTER = 'You get this email because a teacher on fair.yoga added your address. Replies to this email are not read.'`
  - `ACCOUNT_ACTIVITY_FOOTER = 'You get this email because of activity on your fair.yoga account.'`
  - `PAYOUT_CHANGED_FOOTER` and `DEGRADATION_DIGEST_FOOTER` are unchanged.
- Text layout: heading, then each block, then `fair.yoga — free, open tools for independent yoga teachers.` followed by the footer on the next line. Elements are separated by one blank line, with a trailing newline. A paragraph's lines join with `\n`. A button renders as `Label: href`.
- Html: the same shell as today. Each block is one `<p>`. Margins: `0 0 16px` (an `intro` block `0 0 8px`), and the last block `margin:0`. Lines join with `<br>`. Tone styles: `intro` and `note` = `color:#71645A;font-size:13px;`, `strong` = `font-weight:700;color:#1A5653;`, `body` = none. The button is the existing pill `<a>` inside a `<p>`.
- **Known deviation from the spec's "html renders as it does today, whitespace aside":** inside a degradation-digest entry the 0/4px margins become the uniform block margins, and the notification button's `16px 0 0` margin becomes the block rule. Name both in the task report so they reach the PR body.

- [ ] **Step 1: Write the failing tests.** Add these to `email-templates.test.ts`; existing tests stay. Use the test file's existing input fixtures where they exist, and the literals below otherwise.

```ts
import {
  wrapEmail, renderMagicLinkEmail, renderInvitationEmail, renderPasskeyAddedEmail,
  renderPasskeyRemovedEmail, renderPayoutChangedEmail, renderNotificationEmail,
  renderDegradationDigestEmail, CLASS_REMINDER_EMAIL_FOOTER, type RenderedEmail,
} from './email-templates';

describe('wrapEmail', () => {
  it('escapes once in html and keeps text verbatim', () => {
    const { html, text } = wrapEmail('Tom & "Jerry" <b>', [
      { kind: 'paragraph', lines: ['a < b & c'] },
      { kind: 'button', label: 'Go & see', href: 'https://x.test/p?a=1&b=2' },
    ], 'Footer & co');
    expect(html).toContain('Tom &amp; &quot;Jerry&quot; &lt;b&gt;');
    expect(html).toContain('a &lt; b &amp; c');
    expect(html).toContain('href="https://x.test/p?a=1&amp;b=2"');
    expect(html).not.toContain('&amp;amp;');
    expect(text).toBe(
      'Tom & "Jerry" <b>\n\na < b & c\n\nGo & see: https://x.test/p?a=1&b=2\n\n' +
      'fair.yoga — free, open tools for independent yoga teachers.\nFooter & co\n',
    );
  });

  it('joins paragraph lines with <br> in html and newlines in text', () => {
    const { html, text } = wrapEmail('H', [{ kind: 'paragraph', lines: ['one', 'two'] }], 'F');
    expect(html).toContain('one<br>two');
    expect(text).toContain('one\ntwo');
  });
});

/** Every href in the html, unescaped, appears in the text part. */
function expectHrefsInText(email: RenderedEmail) {
  const hrefs = [...email.html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!.replaceAll('&amp;', '&'));
  for (const href of hrefs) expect(email.text).toContain(href);
}

describe('text parts', () => {
  const at = new Date('2026-10-10T09:30:00Z');

  it('magic link: link in text, account footer, no unread/settings claim', () => {
    const email = renderMagicLinkEmail('https://fair.yoga/verify?token=abc&x=1');
    expect(email.text).toContain('Sign in: https://fair.yoga/verify?token=abc&x=1');
    expect(email.text).toContain('expires in 15 minutes');
    expect(email.text).toContain('You get this email because of activity on your fair.yoga account.');
    expect(email.text).not.toMatch(/unread|settings/);
    expectHrefsInText(email);
  });

  it('invitation: teacher name verbatim in text, replies-not-read footer', () => {
    const email = renderInvitationEmail('Ana & <Bo>', 'https://fair.yoga/login');
    expect(email.text).toContain('Ana & <Bo> added you as a contact');
    expect(email.html).toContain('Ana &amp; &lt;Bo&gt;');
    expect(email.text).toContain('Replies to this email are not read.');
    expect(email.text).not.toMatch(/unread|turn them off/);
    expectHrefsInText(email);
  });

  it.each([
    ['added', renderPasskeyAddedEmail],
    ['removed', renderPasskeyRemovedEmail],
  ] as const)('passkey %s: account footer, no unread/settings claim', (_k, render) => {
    const email = render(at);
    expect(email.text).toContain('10 Oct 2026, 09:30 UTC');
    expect(email.text).toContain('You get this email because of activity on your fair.yoga account.');
    expect(email.text).not.toMatch(/unread|turn them off/);
  });

  it('notification fallback: body verbatim, button link, replies-not-read', () => {
    const email = renderNotificationEmail(
      { type: 'announcement', title: 'Rain & mats', body: 'Bring <your> mat & towel', recipientType: 'student' },
      'https://fair.yoga',
    );
    expect(email.text).toContain('Bring <your> mat & towel');
    expect(email.text).toContain('Replies to this email are not read.');
    expectHrefsInText(email);
  });

  it('class reminder footer says replies are not read', () => {
    const email = renderNotificationEmail(
      { type: 'class_reminder', title: 'T', body: 'B', recipientType: 'student' }, 'https://fair.yoga', CLASS_REMINDER_EMAIL_FOOTER,
    );
    expect(email.text).toContain('Replies to this email are not read.');
  });

  it('payout changed: pause link and before/after lines in text', () => {
    const email = renderPayoutChangedEmail({
      kind: 'bank_account_changed', accountCurrency: 'EUR', before: 'NL•• •••• 1234', after: 'NL•• •••• 9876',
      at: new Date('2026-10-06T14:03:00Z'), timezone: 'Europe/Amsterdam',
      pauseUrl: 'https://fair.yoga/payout-pause#t=tok', identifierChanged: true,
    });
    expect(email.text).toContain("This wasn't me: https://fair.yoga/payout-pause#t=tok");
    expect(email.text).toContain('Before: NL•• •••• 1234\nAfter: NL•• •••• 9876');
    expectHrefsInText(email);
  });

  it('degradation digest: each code and its sample in text', () => {
    const email = renderDegradationDigestEmail([{
      code: 'X_FIRED', description: 'd & e', firstSeenAt: at, lastSeenAt: at, occurrences: 3, sample: { k: 'v<1>' },
    }]);
    expect(email.text).toContain('X_FIRED');
    expect(email.text).toContain('d & e');
    expect(email.text).toContain('Latest: k: v<1>');
  });
});
```

`announcement` is a `NotificationType` member. If it has no entry in `STUDENT_ACTION_LINKS`, `expectHrefsInText` checks nothing, so switch that test to a type that has one.

- [ ] **Step 2: Run them red**

Run: `pnpm exec vitest run --project unit src/lib/email-templates.test.ts`
Expected: FAIL — `text` is undefined, and `wrapEmail`'s signature doesn't match.

- [ ] **Step 3: Implement `wrapEmail`**

```ts
export type RenderedEmail = { subject: string; html: string; text: string };
export type ParagraphTone = 'body' | 'intro' | 'note' | 'strong';
export type EmailBlock =
  | { kind: 'paragraph'; lines: readonly string[]; tone?: ParagraphTone }
  | { kind: 'button'; label: string; href: string };

const WORDMARK_LINE = 'fair.yoga — free, open tools for independent yoga teachers.';
const BUTTON_STYLE =
  'display:inline-block;background-color:#1A5653;color:#F7F4EF;text-decoration:none;font-weight:600;font-size:16px;padding:14px 24px;border-radius:999px;';
const TONE_STYLE = {
  body: '',
  intro: 'color:#71645A;font-size:13px;',
  note: 'color:#71645A;font-size:13px;',
  strong: 'font-weight:700;color:#1A5653;',
} satisfies Record<ParagraphTone, string>;

function blockHtml(block: EmailBlock, last: boolean): string {
  switch (block.kind) {
    case 'paragraph': {
      const tone = block.tone ?? 'body';
      const margin = last ? '0' : tone === 'intro' ? '0 0 8px' : '0 0 16px';
      return `<p style="margin:${margin};${TONE_STYLE[tone]}">${block.lines.map(escapeHtml).join('<br>')}</p>`;
    }
    case 'button':
      return `<p style="margin:${last ? '0' : '0 0 16px'};"><a href="${escapeHtml(block.href)}" style="${BUTTON_STYLE}">${escapeHtml(block.label)}</a></p>`;
    default: {
      const unhandled: never = block;
      return unhandled;
    }
  }
}

function blockText(block: EmailBlock): string {
  switch (block.kind) {
    case 'paragraph':
      return block.lines.join('\n');
    case 'button':
      return `${block.label}: ${block.href}`;
    default: {
      const unhandled: never = block;
      return unhandled;
    }
  }
}

/**
 * The shared shell — wordmark, one content card, quiet footer — rendered as
 * html and as text from the same blocks. Every string a block carries is
 * plain text and is escaped here, once.
 */
export function wrapEmail(
  heading: string,
  blocks: readonly EmailBlock[],
  footer: string,
): { html: string; text: string } {
  const body = blocks.map((b, i) => blockHtml(b, i === blocks.length - 1)).join('\n      ');
  const html = `<!DOCTYPE html>
<html lang="en">
<body style="margin:0;padding:0;background-color:#F7F4EF;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,Helvetica,sans-serif;color:#6B5B4E;">
  <div style="max-width:520px;margin:0 auto;padding:32px 16px;">
    <div style="font-family:Georgia,'Times New Roman',serif;font-size:20px;color:#2D2D2D;margin-bottom:24px;">fair<span style="color:#1A5653;">.</span>yoga</div>
    <div style="background-color:#F0E9DC;border:1px solid #D4C9B8;border-radius:16px;padding:24px;">
      <h1 style="font-family:Georgia,'Times New Roman',serif;font-weight:700;font-size:20px;line-height:1.3;color:#1A5653;margin:0 0 12px;">${escapeHtml(heading)}</h1>
      <div style="font-size:16px;line-height:1.55;color:#6B5B4E;">${body}</div>
    </div>
    <p style="font-size:13px;line-height:1.4;color:#71645A;margin:24px 0 0;">
      ${WORDMARK_LINE}<br>
      ${escapeHtml(footer)}
    </p>
  </div>
</body>
</html>`;
  const text = [heading, ...blocks.map(blockText), `${WORDMARK_LINE}\n${footer}`].join('\n\n') + '\n';
  return { html, text };
}
```

The shell is today's, character for character, except for those three interpolations.

- [ ] **Step 4: Convert each renderer.** Keep each renderer's copy verbatim from the current file. Strings are now plain (drop every inner `escapeHtml`). Each returns `{ subject, ...wrapEmail(heading, blocks, footer) }`.
  - `renderNotificationEmail`: heading `notification.title`. Blocks: `{ paragraph, tone:'intro', lines:[intro] }`, `{ paragraph, lines:[notification.body] }`, plus `{ button, label: action.label, href: \`${baseUrl}${action.path}\` }` when `action` is set. Footer parameter: `footer: string = UNREAD_FALLBACK_FOOTER`.
  - `renderMagicLinkEmail`: heading `'Sign in to fair.yoga'`. Blocks: `paragraph ["Tap the button and you're in — no password."]`, `button 'Sign in' → magicLink`, `paragraph tone:'note' ["This link works once and expires in 15 minutes. If you didn't request it, you can ignore this email."]`. Footer `ACCOUNT_ACTIVITY_FOOTER`.
  - `renderInvitationEmail`: heading `'A teacher would like to connect'`. Blocks: `paragraph [\`${teacherName} added you as a contact on fair.yoga, a free tool independent yoga teachers use to run their classes. You choose whether to connect.\`]`, `button 'Sign in' → signInUrl`, `paragraph tone:'note' ["If you weren't expecting this, you can ignore this email."]`. Footer `INVITATION_FOOTER`.
  - `renderPasskeyAddedEmail` / `renderPasskeyRemovedEmail`: their two current paragraphs as two `paragraph` blocks (body tone), with `when` interpolated plain. Footer `ACCOUNT_ACTIVITY_FOOTER`.
  - `renderPayoutChangedEmail`: `lines` built from plain strings (`Shown as: ${input.before ?? ''}` and `alike.text`, or `Before: …` / `After: …`). Blocks:
    1. `paragraph [\`${what} on your fair.yoga account on ${when}.\`]`
    2. `paragraph lines` (only when `lines.length > 0`)
    3. `paragraph ["If that was you, there is nothing to do. If it was not, pause payments now: students are told to hold off, and every device is signed out."]`
    4. `button "This wasn't me" → input.pauseUrl`
    5. `paragraph tone:'note' [\`The link works for ${PAUSE_TOKEN_TTL_DAYS} days. It can only pause payments and sign devices out; it never signs anyone in.\`]`

    Footer `PAYOUT_CHANGED_FOOTER`.
  - `renderDegradationDigestEmail`: heading `'A fallback fired'`. For each entry: `paragraph tone:'strong' [e.code]`, `paragraph [e.description]`, `paragraph tone:'note' [\`First seen ${iso} · last seen ${iso} · about ${e.occurrences} times\`]`, and when the sample is non-empty `paragraph tone:'note' [\`Latest: ${sample}\`]` (sample built plain: `${k}: ${String(v)}` joined with `' · '`). Footer `DEGRADATION_DIGEST_FOOTER`.
  - Update each renderer's docblock where it describes escaping, so it says escaping happens in `wrapEmail`.

- [ ] **Step 5: Run green.** Run `pnpm exec vitest run --project unit src/lib/email-templates.test.ts`. Existing tests that check copy, escaping or links must pass unchanged. A test coupled to an exact old inline style string, or to the old default footer on a platform email, may be updated: list every such edit, with its reason, in the report. Then `pnpm run typecheck && pnpm run lint`.

- [ ] **Step 6: Prove the guards bite.** Apply each break, record the failing assertion, restore, re-run green:
  1. In `blockHtml`, drop `escapeHtml` from paragraph lines → the escaping tests must fail.
  2. In `blockText`, apply `escapeHtml` to lines → `wrapEmail`'s exact-text test must fail.
  3. Give `renderMagicLinkEmail` `UNREAD_FALLBACK_FOOTER` → its no-unread/settings test must fail.

- [ ] **Step 7: Commit**

```bash
git add src/lib/email-templates.ts src/lib/email-templates.test.ts
git commit -m "feat: every email renders html and text from one block list; footers are required and say what is true (#800)"
```

---

### Task 3: The `sendEmail` seam and every caller except email-fallback

**Files:**
- Modify: `src/lib/email.ts` (rewrite)
- Modify: `src/services/class-reminders.ts` (around `emailReminder`), `src/services/degradation-digest.ts` (around its send)
- Test: `src/lib/email.test.ts` (rewrite against the adapter mock)
- Test: `src/services/class-reminders.test.ts`, `src/services/degradation-digest.test.ts`, `src/services/invitations.notify.test.ts`, `src/services/invitations.deliver.test.ts` (mock migration)

**Interfaces:**
- Consumes: `deliverViaLettermint`, `LettermintPayload` (Task 1), and `RenderedEmail` plus every `render*Email` (Task 2).
- Produces:
  ```ts
  export type EmailAudience = 'platform' | 'class';
  export interface EmailMessage {
    to: string; audience: EmailAudience; content: RenderedEmail;
    headers?: Record<string, string>; idempotencyKey?: string;
  }
  export type SendResult = { ok: true; delivery: 'sent' | 'dry-run' } | { ok: false; reason: string };
  export async function sendEmail(message: EmailMessage): Promise<SendResult>;
  export function emailDryRun(): boolean;
  // unchanged signatures, still throwing on failure:
  sendMagicLinkEmail, sendInvitationEmail, sendPasskeyAddedEmail, sendPasskeyRemovedEmail, sendPayoutChangedEmail
  ```
  `sendHtmlEmail` is deleted.

- [ ] **Step 1: Write the failing seam tests.** Replace `email.test.ts` with tests against a mocked adapter, keeping its env save/restore pattern but for `LETTERMINT_API_TOKEN`, `LETTERMINT_CLASS_ROUTE`, `EMAIL_REPLY_TO`, `EMAIL_FROM` and `EMAIL_DRY_RUN`. The mock:

```ts
const deliverMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/email-lettermint', () => ({ deliverViaLettermint: deliverMock }));
vi.mock('@/lib/log', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
const content = { subject: 'S', html: '<p>H</p>', text: 'H' };
```

Required cases (each an `it`):

*`sendEmail`, with `LETTERMINT_API_TOKEN='lm_test'` and `EMAIL_DRY_RUN` deleted:*
- success: the adapter answers `{ ok: true }` → `{ ok: true, delivery: 'sent' }`. The adapter gets token `'lm_test'` and a payload with `from: 'noreply@fair.yoga'`, `to`, and `subject`/`html`/`text` from `content`.
- the adapter answers `{ ok: false, reason: 'lettermint 422: x' }` → the same value back.
- the adapter **throws** `new Error('boom')` → `{ ok: false, reason: 'boom' }`, and no rejection escapes.
- `EMAIL_FROM='fair.yoga <noreply@notify.fair.yoga>'` → passed verbatim as `from`.
- `audience: 'platform'` → `replyTo: 'hello@fair.yoga'` and no `route` key. With `EMAIL_REPLY_TO='ops@x.test'` → that value. With `EMAIL_REPLY_TO=''` → `'hello@fair.yoga'`.
- `audience: 'class'` with `LETTERMINT_CLASS_ROUTE='class-mail'` → `route: 'class-mail'` and no `replyTo` key. With `LETTERMINT_CLASS_ROUTE=''` → no `route` key.
- class route unset in production (`vi.stubEnv('NODE_ENV','production')`): two class sends → `log.warn` called exactly once, with a message naming `LETTERMINT_CLASS_ROUTE`. Use `vi.resetModules()` and a dynamic `await import('./email')` in this test so the once-flag starts fresh.
- class route unset outside production → `log.warn` not called.
- `headers` and `idempotencyKey` are passed through to the adapter payload unchanged.

*`sendEmail` dry-run and the production rule:*
- `EMAIL_DRY_RUN='1'` with a key → `{ ok: true, delivery: 'dry-run' }`, adapter not called, and `log.info` is called with `{ subject: 'S' }` and no `to`.
- no key, not production → dry-run as above.
- no key, production → `{ ok: false, reason: 'LETTERMINT_API_TOKEN is not configured' }`, adapter not called.
- `LETTERMINT_API_TOKEN=''`, production → the same `ok: false`.
- no key, production, `EMAIL_DRY_RUN='1'` → dry-run.

*Wrappers (key set, adapter mocked):*
- each of the five sends `audience` per the Global Constraints map (assert `replyTo` present for platform, absent for class) and the rendered content (`subject`, `html` and `text` equal to the matching `render*Email` output).
- each of the five throws when the adapter answers `{ ok: false, reason: 'r' }`. The message contains `r` (e.g. `/Failed to send magic-link email: r/`).
- each of the five throws when the adapter throws.

*Wrappers in dry-run / production (keep #730's intent):*
- magic link, no key, production → throws `/LETTERMINT_API_TOKEN is not configured/`, and `console.log` is never called with the link.
- magic link, no key, not production → `console.log` called with `` `\n[DEV] Magic link for ${to}: ${link}\n` ``.
- magic link, no key, production, `EMAIL_DRY_RUN='1'` → logs the link and does not throw.
- invitation, no key, not production → `console.log` with `` `\n[DEV] Invitation email for ${to} from ${teacherName}: ${signInUrl}\n` ``.
- **invitation, no key, production → throws `/LETTERMINT_API_TOKEN is not configured/`.** This deliberately inverts today's "has no production throw: a missing key logs" test (spec, *Callers*). Delete that test, and say so in the report.
- passkey added, passkey removed and payout changed, no key, production → each throws `/LETTERMINT_API_TOKEN is not configured/`.
- passkey added, passkey removed and payout changed in dry-run → `console.log` not called, and no `log.info` argument contains the address or (payout) the pause URL.

- [ ] **Step 2: Run them red**

Run: `pnpm exec vitest run --project unit src/lib/email.test.ts`
Expected: FAIL — `sendEmail` not exported.

- [ ] **Step 3: Implement `src/lib/email.ts`**

```ts
import { deliverViaLettermint } from '@/lib/email-lettermint';
import {
  renderMagicLinkEmail, renderInvitationEmail, renderPasskeyAddedEmail, renderPasskeyRemovedEmail,
  renderPayoutChangedEmail, type PayoutChangedEmailInput, type RenderedEmail,
} from '@/lib/email-templates';
import type { BoundSignInLink } from '@/lib/auth/link-delivery';
import { log } from '@/lib/log';

const DEFAULT_FROM = 'noreply@fair.yoga';
const DEFAULT_REPLY_TO = 'hello@fair.yoga';
const NOT_CONFIGURED = 'LETTERMINT_API_TOKEN is not configured';

/** Whose mail this is. Decides Reply-To and the Lettermint route; the spec's audience table says which sender is which. */
export type EmailAudience = 'platform' | 'class';

export interface EmailMessage {
  to: string;
  audience: EmailAudience;
  content: RenderedEmail;
  /** Passed to the provider untouched. */
  headers?: Record<string, string>;
  /** A caller-stable id for a send that may be retried (see `LettermintPayload`). */
  idempotencyKey?: string;
}

export type SendResult = { ok: true; delivery: 'sent' | 'dry-run' } | { ok: false; reason: string };

/** An env var set to the empty string counts as unset. */
function env(name: string): string | undefined {
  return process.env[name] || undefined;
}

/**
 * Dry-run mode logs emails instead of sending them: when asked for
 * (EMAIL_DRY_RUN=1 — CI runs the production build without a real token) or
 * when no token is configured.
 */
export function emailDryRun(): boolean {
  return process.env.EMAIL_DRY_RUN === '1' || env('LETTERMINT_API_TOKEN') === undefined;
}

let warnedClassRouteUnset = false;

/**
 * The route class mail is sent on. Suppression is route-scoped at Lettermint,
 * so class mail on the default route lets a complaint about it suppress
 * sign-in mail too; unset still sends, and production says so once.
 */
function classRoute(): string | undefined {
  const route = env('LETTERMINT_CLASS_ROUTE');
  if (route === undefined && process.env.NODE_ENV === 'production' && !warnedClassRouteUnset) {
    warnedClassRouteUnset = true;
    log.warn({}, 'LETTERMINT_CLASS_ROUTE is not set; class mail is sent on the default route (DEPLOYMENT.md)');
  }
  return route;
}

/**
 * Sends one email and reports the outcome; never throws. A provider refusal
 * and anything the adapter throws both come back as `ok: false`.
 *
 * In production with no token and no explicit EMAIL_DRY_RUN=1 it answers
 * `ok: false` rather than dry-running, so no caller can count an email that
 * was never sent as delivered.
 */
export async function sendEmail(message: EmailMessage): Promise<SendResult> {
  const token = env('LETTERMINT_API_TOKEN');
  if (emailDryRun() || token === undefined) {
    if (process.env.NODE_ENV === 'production' && process.env.EMAIL_DRY_RUN !== '1') {
      return { ok: false, reason: NOT_CONFIGURED };
    }
    log.info({ subject: message.content.subject }, 'email dry-run');
    return { ok: true, delivery: 'dry-run' };
  }
  const routing =
    message.audience === 'platform'
      ? { replyTo: env('EMAIL_REPLY_TO') ?? DEFAULT_REPLY_TO }
      : { route: classRoute() };
  try {
    const result = await deliverViaLettermint(
      {
        from: env('EMAIL_FROM') ?? DEFAULT_FROM,
        to: message.to,
        ...(routing.replyTo !== undefined && { replyTo: routing.replyTo }),
        ...(routing.route !== undefined && { route: routing.route }),
        ...message.content,
        ...(message.headers !== undefined && { headers: message.headers }),
        ...(message.idempotencyKey !== undefined && { idempotencyKey: message.idempotencyKey }),
      },
      token,
    );
    return result.ok ? { ok: true, delivery: 'sent' } : result;
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
```

Shape `routing` however makes strict TypeScript happy. A discriminated pair, or two separate `const`s, is fine as long as the behaviour matches the tests. If `emailDryRun()` is true only because `EMAIL_DRY_RUN=1` while a token exists, the dry-run branch runs (the condition above does that).

The wrappers. Each keeps its existing docblock, edited to describe the new behaviour; every one now throws in production without a token:

```ts
export async function sendMagicLinkEmail(to: string, magicLink: BoundSignInLink): Promise<void> {
  const result = await sendEmail({ to, audience: 'platform', content: renderMagicLinkEmail(magicLink) });
  if (!result.ok) throw new Error(`Failed to send magic-link email: ${result.reason}`);
  // Development only: production without a token never reaches here (it answers ok: false above).
  if (result.delivery === 'dry-run') console.log(`\n[DEV] Magic link for ${to}: ${magicLink}\n`);
}

export async function sendInvitationEmail(to: string, teacherName: string, signInUrl: string): Promise<void> {
  const result = await sendEmail({ to, audience: 'class', content: renderInvitationEmail(teacherName, signInUrl) });
  if (!result.ok) throw new Error(`Failed to send invitation email: ${result.reason}`);
  if (result.delivery === 'dry-run') console.log(`\n[DEV] Invitation email for ${to} from ${teacherName}: ${signInUrl}\n`);
}

export async function sendPasskeyAddedEmail(to: string, addedAt: Date): Promise<void> {
  const result = await sendEmail({ to, audience: 'platform', content: renderPasskeyAddedEmail(addedAt) });
  if (!result.ok) throw new Error(`Failed to send passkey-added email: ${result.reason}`);
}

export async function sendPasskeyRemovedEmail(to: string, removedAt: Date): Promise<void> {
  const result = await sendEmail({ to, audience: 'platform', content: renderPasskeyRemovedEmail(removedAt) });
  if (!result.ok) throw new Error(`Failed to send passkey-removed email: ${result.reason}`);
}

export async function sendPayoutChangedEmail(to: string, input: PayoutChangedEmailInput): Promise<void> {
  const result = await sendEmail({ to, audience: 'platform', content: renderPayoutChangedEmail(input) });
  if (!result.ok) throw new Error(`Failed to send payout-changed email: ${result.reason}`);
}
```

The magic-link production refusal now arrives as `ok: false` from `sendEmail`, which is why the wrapper needs no `NODE_ENV` check of its own. The `sendMagicLinkEmail` docblock must keep the reason it exists: logging a sign-in link to stdout while telling the user "check your inbox" leaks tokens and breaks login.

- [ ] **Step 4: Migrate `class-reminders.ts` and `degradation-digest.ts`.**
  - `class-reminders.ts` `emailReminder`: replace `const { subject, html } = renderNotificationEmail(...)` and `sendHtmlEmail({ to, subject, html })` with `sendEmail({ to, audience: 'class', content: renderNotificationEmail(...) })`. The `!result.ok` branch and the outer `try`/`catch` stay.
  - `degradation-digest.ts`: `const sent = await sendEmail({ to: operatorEmail, audience: 'platform', content: renderDegradationDigestEmail(entries) })`. The rest is unchanged.

- [ ] **Step 5: Migrate the four service test files.**
  - `class-reminders.test.ts`, `invitations.notify.test.ts`, `invitations.deliver.test.ts`: replace the `vi.mock('resend', …)`/`sendMock` block with the `deliverMock` adapter mock from Step 1. Every `RESEND_API_KEY` save/set/restore becomes `LETTERMINT_API_TOKEN` (value `'lm_test_dummy'`). `sendMock.mockResolvedValue({ error: null })` (or `{ data: … }`) becomes `deliverMock.mockResolvedValue({ ok: true })`. `{ error: { message: m } }` becomes `{ ok: false, reason: m }`. Call filters keep working, because the adapter payload has `to`: `deliverMock.mock.calls.filter(([payload]) => payload.to === email)`. Update comments that name Resend or `resend().emails.send` to name the adapter. In `invitations.deliver.test.ts`, `'resend'` as a `DeliverySource` (the invitation verb) is unrelated: leave it.
  - Add to `class-reminders.test.ts`: when the adapter **throws** for one recipient, the result counts an email failure and the sweep carries on (mirror the existing reported-failure test with `deliverMock.mockRejectedValueOnce(new Error('network'))`).
  - `degradation-digest.test.ts`: the mock becomes `vi.mock('@/lib/email', () => ({ sendEmail: (...a: unknown[]) => sendEmail(...a) }))` with `const sendEmail = vi.fn()`. Rename the uses. Calls assert `expect.objectContaining({ to: …, audience: 'platform' })`, and the content assertions read `content.subject` / `content.html`. The not-configured case uses reason `'LETTERMINT_API_TOKEN is not configured'`.

- [ ] **Step 6: Run green.**
  - `pnpm exec vitest run --project unit src/lib/email.test.ts`.
  - Find which vitest project each of the four service test files belongs to: check `SERIAL_TESTS` in `vitest.config.ts`. Then run them with `pnpm exec vitest run --project <project> <files>`.
  - `pnpm run typecheck && pnpm run lint`.
  - `grep -rn "sendHtmlEmail\|RESEND_API_KEY\|re_placeholder" src` must print only `src/services/email-fallback.ts` and its two test files (Task 4 owns those).

- [ ] **Step 7: Prove the guards bite.** Apply each break, record the failing test and assertion, restore, re-run green:
  1. Remove the `try`/`catch` in `sendEmail` → "adapter throws" must fail.
  2. Change the production condition to `false` → "no key, production → ok:false" and the five wrapper production-throw tests must fail.
  3. Swap the audience branches (`'class'` gets Reply-To) → the platform/class routing tests must fail.
  4. Replace `env(...)` with `process.env[...]` for `LETTERMINT_CLASS_ROUTE` → the `''` route test must fail.

- [ ] **Step 8: Commit**

```bash
git add src/lib/email.ts src/lib/email.test.ts src/services/class-reminders.ts src/services/class-reminders.test.ts \
  src/services/degradation-digest.ts src/services/degradation-digest.test.ts \
  src/services/invitations.notify.test.ts src/services/invitations.deliver.test.ts
git commit -m "feat: sendEmail — one seam that never throws, refuses to pretend in production, and chooses Reply-To and route by audience (#800)"
```

---

### Task 4: email-fallback through the seam, and `resend` removed

**Files:**
- Modify: `src/services/email-fallback.ts` (imports, the lazy client near the top, the dry-run branch, the send in the claim loop)
- Test: `src/services/email-fallback.test.ts`, `src/services/email-fallback.consent.test.ts`
- Modify: `package.json`, `pnpm-lock.yaml`

**Interfaces:**
- Consumes: `sendEmail`, `SendResult` (Task 3). `renderNotificationEmail` returns `RenderedEmail` (Task 2).
- Produces: nothing new. `processEmailFallback`'s signature and return are unchanged.

- [ ] **Step 1: Migrate the two test files' mocks**, exactly as Task 3 Step 5 does for the `resend`-mocking files: the `deliverMock` adapter mock, `LETTERMINT_API_TOKEN='lm_test_dummy'`, and the result shapes. Fix the header comment of `email-fallback.test.ts` that explains the unset `RESEND_API_KEY` dry-run so it describes the new variable and behaviour.

- [ ] **Step 2: Add the failing tests** to `email-fallback.test.ts`, next to the existing send-failure tests and using their fixtures:
  - the adapter **throws** for one notification → its claim is released (`emailSent` back to `false` on the row), the sweep throws `email fallback: 1 of N sends failed`, and other notifications still send.
  - the adapter answers `{ ok: false, reason: 'lettermint 500: x' }` → claim released and counted, same as above. Keep the existing test if it already covers this; otherwise add it.
  - **production with no token** (`vi.stubEnv('NODE_ENV','production')`, delete `LETTERMINT_API_TOKEN` and `EMAIL_DRY_RUN`) → the adapter is not called, every candidate's claim is released (`emailSent` stays `false`), and the sweep throws. This is the silent mark-as-emailed the spec closes.
  - dry-run outside production (no token) → the notification ends `emailSent: true` and the adapter is not called. That's the same end state as the old dry-run branch.
  - each send carries `idempotencyKey: \`notification-${id}\``, no `replyTo`, and `route` from `LETTERMINT_CLASS_ROUTE` when set.

- [ ] **Step 3: Run red.** Use the project the files belong to (check `SERIAL_TESTS` in `vitest.config.ts`):
  `pnpm exec vitest run --project <project> src/services/email-fallback.test.ts src/services/email-fallback.consent.test.ts`
  Expected: the production-no-token, throw-releases-claim (if new) and idempotency tests fail.

- [ ] **Step 4: Implement.** In `email-fallback.ts`:
  - delete `import { Resend } from 'resend'`, the `resendClient`/`resend()` block and its comment, and the `if (emailDryRun()) { … markOne … }` branch. Import `sendEmail` from `@/lib/email` and drop `emailDryRun` if nothing else uses it.
  - replace the send inside the existing `try`:

  ```ts
      const result = await sendEmail({
        to: email,
        audience: 'class',
        content: renderNotificationEmail({
          ...notification,
          payGuidance: await studentPaymentEmailGuidance(db, notification),
        }),
        idempotencyKey: `notification-${notification.id}`,
      });
      // `sendEmail` never throws for a refusal; an unchecked result would leave
      // the claim standing on a notification whose email never went out.
      if (!result.ok) {
        log.error({ notificationId: notification.id, reason: result.reason }, 'email fallback send failed');
        await releaseOne(notification.id);
        failed++;
        continue;
      }
      sent++;
  ```

  The outer `catch` (which releases and counts) stays: rendering and `studentPaymentEmailGuidance` can still throw.
  - Read the comment near the top of the sweep that mentions `EMAIL_DRY_RUN` (around the opted-out-candidates note) and any other comment naming Resend or the deleted branch. Reword each so it is true now. A grep finds names, not descriptions: read the whole docblocks of the functions you touched.

- [ ] **Step 5: Run green**, using the same command as Step 3, plus `pnpm run typecheck && pnpm run lint`.

- [ ] **Step 6: Remove the package.**
  - Run `pnpm remove resend`.
  - `grep -rn "resend'" src tests` (the import specifier) must print nothing.
  - `grep -rn "from 'resend'\|vi.mock('resend'\|RESEND_API_KEY\|re_placeholder" src tests` must print nothing.
  - `grep -n -i resend docs/supply-chain.md` — update it if it lists the package.
  - Run `pnpm run check-lockfile`.

- [ ] **Step 7: Prove the guards bite.** Apply each break, record the failing assertion, restore, re-run green:
  1. Delete the `releaseOne` call in the `!result.ok` branch → the reported-failure and production-no-token tests must fail.
  2. Drop the `idempotencyKey` line → the idempotency test must fail.

- [ ] **Step 8: Commit**

```bash
git add src/services/email-fallback.ts src/services/email-fallback.test.ts src/services/email-fallback.consent.test.ts package.json pnpm-lock.yaml
# plus docs/supply-chain.md if Step 6 edited it
git commit -m "feat: email-fallback sends through sendEmail with an idempotency key and never marks an unsent email; resend removed (#800)"
```

---

### Task 5: Configuration and documentation

**Files:**
- Modify: `.env.example`, `.github/workflows/ci.yml`, `.github/workflows/e2e-flake-repro.yml`, `DEPLOYMENT.md`, `docs/technical-architecture.md`, `docs/data-model.md`, `src/lib/notify-health.ts` (comments only), `src/services/invitations.ts` (comments only)

**Interfaces:** none. No behaviour changes. The test for this task is the sweep in Step 3.

- [ ] **Step 1: Configuration.**
  - `.env.example`: replace `RESEND_API_KEY=""` with:
    ```
    LETTERMINT_API_TOKEN=""
    LETTERMINT_CLASS_ROUTE=""
    EMAIL_FROM=""
    EMAIL_REPLY_TO=""
    ```
    Keep any adjacent comment style the file uses.
  - `ci.yml` (three jobs) and `e2e-flake-repro.yml` (one job): delete each `RESEND_API_KEY: re_test` line and keep `EMAIL_DRY_RUN: '1'` and `EMAIL_FROM`. Re-derive the count with `grep -n RESEND .github/workflows/*.yml` before and after; after must be empty.

- [ ] **Step 2: Docs.** Make each edit true for the code as Tasks 1–4 left it:
  - `DEPLOYMENT.md`:
    - Prerequisites line: a Lettermint project API token (`lm_…`), with two transactional routes.
    - Env table: replace the `RESEND_API_KEY` / `EMAIL_FROM` row with `LETTERMINT_API_TOKEN` / `EMAIL_FROM` (without them production refuses every send and the failure reaches logs and `/api/health`, rather than "sending" silently). Add a `LETTERMINT_CLASS_ROUTE` row: the slug of a second **transactional** route for class mail. Unset, class mail shares the default route, so a spam complaint about an announcement or invitation suppresses that address's sign-in mail. Not a broadcast route: its hosted unsubscribe is an opt-out list the app cannot see. Add an `EMAIL_REPLY_TO` row: default `hello@fair.yoga`, used on platform mail only.
    - A short **Email provider** subsection near the env table:
      - open and click tracking must be **off** in the Lettermint project, because click tracking rewrites links through the provider's redirect domain and would hand it magic-link tokens;
      - send from a subdomain (`notify.fair.yoga`), with SPF and DKIM records from Lettermint;
      - one DMARC record on the apex, starting at `p=none` with `rua` to `ops@fair.yoga`.
  - `docs/technical-architecture.md`:
    - Stack table row: Email | Lettermint (HTTP API, EU-hosted), with a note that the provider sits behind `sendEmail`.
    - File-tree line for `email.ts`: `# sendEmail seam`. Add a line for `email-lettermint.ts`: `# the provider adapter`.
    - Auth-flow step 3: name the transactional email provider, not Resend.
    - The email-fallback claim bullet: "before sending".
    - Env block: the four variables from `.env.example`.
    - Observability paragraph: replace "Resend's error message inside `lib/email.ts`'s errors" with the provider's error message carried in `SendResult.reason` and the wrappers' errors. Replace "dry-run email mode logs recipient addresses, magic links and invitation sign-in URLs" with what is true now: `sendEmail`'s dry-run line logs only the subject, and the development-only `[DEV]` console lines print the magic link and invitation sign-in URL with the address.
    - Add a short subsection under The Services Layer (or beside the existing email notes): one seam, `audience` decides Reply-To and route, and production refuses without a token. Link the spec.
  - `docs/data-model.md` (`last_notify_failed_at` row): "during a Resend outage" becomes "during an email-provider outage".
  - `src/lib/notify-health.ts` and `src/services/invitations.ts`: reword comments that name Resend to say "the email provider". Comments only.

- [ ] **Step 3: Sweep for what was invalidated.**
  - `grep -rn "Resend\b\|RESEND\|re_placeholder\|sendHtmlEmail\|resend()" src tests docs/*.md DEPLOYMENT.md .env.example .github README.md CONTRIBUTING.md AGENTS.md`
  - Give every hit a verdict in the report. Expected legitimate survivors: the invitation *resend* verb (route paths, `DeliverySource`, UI copy), and `docs/implementation-plan.md` (historical).

- [ ] **Step 4: Commit**

```bash
git add .env.example .github/workflows/ci.yml .github/workflows/e2e-flake-repro.yml DEPLOYMENT.md \
  docs/technical-architecture.md docs/data-model.md src/lib/notify-health.ts src/services/invitations.ts
git commit -m "docs: Lettermint configuration, routes, tracking off and the DNS plan; Resend references removed (#800)"
```

---

## After the tasks

- Run `pnpm run verify` (needs the app live on :3000 — check, never restart it). Also run `pnpm run build`: CI builds, `verify` does not, and the adapter must stay server-only.
- Whole-branch review (5 tasks), then one fix wave and one scoped re-review, per `solve-issue` §5. Cross-task risks to hand that reviewer:
  - that Task 3's audience map matches the spec table for every sender;
  - that no test anywhere still mocks a module nothing imports;
  - that every renderer's footer matches the spec's *Footers* table.
