# Email provider seam, Lettermint, Reply-To and a text part — design (#800)

## Problem

Outgoing email is built directly on the Resend SDK. Two separate clients
(`src/lib/email.ts`, `src/services/email-fallback.ts`) and seven
`emails.send` call sites (six in `email.ts`, one in `email-fallback.ts`) each
repeat `from` / `to` / `subject` / `html`; none sets `text`, `reply_to` or
`headers`. Moving to Lettermint (EU-hosted, fits *Privacy first*) should be a
one-file change, and the two deliverability gaps the issue names (no
`Reply-To`, no text part) should be fixed once rather than per site.

## What the issue got right, and what it did not

Measured on `main` at `1e76deed`.

**Held:**

- Two clients, seven send sites, no `text` / `reply_to` / `headers` anywhere
  (`grep -rn "emails.send\|new Resend" src`).
- Six test files mock `resend` directly: `src/lib/email.test.ts`,
  `src/services/{class-reminders,email-fallback,email-fallback.consent,invitations.notify,invitations.deliver}.test.ts`.
- `ci.yml` (three jobs) and `e2e-flake-repro.yml` (one) set
  `RESEND_API_KEY: re_test`; `.env.example`, `DEPLOYMENT.md` and
  `docs/technical-architecture.md` name Resend.

**Incomplete:**

1. **The seam already half-exists.** `sendHtmlEmail` (`email.ts`) already
   answers `{ ok: true } | { ok: false, reason }` for an SDK `{ error }`, and
   both its callers (`class-reminders.ts`, `degradation-digest.ts`) also catch a
   throw. Every one of the seven sites handles both failure modes correctly
   today; the issue's Effect 2 is a structural risk, not a live bug.

2. **The live silent failure is the dry-run path, which the issue does not
   name.** With no key in production and no explicit `EMAIL_DRY_RUN=1`, only
   `sendMagicLinkEmail` (throws) and `sendHtmlEmail` (`ok: false`) refuse.
   Five paths log a line and report success:

   | Path | What a missing key does today |
   |---|---|
   | `sendInvitationEmail` | `console.log`, returns |
   | `sendPasskeyAddedEmail` / `sendPasskeyRemovedEmail` | `log.info`, returns |
   | `sendPayoutChangedEmail` — the security alert | `log.info`, returns |
   | `email-fallback.ts` dry-run branch | logs, **marks the notification emailed** |

   `DEPLOYMENT.md`'s env table says "the app refuses to 'send' silently
   without them" — true of two paths out of seven.

