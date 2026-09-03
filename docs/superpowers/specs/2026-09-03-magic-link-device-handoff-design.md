# Magic link: device handoff by code, and the two live defects found under it

Issue: #214 (`Decision: bind a magic link to the device that requested it?`),
sub-issue of #383 (Production readiness), labelled `security`.

#214 was filed as a decision, not as work. The decision is made here — and the
premise sweep found two live defects underneath it that #214 does not name, one
of which is an availability bug that locks real users out of sign-in. Both are
fixed by the same mechanism the decision picks, which is the main reason to
build it rather than answer #214 with "accept the risk".

(Note the phrasing: GitHub's auto-close parser matches `close`/`fixes`/
`resolves` immediately before a `#N`, negation and quoting included, so this
document says "answer #214" throughout. See CLAUDE.md's hazard list.)

---

## 1. Verifying the issue's premise

### 1.1 All seven of #214's factual claims hold

Unusual for this project, and worth stating so nobody re-derives them. Verified
against the code, not assumed:

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 1 | 32 random bytes, only `sha256` persisted, raw stored nowhere | TRUE | `src/lib/auth/magic-link.ts:39-51`; `prisma/schema.prisma:1015-1023` has `tokenHash String @unique` and no raw column |
| 2 | Single-use via atomic delete, not a flag | TRUE | `magic-link.ts:70-75` — `deleteMany` then `if (deleted.count === 0) return null`. No `used`/`consumedAt` column exists |
| 3 | 15-minute TTL, swept daily by `cleanupExpiredAuth` | TRUE | `magic-link.ts:6,41`; `src/services/auth-cleanup.ts:10-19`; `src/lib/scheduler.ts:244-246` |
| 4 | Rate limited per IP *and* per address | TRUE | `src/app/api/auth/magic-link/send/route.ts:9-11,27-28,37-38` |
| 5 | A successful sign-in deletes every other live token for the address | TRUE | `magic-link.ts:97`, placed after the expiry check by design (`:87-90`) |
| 6 | `booking-sign-in.tsx` requests a link with a `redirect`, on a public page | TRUE | `src/components/booking/booking-sign-in.tsx:35-39`; mounted at `src/app/(public)/[slug]/book/[classId]/page.tsx:173`; no middleware guards `(public)` (`src/proxy.ts:27-35`) |
| 7 | A comment on `generateMagicLinkToken` records why token reuse is not buildable | TRUE | `magic-link.ts:28-32` |

Two precisions on claim 3 and claim 5 that the issue does not carry:

- The TTL is **caller-overridable** (`magic-link.ts:37,41`), and one caller uses
  an hour: `src/lib/auth/signup-ticket.ts:13`. "15 minutes" is the default, not
  an invariant of the table.
- The sibling purge at `magic-link.ts:97` deletes **every** row for the address,
  not only live `sign_in` ones — a live `teacher_profile_pending` signup ticket
  for the same address goes with them. Out of scope here; noted in §11.

### 1.2 The blocking question was already answered, and is now answered twice

#214 closes by asking for one thing: *is a student expected to be able to
request a link on one device and open it on another?* A comment on the issue
records Ivo answering it while designing #385 ("i quite often start on my phone.
receive the email on my laptop and continue from there"), and he restated it
when this session opened. **Cross-device is a requirement.** #214's Option 1
(strict binding) is dead, and #385 raised the cost of killing it from "breaks a
convenience" to "breaks teacher signup", since signup's ticket is handed to the
device that opens the link.

What was *not* previously settled, and is settled in §2: which device ends up
signed in.

### 1.3 Defect A — `/verify` already promises device binding that does not exist

`src/app/(public)/verify/page.tsx:85-87` renders:

> "You tapped a one-time link. We're confirming it's still valid and that it was
> meant for **this device**."

and `:180` lists, as one of three reasons a link failed:

> "It was opened on a device that wasn't expecting it"

There is no device binding anywhere in `src/`. Re-derive:

```bash
grep -rniE "deviceId|device_id|bindDevice|requestingDevice|deviceCookie|deviceHash" src/ --include="*.ts" --include="*.tsx"
grep -rn "Set-Cookie" src/ --include="*.ts" --include="*.tsx"
grep -nE "cookie|Cookie|headers" src/app/api/auth/magic-link/send/route.ts
```

The first returns only two unrelated hits in `add-passkey.tsx` (biometric
"fingerprint" copy). The second returns exactly two cookies, `fair_yoga_session`
(`src/lib/auth/session.ts:7`) and `fair_yoga_signup`
(`src/lib/auth/signup-ticket.ts:5`), both set at or after verify. The third
returns nothing: **the send route touches no headers at all**, so there is
nothing at request time to bind to.

The user-facing consequence is a false diagnosis: someone whose link genuinely
expired is offered "opened on a device that wasn't expecting it" as a candidate
explanation for a check the product never performs. This is a defect a user
hits, so it is fixed here regardless of which option §2 picks.

### 1.4 Defect B — a JS-executing mail scanner burns the link *and* every sibling

#214 names "a corporate scanner that prefetches URLs" as an interception vector,
and its comment reports this as already mitigated: `/verify?token=` is a page,
consumption happens on a JS-issued POST, so a plain `GET` burns nothing. Both
halves are true. The comment stops one step short of the consequence.

Consumption is a `useEffect` that fires **unconditionally on mount, with no user
gesture** — there is no button on `/verify` to press
(`src/app/(public)/verify/page.tsx:243-249`). Any headless-browser link checker,
which is routine in corporate email security, executes it. And success deletes
every token for that address (`magic-link.ts:97`).

So the failure is not a confidentiality leak, it is an **availability loop**:

```
request link → scanner opens it → token + siblings deleted
             → human clicks → "Invalid or expired magic link"
             → request again → scanner opens it → …
```

A user behind such a gateway cannot sign in at all, and the error copy tells
them the link is old or already used. Nothing gates it, and no test exercises
it. This is the strongest argument in the whole issue for building something
rather than choosing #214's Option 4, and #214 does not contain it.

### 1.5 The ceiling: none of this closes mailbox compromise

Stated so it is not re-litigated. An attacker who *controls the inbox* does not
need to intercept anything — they request their own link for the victim's
address, and it is then same-device by construction. No cookie, code, or
binding scheme at this layer can prevent that. Passkeys are the answer to a
compromised mailbox, and this project already has them
(`src/app/(public)/login/page.tsx:75`).

What this design does close: forwarded mail, a link pasted into a chat, a shared
or snooped mailbox where the *request* came from the victim, and Defect B.

**A second, narrower residual: relaying the code.** An attacker who requests a
link for the victim's address from their own browser gains nothing directly —
the victim's click still lands the victim in the handoff branch, not a session
for the attacker. But it opens a social-engineering angle: a relay pretext
could get the victim to read the displayed code back to the attacker, handing
over a real session. The code screen now warns against this (§7); no
code-level guard closes it, since the mechanism cannot distinguish a
legitimate self-relay (a user reading their own code aloud to enter it on
another device) from this attack.

### 1.6 Two documentation defects found in passing

- `docs/technical-architecture.md:326-333` describes the flow as "a signed token
  (oslo/crypto)". Nothing is signed: generation is `crypto.randomBytes`, and
  oslo supplies only the SHA-256.
- `MAGIC_LINK_SECRET` appears in `README.md:30`,
  `docs/technical-architecture.md:574` and `:617`, and is **read nowhere in the
  code** — a dead environment variable that a deployer would dutifully set.

Both are corrected in this branch (§10).

---

## 2. The decision: handoff by code, session on the requesting device

**Chosen: #214 Option 2 (soft binding), in the variant where the session lands
on the device that requested the link, and a mismatch is resolved by carrying a
short code back to it.** This is the Slack / Notion / Claude.ai shape.

### The flow

| Step | Behaviour |
|---|---|
| Request (phone) | `POST /api/auth/magic-link/send` mints the token **and** ensures an httpOnly browser-nonce cookie, `fair_yoga_origin` (naming follows the two existing cookies, `fair_yoga_session` and `fair_yoga_signup`). The waiting page shows "check your email" plus an always-visible code input. |
| Link opened on the **same browser** | Nonce matches the token's record → consume → session. Today's path plus one check. |
| Link opened **anywhere else** | Nonce absent or mismatched → **the token is not consumed** → a 6-digit code is stamped on the row and displayed, alongside a "Sign in here instead" link that restarts the flow on that device. |
| Code typed on the phone | `POST /api/auth/magic-link/claim` (cookie + code) → consume → session on the phone → follow the token's `redirectTo`, so the booking flow still lands on the right class. |

`fair_yoga_origin` carries the same flags as the two existing cookies
(`httpOnly`, `SameSite=Lax`, `Path=/`, and `Secure` only when
`NODE_ENV === 'production'` — `src/lib/auth/session.ts:142-148`), so it works
over plain HTTP in local development.

### Why this variant, and what was rejected

- **Option 1, strict binding** — dead per §1.2; would break #385 signup.
- **Option 3, bind only some links** — splits the mental model, and #385 made
  the booking-style flow the signup flow too, so the split no longer follows a
  real seam.
- **Option 4, do nothing** — rejected because of Defect B. "Accept the residual
  interception risk" was a defensible read of #214 as filed; it is not a
  defensible read of an availability bug that locks users out.
- **A plain "continue?" confirmation** (the cheap reading of Option 2) — an
  interceptor sees the same screen and clicks the same button, so it buys
  nothing against a human. It *would* fix Defect B, but for the same build cost
  the code handoff fixes Defect B **and** interception.
- **Code-only, no link at all** — strongest on both defects and simplest to
  build, but it makes the dominant path worse: same-device on mobile becomes
  "switch to Mail, read six digits, switch back, type" for a product whose
  CLAUDE.md says teachers use it on their phone between classes. The handoff
  variant keeps that path a single tap.
- **The inverted variant** (requester displays, opener consumes; session on the
  opener) — matches the literal wording of Ivo's phone→laptop preference, but
  its lockout does not self-heal: if the requesting tab is gone, there is no way
  forward. Explicitly dropped by Ivo in favour of the chosen variant, on the
  grounds that "request a fresh link from the device you're on" is an acceptable
  recovery — and that recovery is *frictionless*, because it is then a
  same-device flow.

### The full surface: two flows × two roles, three doors, four panels

An earlier draft of this spec described the change as if `/send` were the only
door. It is not, and the gap was found at the spec review gate. Re-derive:

```bash
grep -rn "sendMagicLinkEmail(" src/ --include="*.ts" | grep -v "export async function"
grep -rn "generateMagicLinkToken(" src/ --include="*.ts" | grep -v "export async function"
grep -rn "Check your inbox" src/ --include="*.tsx"
```

**Three endpoints mint a link and email it**, and all three must bind the nonce:

| Door | Serves | Mint + send |
|---|---|---|
| `POST /api/auth/magic-link/send` | **Sign-in, both roles** — it looks up `Teacher` first, then `Student` (`send/route.ts:41-42`) | `:45`, `:48` |
| `POST /api/auth/teacher-signup` | Teacher signup | `teacher-signup/route.ts:36`, `:42` |
| `POST /api/auth/student-signup` | Student signup | `student-signup/route.ts:107`, `:109` |

There is a **fourth** caller of `generateMagicLinkToken` — `signup-ticket.ts:16` —
which mints the `teacher_profile_pending` ticket. It **emails nothing**; the
ticket is handed back in a cookie to a device that is already present. It is not
a door, takes no nonce, and §3 keeps it out of the handoff path entirely. The
three doors are exactly the three `deliverSignInLink` call sites, which is the
seam the tether below uses — `sendMagicLinkEmail` itself now has exactly one
caller, inside `deliverSignInLink`.

**Four "Check your inbox" panels** must therefore carry the code input:

| Panel | Reached from |
|---|---|
| `src/app/(public)/login/page.tsx:35` | `/login` — both roles |
| `src/components/booking/booking-sign-in.tsx:49` | The public booking page, serving **both** its modes — returning (`:35` → `/send`) and new (`:30` → `/student-signup`) |
| `src/components/signup/signup-form.tsx:59` | `/signup` — teacher signup (#385) |
| `src/components/signup/profile-setup-form.tsx` | The `expired` status: the 1-hour ticket aged out mid-form, so `:280` re-sends a teacher-signup link with every field preserved |

The fourth is the one to design against, not the easiest. The user is on
`/signup/profile` with a half-typed profile draft; their ticket expired; a fresh
link goes out. Under this design, opening that link elsewhere yields a code they
carry back to the page **that still holds their draft** — which is exactly right,
and is the clearest illustration of why the session belongs on the requesting
device. Omit the code input there and the draft is stranded.

### The tether: one function, so a door cannot be added without a nonce

Three doors means three chances to forget the cookie, and a fourth whenever
someone adds an entry point. "Remember to call `ensureOriginNonce` in each
route" is precisely the untethered membership claim CLAUDE.md forbids.

Instead, **collapse mint → bind → build URL → send into a single exported
function**, `deliverSignInLink`. The three doors call that one function and pass
the request/response so it can read and set the nonce. `sendMagicLinkEmail`'s
second parameter is narrowed to `BoundSignInLink`, a branded string only
`deliverSignInLink` constructs — a plain string will not typecheck at the send
call, so a new door cannot accidentally assemble an unbound link the way the
three existing ones used to. This is weaker than export removal: an explicit
`as BoundSignInLink` cast still typechecks anywhere, so the guarantee is against
accidental misuse, not deliberate bypass. `sendMagicLinkEmail` stays exported
from `@/lib/email` because its own test suite mocks it directly.

That is a compiler tether in the sense CLAUDE.md means: the invariant is held by
the shape of the code, not by a comment asking future contributors to remember.

### Deliberately no polling

The waiting page does **not** poll for "the link was opened elsewhere". The code
input is present from the start, explained by copy (§7).

This was considered and dropped. Polling would buy only the reveal animation,
and would cost: a new unauthenticated `GET` endpoint to rate-limit on a 2GB VPS
(CLAUDE.md's Key Constraints), a client pattern that does not exist anywhere in
this repo today (`grep -rn "setInterval" src/components/ src/app/ --include="*.tsx"`
returns nothing), and a dependency on a phone tab surviving being backgrounded —
which is exactly what happens when the user puts the phone down to go to the
laptop. Without the poll, the page is a plain form and the handoff state lives
entirely in Postgres; the user carries the state, and a human is the one
transport that cannot drop the connection.

---

## 3. Where the handoff logic lives — and the signup path it must not break

`verifyMagicLinkToken` has **two production callers**, not one:

```bash
grep -rn "verifyMagicLinkToken(" src/ --include="*.ts" | grep -v "export async function"
```

- `src/app/api/auth/magic-link/verify/route.ts:19` — the flow being changed.
- `src/lib/auth/signup-ticket.ts:52` — `consumeSignupTicket`, redeeming the
  `teacher_profile_pending` ticket from a **form on the device that already
  holds the ticket cookie**.

The second must not acquire handoff behaviour. A signup ticket is redeemed by
the device that was just handed it; there is no second device, and a code prompt
there would be nonsense. This is the sharpest trap in the change: teaching
`verifyMagicLinkToken` about browser nonces breaks teacher signup silently,
because that caller passes none and would land in the handoff branch on every
redemption.

**Therefore:** `verifyMagicLinkToken` stays the pure consume primitive, with its
current signature and behaviour. The handoff decision is a new, separate
function that runs *before* it and either defers to it (same browser) or returns
a handoff result (different browser). `consumeSignupTicket` is untouched.

---

## 4. Schema

`MagicLinkToken` (`prisma/schema.prisma:1015-1023`) gains three nullable
columns; no backfill, since a null nonce simply means "minted before this
change" — treated as invalid outright rather than triggering a handoff, since
there is no browser for a code to hand off to.

| Column | Purpose |
|---|---|
| `originBrowserHash String?` | `sha256` of the requesting browser's nonce cookie. Null for tokens minted by paths with no browser (signup tickets). |
| `handoffCode String?` | The 6-digit code, stamped when the link is opened without a matching nonce. Null until then. |
| `handoffAttempts Int @default(0)` | Attempt budget for the claim endpoint (§6). |

Migration per the project rule — `npx prisma migrate dev`, never `db push`, and
once applied it is immutable including comments (CLAUDE.md, *Comment
Discipline*).

**On the code being plaintext, not hashed.** Every other sensitive value in
this table is hashed; this one deliberately isn't. §6 requires the same code be
redisplayed verbatim on every repeated open of the link — a fresh HTTP request
each time, with no server memory of the first response. A one-way hash cannot
be reversed to redisplay the digits, so hashing this column would make that
requirement unsatisfiable. No security is lost: a 6-digit space is 10⁶,
trivially invertible even if hashed, and **the code is not a credential on its
own** — the credential is the pair (browser nonce ∧ code), and it is the
nonce, 32 random bytes hashed, that carries the security. No comment in the
code may claim the code provides confidentiality on its own.

---

## 5. The enumeration hazard: the nonce cookie must be set unconditionally

`POST /send` returns 200 whether or not the address exists, and mints a token
only when a `Teacher` or `Student` row is found
(`send/route.ts:44-52`). The comment at `:51` names enumeration as the reason.

**If the nonce cookie were set only when a token was minted, its presence in the
response would restore exactly the enumeration oracle that response body was
shaped to prevent.** An attacker POSTs an address and reads `Set-Cookie`.

So: the nonce is established for **every** accepted request, before the user
lookup, independent of whether a token follows. It is a browser identifier, not
a token artefact. When a token *is* minted it records `sha256(nonce)`; when none
is, nothing references the nonce and it is inert.

This is the same defect class as #187, which had just removed an enumeration
oracle from `POST /api/auth/passkey/authenticate/options` by deleting its input.
Re-introducing one three files away would be a poor trade.

**The nonce is per-browser, not per-request.** It is reused if already present,
so two links requested from the same browser are both same-device there. It is
rotated on successful sign-in.

**The constraint binds equally on all three doors** (§2), and an earlier draft
of this section got that wrong — it claimed `/teacher-signup` "deliberately
answers `ALREADY_TEACHER`" and so had nothing to leak. It does not. That error
code belongs to the *profile submission*, not to this door. Read the route:

- `teacher-signup/route.ts:46-47` returns a uniform 200 with the comment
  *"Uniform 200 whatever the address turned out to be — same non-enumeration
  contract as `student-signup`."*
- It goes further than `/send` does: at `:34-35` it silently downgrades
  `purpose` from `teacher_signup` to `sign_in` when an account already exists,
  precisely so the *email* does not reveal the answer either.
- `student-signup/route.ts:109` ends the same way.

So all three doors are non-enumerating by construction, and a cookie set only on
the has-an-account branch would puncture all three rather than one. The rule is
uniform because the posture is uniform — and §2's tether is what keeps it from
becoming a per-door judgement the next contributor has to re-make correctly.

---

## 6. Rate limiting and the attempt budget

- `POST /api/auth/magic-link/claim` is a new unauthenticated endpoint and gets a
  per-IP limit from `src/lib/rate-limit.ts`, in its own partition, following the
  two existing partitions `magic-link:ip` and `magic-link:email`
  (`rate-limit.ts:49-50`).
- Per-token attempt budget: `handoffAttempts` increments on each wrong code, and
  the token is deleted once the budget is spent. A 6-digit code is 10⁶, so an
  unbounded endpoint is brute-forceable in the token's 15-minute life even
  though the attacker also needs the nonce. Defence in depth: the budget is the
  guard that does not depend on the nonce being secret.
- **Opening the link repeatedly must not churn the code.** The code is generated
  once and reused for the life of the token, so an attacker holding the link
  cannot invalidate a code the legitimate user is mid-way through typing.
- **The handoff branch must not poison the same-device path.** An attacker
  opening the link (stamping a code) must leave a subsequent same-browser open
  by the real user still able to sign in directly. Handoff state is additive,
  never a mode the token cannot leave.

---

## 7. Copy

The email carries a **link, not a code** — the code only exists once the link is
opened somewhere else. A bare code box would send people hunting through the
email for a number that is not there, so the copy states the condition:

> **Check your email**
> We sent a link to `<address>`. Open it here and you're straight in.
>
> *Opened it somewhere else? Wherever you opened it will show you a code —
> enter it here.*

Always visible rather than behind a disclosure toggle: one explanatory line is
calmer than a widget that hides things, and it keeps the page a pure form with
no state.

**This panel is shared, not duplicated four times.** All four waiting panels
(§2, *The full surface*) render the same code-entry component, so the copy and
the claim call cannot drift between the sign-in and signup halves — a real risk
here, since `booking-sign-in.tsx:20-21` records that it and `signup-form.tsx`
were already written as deliberate copies of one another's shape. Each panel
keeps its own surrounding sentence (the booking one says the link "brings you
straight back here", `booking-sign-in.tsx:51`); only the code block is shared.

The `profile-setup-form.tsx` `expired` panel carries one extra line, because its
stakes are different: the draft is preserved, and the user needs to know that
before they decide whether to abandon the tab.

**The word "device" is avoided in load-bearing copy.** Gmail and Outlook on iOS
open links in an in-app webview with its own cookie jar, so a genuinely
same-phone tap can legitimately land in the handoff branch. Copy that asserts
"a different device" would be false for those users. Framing on the code —
"enter this where you started" — is true either way.

On the code-display page: the code, an instruction to enter it where the request
started, and **"Sign in here instead"**, which restarts the flow on the current
device. That link is also the escape hatch for the in-app-webview case and for
"the original tab is gone".

`verify/page.tsx:85-87` and `:180` (§1.3) are rewritten to describe the check
that now actually happens. Per CLAUDE.md's *Comment Discipline*, the correction
is a **replacement**, not an annotation — no "this previously said". The
before-and-after belongs in the PR body.

---

## 8. Development environment and the test surface

Raised by Ivo: in dev the link is printed to the server log.

`src/lib/email.ts:27-42` — when `emailDryRun()`, `sendMagicLinkEmail` logs
`[DEV] Magic link for <to>: <url>` to stdout (`:39`), and throws instead in
production unless `EMAIL_DRY_RUN=1` (`:36-38`).

**The manual dev loop survives unchanged**, and this is worth stating plainly
because it is the non-obvious part: the developer submits the form *in their
browser*, which establishes the nonce cookie there; they then paste the logged
link into that same browser, which is same-device, and sign in directly. The log
output does not change — printing a code there would be wrong, since no code
exists until the link is opened without a nonce.

It also gets *better*: opening the logged link in a private window is now a
one-step way to exercise the handoff path locally. That recipe belongs in the
`verify` skill.

**What does break is the automated surface, because tests mint tokens
out-of-band.** Measured:

```bash
grep -rn "verify?token=" tests/e2e/ | wc -l          # → 10
grep -rln "verify?token=" tests/e2e/                 # → 3 files
grep -rn "magic-link/verify" tests/ | sed 's/:.*//' | sort | uniq -c
grep -rn "verifyMagicLinkToken(" src/ tests/ --include="*.ts" | grep -v "export async function"
```

- **e2e:** 10 `/verify?token=` navigations across 3 spec files
  (`auth.spec.ts` 8, plus `booking.spec.ts` and `teacher-signup.spec.ts`). Of
  `auth.spec.ts`'s 8, one is the literal `invalid-token-abc123` at `:97`, so
  8 − 1 = **7 carry a real minted token**. They are minted by
  `createMagicLinkToken` (`auth.spec.ts:13-24`), which writes a row through
  Prisma with no browser involved — so the Playwright context holds **no nonce**
  and every one of them would land in the handoff branch.
- **Integration over HTTP:** 5 POSTs to the verify route across 2 files
  (`signup-api.test.ts` 2, `teacher-signup-api.test.ts` 3).
- **Direct service calls:** 17 `verifyMagicLinkToken(` call sites =
  2 production (§3) + 15 in tests (`magic-link.test.ts` 11,
  `tests/integration/auth.test.ts` 4). These are unaffected, because §3 keeps
  that function's signature and behaviour.

**Resolution: the test helpers mint "a token *and* its originating browser",
and set the nonce cookie on the context.** No bypass flag. An
environment-variable auth bypass is precisely the shape that leaks to
production, and `email.ts:36-38` shows this codebase already paying attention to
that risk; adding a second, more dangerous one to make tests convenient is not a
trade worth making. The existing tests keep asserting same-device behaviour, and
the handoff path gets its own coverage with two browser contexts.

---

## 9. Tests, and the mutation that proves each guard bites

Every guard below is proven by breaking it, recording the exact failure text,
restoring, and re-verifying — an explicit step per guard, per CLAUDE.md and the
`solve-issue` skill. A pin that compiles but cannot fail certifies nothing.

| Guard | Test | Mutation that must turn it red |
|---|---|---|
| Same browser signs in directly | e2e: request via the form, open the link in the same context | Force the nonce comparison to always mismatch → expect the code screen instead of `/schedule` |
| Different browser gets a code and **consumes nothing** | e2e, two contexts | Make the handoff branch fall through to consume → the second context's claim fails, and the row is gone |
| The code signs in the **requesting** browser | e2e, two contexts | Create the session on the opening context instead → the waiting context stays signed out |
| Defect B: a cookie-less open leaves the token spendable | integration: open without a nonce, then claim successfully | Restore the unconditional `useEffect` consume → claim returns "invalid or expired" |
| §5: the nonce cookie is set for an address with no account | integration: POST `/send` for an unknown address, assert `Set-Cookie` | Move the cookie write inside `if (user)` → the response for an unknown address has no cookie, and the enumeration test goes red |
| Attempt budget | integration: exhaust the budget, assert the token is dead | Remove the increment → the loop never terminates |
| Code is stable across repeated opens | integration: open twice, assert one code | Regenerate per open → the first code stops working |
| Handoff does not poison same-device | integration: open cookie-less, then open with the nonce | Treat a stamped code as a terminal state → the legitimate same-device open fails |
| §3: signup ticket redemption is unaffected | existing `teacher-signup-api.test.ts` passes unedited | Route `consumeSignupTicket` through the handoff function → those tests go red |
| **All three doors bind a nonce** | Integration, one case per door: POST each of `/send`, `/teacher-signup`, `/student-signup` and assert `Set-Cookie` carries `fair_yoga_origin` | Remove the binding from **any one** door → exactly that door's case goes red |
| **The tether holds** | A door cannot email a link without binding | Add a fourth call site that calls `sendMagicLinkEmail` with a plain string → it must not typecheck, because the parameter type is `BoundSignInLink`, not `string` (an explicit `as BoundSignInLink` cast bypasses this, which is the tether's known limit — see §2) |

The last three rows are the cross-task guards. The `consumeSignupTicket` row
catches the §3 trap and must pass **without editing that test file**. The
three-door row must fail *per door* rather than in aggregate — a single test
asserting "some door binds a nonce" would pass with two doors broken, which is
the failure this project keeps hitting (`solve-issue` §4: a finding naming N
locations gets N verdicts, not one).

**Coverage matrix — the four combinations must each have an end-to-end case**,
since the whole question at the review gate was whether signup and sign-in, for
both roles, were actually covered:

| | Sign-in | Signup |
|---|---|---|
| **Teacher** | `/login` → same-device, and handoff | `/signup` → handoff, landing on the requesting device |
| **Student** | `/login` and the booking page's returning mode | Booking page's new mode → handoff, preserving the `redirect` to the class |

The student-signup case must assert the class `redirect` survives the handoff —
that is the one path where the token's `redirectTo` and a second device
interact, and losing it would drop a student on `/bookings` instead of the class
they were trying to book.

**Verification note for this branch.** This work happens in a git worktree,
where integration and e2e cannot run locally — both are hard-wired to the dev
server on `:3000` and the shared dev database. `npm run verify` is scoped to
typecheck, lint, unit and components; CI is the signal for the integration and
e2e tiers, and the PR body cites the CI run rather than a local `verify` for
those.

---

## 10. Where each claim lives

Per CLAUDE.md's *Comment Discipline*: a comment annotates the code it sits on;
anything wider goes in `docs/` and the comment links to it.

| Claim | Home |
|---|---|
| The census of test call sites (§8) | This spec and the PR body — it is a count, and it ships with the command that re-derives it. Never a docblock |
| Why the nonce cookie is unconditional (§5) | A comment **on the cookie write**, where the tempting edit ("only set it when we mint a token") would be made. It annotates its own line |
| "There are three doors" (§2) | This spec and the PR body, with a `deliverSignInLink(` call-site grep that re-derives it — `sendMagicLinkEmail` itself now greps to exactly one caller, its own tether point. **Never a docblock** — a fourth door would be added in another file, so the comment's owner would never see it falsified. The durable form of this claim is the tether: `sendMagicLinkEmail`'s parameter type, not prose |
| Why `consumeSignupTicket` is not routed through the handoff (§3) | The test in §9's last row is the durable tether; a one-line comment on the handoff function states the constraint |
| What the plaintext code does and does not buy (§4) | A comment on the column's use, phrased as the pair (nonce ∧ code) being the credential. No confidentiality claim for the code alone, hashed or not |
| The mailbox-compromise ceiling (§1.5) | This spec and the #214 closing comment. Not a code comment — it is a claim about the whole flow, with no single owning line |
| `MAGIC_LINK_SECRET` is dead; nothing is signed (§1.6) | Fixed at source: removed from `README.md` and `docs/technical-architecture.md`, and `:326-333` corrected to describe a random token with a stored hash |

---

## 11. Non-goals

- **Mailbox compromise** (§1.5). Not closeable at this layer; passkeys already
  exist for it.
- **The sibling purge deleting signup tickets** (§1.1). Real, out of scope, and
  filed separately rather than folded in — it is a leaf with its own decision
  (should a sign-in link cancel an in-flight signup?), not work this branch
  implies.
- **Passkeys.** Untouched. Note for whoever reads this next: since #187,
  `POST /api/auth/passkey/authenticate/options` reads nothing but the IP, so the
  passkey path cannot be scoped to an address and therefore cannot serve as a
  "confirm it's you" step keyed on the address that requested a magic link.
- **Rate-limit redesign.** The claim endpoint joins the existing partition
  scheme; it does not reform it.
- **#196 is unaffected** — its idempotency question about a second
  `POST /api/auth/magic-link/send` is orthogonal, and the per-browser nonce does
  not answer it.