3. **Lettermint needs no SDK.** Its sending OpenAPI schema
   (`https://lettermint.co/docs/api-reference/sending/0.0.1/lettermint-sending-openapi.json`):
   `POST https://api.lettermint.co/v1/send`, header `x-lettermint-token`, body
   `{ from, to[], subject, html, text, reply_to[], headers{} , … }`, success
   `202 { message_id, status }`, errors 401/403/409/422/429/500 in three body
   shapes (`{ message }`, `{ error: { code, message } }`,
   `{ message, errors }`). Open/click tracking is a project setting, not a
   per-message field. Every send names a **route** (`route` in the body;
   omitted → the project's default, `outgoing`, transactional). A spam
   complaint or unsubscribe suppresses the address **on the route it came
   from**; a hard bounce suppresses it team-wide. A send to a suppressed
   recipient is skipped, and the docs do not say what the API answers — so
   assume a 202 the app cannot tell from delivery. A broadcast route injects
   a Lettermint-hosted unsubscribe link and keeps its own unsubscribe list;
   disabling that needs a higher plan and support. An optional `Idempotency-Key` header (1–255 chars)
   returns the original response for a repeat with the same key **and body**
   within 24 hours; the same key with a different body answers 409.

4. **A text part is cheap.** All seven renderers in `email-templates.ts` emit
   only `<p>`, `<a>`, `<br>`, `<h1>`, `<div>` inside the shared `wrapEmail`.

## Decisions

| Question | Decision |
|---|---|
| Resend | Removed. One adapter; the `resend` package is dropped. |
| Adapter transport | `fetch` against the HTTP API. No SDK (`docs/supply-chain.md`). |
| Key variable | `LETTERMINT_API_TOKEN`. Named after the provider on purpose: a provider switch makes the old token meaningless, and a neutral name would hide that. |
| Reply-To, platform mail | `EMAIL_REPLY_TO`, default `hello@fair.yoga`. |
| Reply-To, class mail | **None.** The footer says replies are not read. Exposing the teacher's address was rejected (it is not exposed today). |
| Text part | A shared block model rendered to both html and text. |
| Idempotency key | Sent by `email-fallback` only, salted with a payload hash. |
| Lettermint routes | Two **transactional** routes, chosen by `audience`: platform mail on the project's default route, class mail on `LETTERMINT_CLASS_ROUTE`. No broadcast route. |
| Invitation | `class` audience: class route, no Reply-To. |

## Design

### The seam — `src/lib/email.ts`

```ts
export type RenderedEmail = { subject: string; html: string; text: string };

export type EmailMessage = {
  to: string;
  /** Decides Reply-To. Required, so every new sender has to choose. */
  audience: 'platform' | 'class';
  content: RenderedEmail;
  /** Passed to the provider untouched. #801 adds List-Unsubscribe here. */
  headers?: Record<string, string>;
  /** Caller-stable id for a send that may be retried; see the adapter. */
  idempotencyKey?: string;
};

export type SendResult =
  | { ok: true; delivery: 'sent' | 'dry-run' }
  | { ok: false; reason: string };

export async function sendEmail(message: EmailMessage): Promise<SendResult>;
```

- **Never throws.** An adapter `ok: false` and anything the adapter throws both
  come back as `ok: false`.
- **One production rule.** Dry-run when `EMAIL_DRY_RUN=1` or no key. In
  production with no key and no explicit `EMAIL_DRY_RUN=1`, answer
  `{ ok: false, reason: 'LETTERMINT_API_TOKEN is not configured' }` — never a
  dry-run. Otherwise dry-run logs `{ subject }` (no address) and answers
  `{ ok: true, delivery: 'dry-run' }`.
- **Reply-To and route from `audience`.** `platform` →
  `Reply-To: EMAIL_REPLY_TO || 'hello@fair.yoga'`, no `route` (the project's
  default). `class` → no Reply-To, `route: LETTERMINT_CLASS_ROUTE`. When that
  variable is unset, class mail rides the default route (it still sends), and
  in production the first such send logs one `log.warn` naming the variable.

  Why two routes: suppression is route-scoped. On one route, a student who
  marks a teacher's announcement as spam is suppressed for every mail on that
  route, magic links included, and the API most likely still answers 202 — a
  sign-in that fails with nothing to see. Splitting by audience keeps a
  complaint about class mail away from sign-in. Both routes are
  transactional because a broadcast route's hosted unsubscribe would be an
  opt-out list the app cannot see, and would let a student unsubscribe at the
  provider from essential booking and payment mail, which
  `notification-policy.ts` always emails.
- **From.** `EMAIL_FROM || 'noreply@fair.yoga'`, in one place.
- `emailDryRun()` stays exported; `emailConfigured()` reads
  `LETTERMINT_API_TOKEN`. The `re_placeholder` sentinel goes.

Which mail is which:

| Sender | Audience |
|---|---|
| magic link, passkey added / removed, payout changed, degradation digest | `platform` |
| `email-fallback` (every notification type), class reminders, invitation | `class` |

The invitation is `class`: to a stranger it is unsolicited, so it is the mail
most likely to draw a complaint, and a complaint on the platform route would
suppress that person's future sign-in links. The cost is that a stranger's
"who is this?" reply reaches nobody.

### Footers

`wrapEmail`'s `footer` becomes **required**. Today the magic link, the
invitation and both passkey notices fall back to `UNREAD_FALLBACK_FOOTER` —
"You get emails like this when an in-app message goes unread; turn them off in
your settings." — which is false for all four, and is the reason the payout
renderer already passes its own. Every renderer now names its footer:

| Renderer | Footer |
|---|---|
| notification fallback | `UNREAD_FALLBACK_FOOTER` + *Replies to this email are not read.* |
| class reminder | `CLASS_REMINDER_EMAIL_FOOTER` + *Replies to this email are not read.* |
| invitation | *You get this email because a teacher on fair.yoga added your address. Replies to this email are not read.* |
| magic link, passkey added / removed | *You get this email because of activity on your fair.yoga account.* |
| payout changed, degradation digest | unchanged |

`wrapEmail` knows nothing of audience; the footer stays the renderer's
choice. Copy is provisional for the UX copy phase.

### Callers

- **The five throwing wrappers keep their contract** (magic link, invitation,
  passkey added / removed, payout changed): render → `sendEmail` → throw on
  `ok: false`. Their callers already catch: `deliverSignInLink`'s caller,
  `deliverInvitation` (which also feeds `notify-health`), and the
  `FireAndForget` IIFEs in `passkey-notice.ts` and `payout-notice.ts`, each
  ending in `log.error`. On `delivery: 'dry-run'` the magic-link and invitation
  wrappers keep printing their dev line with the link, as today; the passkey
  and payout wrappers keep logging nothing sensitive.
- **Consequence:** in production without a key, all five now throw, where only
  the magic link did. #730's tests stay green against the new variable name.
- **`sendHtmlEmail` is removed**; `class-reminders.ts` and
  `degradation-digest.ts` call `sendEmail` with `audience: 'class'` and
  `'platform'` respectively. Their existing `ok: false` handling is unchanged.
- **`email-fallback.ts` loses its client and its dry-run branch.** It claims,
  calls `sendEmail` with `idempotencyKey: \`notification-${id}\``, and releases
  the claim on `ok: false`. In production without a key it now releases and
  counts a failure — the sweep throws and `/api/health` goes red — instead of
  marking the notification emailed. In development dry-run answers `ok: true`,
  which leaves the row marked exactly as the old dry-run branch did.

### The adapter — `src/lib/email-lettermint.ts`

The only file that knows Lettermint exists.

```ts
export async function deliverViaLettermint(
  payload: { from: string; to: string; replyTo?: string; route?: string; subject: string;
             html: string; text: string; headers?: Record<string, string>;
             idempotencyKey?: string },
  token: string,
): Promise<{ ok: true } | { ok: false; reason: string }>;
```

- `fetch` with `AbortSignal.timeout(10_000)`. Token passed in per call: nothing
  to construct, so the lazy-client hazard both old comments described is gone.
- `to` and `reply_to` sent as one-element arrays; `route` sent when given;
  `headers` sent as given.
- Non-2xx → `{ ok: false, reason: \`lettermint ${status}: ${message}\` }`,
  `message` read from whichever of the three error shapes the body has, or the
  status text when the body is not JSON. A rejected `fetch` (network, timeout)
  → `ok: false` with the error's message.
- **Idempotency.** When `idempotencyKey` is set, send
  `Idempotency-Key: ${key}-${sha256(body).slice(0, 16)}`. Same body within 24 h
  → Lettermint returns the original response, no duplicate. Changed body (e.g.
  the teacher paused payments, so the Pay now button went) → a different key,
  a new send, never a 409 loop. Keeps the header within 255 characters.

### Text part — block model in `email-templates.ts`

```ts
export type EmailBlock =
  | { kind: 'paragraph'; lines: string[]; tone?: 'body' | 'note' | 'intro' | 'strong' }
  | { kind: 'button'; label: string; href: string };

export function wrapEmail(
  heading: string,
  blocks: readonly EmailBlock[],
  footer?: string,
): { html: string; text: string };
```

- Every renderer builds blocks from **plain strings** and returns
  `RenderedEmail`. `wrapEmail` escapes every line, label and href exactly once,
  so a renderer can no longer forget `escapeHtml`. (Today the magic-link and
  invitation hrefs are interpolated unescaped; they are app-built, so not a
  live bug.)
- `paragraph.lines` join with `<br>` in html and `\n` in text; `tone` maps to
  the existing inline styles (`note` = the 13px muted line, `intro` = the
  notification framing line, `strong` = the digest's code line).
- Text: heading, blank line, blocks separated by blank lines, a button as
  `Label: https://…`, then the wordmark line and footer.
- The html renders as it does today, whitespace aside.

### Configuration and docs

- `.env.example`: `LETTERMINT_API_TOKEN`, `LETTERMINT_CLASS_ROUTE`,
  `EMAIL_FROM`, `EMAIL_REPLY_TO`.
- CI: the four `RESEND_API_KEY: re_test` lines are deleted, not renamed —
  `EMAIL_DRY_RUN: '1'` already forces dry-run there.
- `DEPLOYMENT.md`: prerequisite (Lettermint project token), env-table row with
  wording that is now true for every sender, a required provider setting —
  **open and click tracking off**, because click tracking rewrites links
  through the provider's redirect domain and would hand it magic-link tokens —
  a required second **transactional** route for class mail (its slug in
  `LETTERMINT_CLASS_ROUTE`; not broadcast, for the reason under *The seam*) —
  and a short DNS note: send from `notify.fair.yoga`, SPF/DKIM from Lettermint,
  one DMARC record on the apex starting at `p=none` with reports to
  `ops@fair.yoga`.
- `docs/technical-architecture.md`: stack table, file tree line, auth-flow step
  3, the email-fallback claim bullet, the env block, and the observability
  paragraph's "Resend's error message" and "dry-run logs recipient addresses"
  clauses.
- `docs/data-model.md` (`last_notify_failed_at`) and comments in
  `src/lib/notify-health.ts` / `src/services/invitations.ts` that name Resend
  are reworded provider-neutrally. Legitimate survivors: the invitation
  *resend* verb (`api/invitations/[id]/resend`, `contact-form.tsx`), and
  `docs/implementation-plan.md` (historical).

## Testing

- **Adapter** (`fetch` mocked): 202 → ok; each of the three error shapes on a
  422 → `ok: false` with that message; non-JSON 500; rejected fetch; timeout;
  `reply_to`, `headers`, `text` reach the body; `Idempotency-Key` absent
  without a key, present with one, different for a different body.
- **`sendEmail`** (adapter mocked): success; adapter `ok: false`; adapter
  throws — both `ok: false` with a reason; production + no key → `ok: false`;
  `EMAIL_DRY_RUN=1` → dry-run; audience → Reply-To and route; class route
  unset → default route plus one production warning; `headers` passed
  through.
- **Callers:** `email-fallback` releases its claim and counts a failure for
  both failure modes and for production-without-key; `class-reminders` and
  `degradation-digest` see the failure; each of the five wrappers throws on
  `ok: false`; the magic-link production guard (#730) still fails loudly.
- **Templates:** each of the seven renderers' text contains its essential copy
  and every href in its html (the magic link, the pause link); no platform
  renderer's footer mentions unread messages or settings, and both class-mail
  footers and the invitation's say replies are not read.
- Tests mock `@/lib/email` or the adapter module; no test mocks a vendor.

**Guards to prove by breaking** (break, record the failure text, restore):
the never-throw catch in `sendEmail`; the production no-key rule; the
audience → Reply-To and route switch; claim release in `email-fallback`; the payload hash
in the idempotency key; escaping in `wrapEmail`.

## Out of scope

- `List-Unsubscribe` — #801, on top of `headers`.
- An idempotency key for the degradation digest (it retries a released claim
  on a daily cadence; a duplicate digest to the operator is harmless).
- Lettermint pricing and the cut-over itself.
- Detecting suppression in the app (`suppression.added` webhook). A
  suppressed sign-in still fails invisibly; the route split narrows who can
  trigger it, it does not report it.
