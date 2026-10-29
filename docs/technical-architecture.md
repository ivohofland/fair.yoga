# Technical Architecture — Ethical Yoga App

## Stack

| Layer | Choice | Why |
|---|---|---|
| Framework | Next.js 16 (App Router) | Single process handles SSR for public pages, SPA for teacher dashboard, and API routes. Low VPS footprint. |
| Language | TypeScript (strict mode) | `strict: true` in tsconfig. No `any`, no implicit types. Catches bugs at compile time, makes volunteer contributions safer. |
| Database | PostgreSQL | Relational model fits the data perfectly (see data-model.md). Mature, free, low resource usage. |
| ORM | Prisma | Type-safe queries generated from schema. Strict TypeScript integration. Easy for volunteers to understand. |
| Auth | Custom (magic link + passkeys) | Magic links via email. WebAuthn/passkeys for returning users. No passwords, no SMS (cost). Tokens are `crypto.randomBytes`, hashed with `@oslojs/crypto` before storage — nothing is signed. `@simplewebauthn/server` handles passkey verification. |
| Email | Lettermint (HTTP API, EU-hosted) | Transactional email for magic links, invitations, payment reminders, class reminders, notification fallback. The provider sits behind `sendEmail` (`src/lib/email.ts`); only `src/lib/email-lettermint.ts` talks to it. |
| Payments | Mollie (EU) / Stripe (US) | Level 1 doesn't need these (manual tracking). Level 2 uses the Mollie Payments API with one method per payment — no card-on-file, no subscriptions. |
| Styling | Tailwind CSS | Utility-first, matches the warm minimalist design brief. No custom CSS files to maintain. |
| Testing | Vitest + Playwright | Vitest for the projects in `vitest.config.ts`, Playwright for e2e. Test-first development — tests are written before implementation. The database-backed unit tiers run against a dedicated `ethical_yoga_test` database, auto-provisioned via `DATABASE_URL_TEST` (see `docs/test-database.md`). |
| Deployment | Single VPS (Docker) | One container running Next.js. PostgreSQL alongside or managed. Nginx reverse proxy. SSL via Let's Encrypt. |

## Development Approach

**Test-first development.** Every feature starts with a failing test. The cycle is: write test → see it fail → implement → see it pass → refactor. This applies at all levels — unit tests for the pricing engine, integration tests for API routes, e2e tests for critical user flows. No PR is merged without passing tests covering the change.

**TypeScript strict mode.** The tsconfig enforces `strict: true`, which enables `noImplicitAny`, `strictNullChecks`, `strictFunctionTypes`, and all other strict flags. This is non-negotiable. For an open-source project with volunteer contributors, the compiler is the first line of defense against bugs.

### Testing conventions

**Shared fixtures.** `tests/helpers.ts` owns the *mechanical* layer most test files used to hand-roll: `BASE_URL`, `hashToken`, `cookie(token)`, `sessionCookie(token)`, `uniqueSuffix()`, `freshIp()`, and `seedSession(db, accountId)`. `freshIp()` returns an `{ 'x-forwarded-for': '10.a.b.c' }` header object that is unique per call, so every request to an IP-rate-limited route lands in a bucket nothing else has touched — that is what makes the integration suite re-runnable within the hour. It's shared by both the vitest integration suite (`tests/integration/*.test.ts`) and the Playwright e2e suite (`tests/e2e/*.spec.ts`): the module imports nothing from vitest and takes `PrismaClient` as a parameter, so it's usable from Playwright as-is. `cookie()` returns a header object for the integration suite's raw `fetch` calls; `sessionCookie()` is its Playwright-shaped counterpart, for `context.addCookies([...])`. Semantic fixtures — which class is open, which payment is pending, what a teacher's rates are — stay in each test file so a test's setup is readable where it is used. There is deliberately no `makeTeacherWithSession`-style wrapper: `classes-api.test.ts` and `payments-api.test.ts` each keep their own local `makeTeacher(tag)` rather than share one, and the two differ in `firstName`, `bio`, and the email/slug prefix — a shared version would need those as parameters, and the interesting values would vanish behind a helper call for every future caller. A test needing a non-standard session (an already-expired one, say) creates it inline instead of bending the helper: `auth.test.ts`'s expired-session test calls the production `createSession`, then `prisma.session.update`s the row's `expiresAt` into the past.

**Fixture suffixes.** A file that matches its own rows by substring — a `contains`, `startsWith` or `endsWith` on an email, slug or address — keys that match on `uniqueSuffix()` (or an equivalent random part), never on a bare `Date.now()`. Test files load concurrently in the `unit` tier (`fileParallelism: true`), in CI's integration step (`--file-parallelism`) and across Playwright workers, and two files loading in the same millisecond draw the same `Date.now()`: each file's substring then matches the other's rows. In #705 that made a read return seven rows instead of four and a cleanup `deleteMany` fail on `Teacher_accountId_fkey`, because it reached a sibling file's account. `uniqueSuffix()`'s random part leaves only a 1-in-2²⁴ tie within one millisecond. Where a file holds the exact addresses or ids it created, matching them with `in: [...]` is stronger: that cannot reach another file's rows whatever the suffix.

Census (2026-09-29, #705). The files matching fixture rows by substring — 35 at the time; #705's fix itself moved `src/lib/auth/account.test.ts` and `tests/scoped-sweep.test.ts` out of this list, to exact matches, and moved `src/lib/auth/profile-authorization.test.ts`'s `pa-${Date.now()}` key to `uniqueSuffix()`:

    grep -rlE '(contains|startsWith|endsWith)\s*:' --include='*.test.ts' --include='*.spec.ts' --include='*fixtures.ts' src tests

The time-derived values among them with no random part on the same line — candidates, read by hand, since most hits are clock arithmetic (`expiresAt`, deadlines) rather than identities:

    grep -nE 'Date\.now\(\)|getTime\(\)|performance\.now\(\)' $(grep -rlE '(contains|startsWith|endsWith)\s*:' --include='*.test.ts' --include='*.spec.ts' --include='*fixtures.ts' src tests) | grep -v randomBytes

After #705 its identity hits sit only in `src/lib/auth/magic-link.test.ts`, which keys no substring match on them: its scopes and assertions match each address exactly, and its `afterEach` delete matches only literals (`endsWith: '@example.com'`, its cleanup prefix). That delete would reach any concurrent file's `@example.com` rows; none can run beside it, because the file is in `SWEEP_TESTS` and that tier runs serially, after the parallel one.

Neither command sees a substring key that is literal-only. The quoted-literal ones are listed by

    grep -rnE "(contains|startsWith|endsWith)\s*:\s*'" --include='*.test.ts' --include='*.spec.ts' --include='*fixtures.ts' src tests

and at the time printed three lines: `magic-link.test.ts`'s two (above), and `src/app/api/registrations/route.test.ts`'s `endsWith: '@test.local'`, which is ANDed with a `startsWith` on a `uniqueSuffix()`-bearing tag in the same filter. A literal held in a named constant (magic-link's cleanup prefix) shows up only beside a quoted one, so read the hits' files, not just the lines.

**What earns an HTTP guard test.** `requireTeacher`/`requireSession` are the same code on ~40 routes, so a 401/403 ladder per route re-tests one helper forty times. Test the shared guard helpers **once** — that coverage lives in `src/lib/api-utils.test.ts` (401 paths for `requireSession`, 403 + happy paths for `requireTeacher`/`requireStudent`, and `withErrorHandler`'s logging and status classification); a route earns its own HTTP guard test only when its authorization is **bespoke** (its own ownership chain or state guard) or when it carries a **business invariant**. Several route tests keep a ride-along 401 case alongside their bespoke ones, which is fine — what the rule forbids is a full 401/403 ladder on a route whose only guard is the shared one.

**What earns a component test.** The `components` Vitest project (jsdom, `src/components/**/*.test.tsx`, mocking `fetch` and `next/navigation` — no database) exists for wiring a pure function cannot reach: a URL assembled inline beside the label it must agree with, an element that only appears once rendered, a branch that only shows up in the DOM. A component earns a file for that reason and no other. A component whose logic already lives in a tested pure function, or which renders without branching, does not need one — an empty jsdom project is not an invitation to backfill coverage that already exists elsewhere.

**Asserting no alert in e2e.** Next's App Router mounts a visually hidden `#__next-route-announcer__` with `role="alert"` on every page, so a bare `page.getByRole('alert')` never counts zero. Exclude it by id — `page.locator('[role="alert"]:not(#__next-route-announcer__)')` — rather than scoping the query to a parent element: if Next renames the id, the query starts matching the announcer and the assertion fails loudly, where a structural scope fails silently once the markup moves. An empty live region counts too: the class page's attendance list keeps a `role="alert"` mounted and empty until it has something to announce, so on a page that may hold one add `:not(:empty)` to the locator.

**Rate-limited auth routes.** `POST /api/auth/teacher-signup` (IP-keyed, 5/hour, plus a per-email bucket at 3/15 min) and `POST /api/auth/student-signup` (IP-keyed 5/hour, plus an unconditional per-email bucket at 3/15 min) are covered at the HTTP layer, in `teacher-signup-api.test.ts` and `signup-api.test.ts` respectively. Repeated local runs used to exhaust those limiters, which made those files the first to fail on a re-run within the same hour; every such call now carries its own `freshIp()` address, so the IP buckets no longer accumulate across runs. `student-signup`'s per-IP budget test — its only IP-limiter coverage — deliberately reuses an address instead, burning one throwaway bucket to 6. `teacher-signup` also has a dedicated test that omits `x-forwarded-for` and `x-real-ip` entirely, proving its IP check degrades to a shared bucket rather than skipping — see this doc's "Rate limiting" section (under Deployment) for that behavior. `GET /api/teachers/slug-available` — the signup form's live page-address check — is IP-keyed too (60/hour, high enough that normal typing never trips it) and is covered in the same file, for its own availability answer rather than its limiter. `POST /api/auth/magic-link/send` is covered too, in `auth-email-case.test.ts`'s IP-short-circuit test: it deliberately spends both the IP bucket (10 hits from one throwaway address) and, in the same run, the target email's 3/15min bucket, so this route no longer needs a wait-or-trip tradeoff. We do not add a test-mode bypass to production code for test convenience. `POST /api/auth/passkey/authenticate/options` is IP-keyed too (100/hour), covered in `passkey-api.test.ts`. With #187 that route reads nothing from the request body, so there is no address to enumerate and no per-email bucket to pair with the IP one; the budget is there to bound challenge-store churn, since a flood can otherwise evict other callers' in-flight challenges before they are redeemed. `POST /api/payout-pause` — a payout-change email's "This wasn't me" link, which needs no session — is IP-keyed too (20 per 15 minutes), its limiter covered in `payout-pause-api.test.ts`. `/api/unsubscribe` — an email's one-click unsubscribe link, which needs no session either — is IP-keyed too (60 per 15 minutes). `POST /api/passkey-revoke` — the passkey-added email's "This wasn't me" link, which needs no session either — is IP-keyed too (20 per 15 minutes), its limiter covered in `passkey-revoke-api.test.ts`.

---

## Project Structure

```
ethical-yoga/
├── prisma/
│   ├── schema.prisma          # Data model (source of truth)
│   ├── migrations/            # Database migrations
│   └── seed.ts                # Development seed data
├── src/
│   ├── app/                   # Next.js App Router
│   │   ├── (public)/          # Public routes (no auth required)
│   │   │   ├── [slug]/        # Teacher's public booking page (SSR)
│   │   │   ├── login/         # Magic link + passkey login
│   │   │   └── verify/        # Magic link verification
│   │   ├── (teacher)/         # Teacher dashboard (auth required)
│   │   │   ├── schedule/      # Schedule tab (home)
│   │   │   ├── students/      # Students tab (CRM)
│   │   │   ├── inbox/         # Inbox tab (notifications)
│   │   │   ├── settings/      # Settings tab
│   │   │   └── class/[id]/    # Class detail (adaptive screen)
│   │   ├── (student)/         # Student views (auth required)
│   │   │   ├── bookings/      # My upcoming classes
│   │   │   └── settings/      # Privacy & preferences
│   │   └── api/               # API routes
│   │       ├── auth/          # Magic link & passkey endpoints
│   │       ├── classes/       # Class CRUD & lifecycle
│   │       ├── registrations/ # Booking, cancellation, walk-ins
│   │       ├── payments/      # Payment tracking & webhooks
│   │       ├── notifications/ # Notification endpoints
│   │       └── webhooks/      # Mollie/Stripe callbacks
│   ├── services/              # Business logic (framework-agnostic)
│   │   ├── pricing.ts         # The pricing engine
│   │   ├── pricing.test.ts    # Pricing engine tests
│   │   ├── class-lifecycle.ts # Class state machine
│   │   ├── class-lifecycle.test.ts
│   │   ├── waitlist.ts        # Hybrid waitlist promotion
│   │   ├── waitlist.test.ts
│   │   ├── notifications.ts   # Notification row writer + SSE emit
│   │   ├── notifications.test.ts
│   │   ├── push-dispatch.ts   # Web push sweep — see Web Push below
│   │   ├── push-dispatch.test.ts
│   │   ├── payments.ts        # Payment creation & tracking
│   │   ├── payments.test.ts
│   │   └── class-generator.ts # Class family's half — see Entry Generator below
│   ├── lib/                   # Shared utilities
│   │   ├── auth.ts            # Session management, magic link tokens
│   │   ├── db.ts              # Prisma client singleton, built by prisma-client.ts
│   │   ├── prisma-client.ts   # createPrismaClient; re-exports the generated client
│   │   ├── prisma-enums.ts    # the generated enums alone, for client-reachable code
│   │   ├── email.ts           # sendEmail seam
│   │   ├── email-lettermint.ts # the provider adapter
│   │   └── types.ts           # Shared TypeScript types
│   └── components/            # React components
│       ├── ui/                # Base components (buttons, cards, inputs)
│       ├── schedule/          # Schedule-specific components
│       ├── class/             # Class detail components
│       ├── students/          # Student CRM components
│       └── layout/            # Navigation, tabs, modals
├── tests/
│   ├── e2e/                   # Playwright end-to-end tests
│   │   ├── teacher-onboarding.spec.ts
│   │   ├── class-booking.spec.ts
│   │   ├── payment-flow.spec.ts
│   │   └── waitlist.spec.ts
│   └── integration/           # API route integration tests
│       ├── classes.test.ts
│       ├── registrations.test.ts
│       └── payments.test.ts
├── tsconfig.json              # strict: true
├── vitest.config.ts
├── playwright.config.ts
├── docker-compose.yml         # Dev: Next.js + PostgreSQL
├── Dockerfile                 # Production build
└── .github/
    └── workflows/
        └── ci.yml             # Run tests on every PR
```

---

## The Services Layer

The `src/services/` folder is the heart of the application. These are pure TypeScript functions with no framework dependency — they take typed inputs and return typed outputs. API routes are thin wrappers that handle HTTP concerns (parsing request, checking auth, returning response) and delegate to services.

This separation means services are independently testable (no HTTP mocking needed) and could be extracted to a standalone API later if mobile apps require it.

### Work that must not be awaited

A few service functions must never sit on a request's critical path — their
duration or failure would leak something the response is meant to withhold.
`deliverInvitation` (`services/invitations.ts`) is the case that named the
rule: awaited, it turns an email-provider outage into a 500 for an
unregistered address while a registered one still answers normally, which is
the account-enumeration oracle #166 closed.

These functions return `FireAndForget` (`src/lib/fire-and-forget.ts`), an
alias for `void`. Returning no promise is what enforces the contract —
`.then()` and `.catch()` on the result are compile errors, so a caller cannot
couple its response to the work even without knowing why they shouldn't.
A bare `await` on one is legal and inert: it yields a microtask and nothing
else.

**Writing a new one:** return `FireAndForget`, start the work in a
`void (async () => { … })().catch(…)`, and handle the rejection inside — there
is no promise left for a caller to attach a handler to, so an unhandled
rejection is the default if the function does not own its own. Take whatever
context the log line needs (an id, which caller) as parameters. Nothing may
precede the IIFE: a statement placed before it throws synchronously into the
caller, escaping the `.catch` entirely.

`grep -rn '): FireAndForget' src/` lists every function under this rule.

### Process-wide state

A server module is not evaluated once per process. A production build
evaluates it once per bundle layer it is reached from (instrumentation, which
runs the scheduler; the route handlers; the server-rendered pages), and
`next dev` evaluates it again after an edit. A module-level `new Map()` is
therefore several maps. #933 was the dev form: after one edit,
`register/options` wrote a passkey challenge that `register/verify` could not
see. #935 was the production form: the scheduler emitted notifications on an
event bus that the SSE stream did not listen on.

**The rule:** a top-level binding in a server module whose value changes after
evaluation is either process-wide or per-instance with a written reason.

**Process-wide** holders live on `globalThis`, keyed under `__fairYoga…`, with
the key typed in `declare global`, so there is no cast and no central
registry:

```ts
declare global {
  // The scheduler (instrumentation entry) and the SSE route are separate
  // bundle entries; one emitter is what lets a scheduler notification reach a stream.
  var __fairYogaNotificationBus: EventEmitter | undefined;
}

const emitter = (globalThis.__fairYogaNotificationBus ??= (() => {
  const created = new EventEmitter();
  created.setMaxListeners(100);
  return created;
})());
```

That is `src/lib/event-bus.ts`.

The first evaluation builds the value and every later one reuses it. A
top-level `let` cannot use `??=`, so its value becomes a field of a global
state object (`state.recentFailures = …`, `notify-health.ts`). A timer
started at import starts once per process, behind a flag in its global state.
Each evaluation rebinds the function the tick calls through that state, so the
tick runs the newest code (`src/lib/auth/passkey.ts`).

**Data, not class instances.** A value on `globalThis` outlives a dev edit
with its old prototype, so an instance of a class defined in this repo would
keep its pre-edit methods until restart. A process-wide holder is a `Map`,
`Set`, array, plain object or bare `EventEmitter`, and behaviour stays in the
module's exported functions over it. In `event-bus.ts` the emitter is shared
and the functions around it are re-evaluated. The one exception is the Prisma
client in `__fairYogaPrisma`: a library client built by the repo's factory,
not an instance of a repo class, and the census does not see into factory
calls.

**Per-instance** holders stay as module-level bindings, with a leading
comment that says why a split costs nothing that matters (`src/lib/email.ts`):

```ts
// per-instance: a warn-once flag; a split copy warns once more, and nothing else changes
let warnedClassRouteUnset = false;
```

`src/lib/process-state-census.test.ts` enforces the rule. It reads every
server module's syntax tree under `src/` and fails, naming `file:line`, on a
holder that is neither. Its docblock states what it flags and lists the shapes it is
known to miss, each pinned by a fixture. The Prisma client follows the same rule (Database → Where
Prisma comes from). The measurements and the reasoning are in
`docs/superpowers/specs/2026-10-29-process-singletons-design.md`.

### Processor token cipher (`lib/processor-token-cipher.ts`)

A teacher's Mollie access and refresh tokens are sealed with AES-256-GCM before
they reach `ProcessorConnection`, in their own table so that no `Teacher` read
can carry them. `sealToken` lays the buffer out `[version][iv][tag][ciphertext]`
and authenticates the version byte; `openToken` refuses an unknown version, a
short buffer or a failed tag with `TokenCipherError`. The key is
`PROCESSOR_TOKEN_KEY`, 32 bytes as base64; `diagnoseMollieConfig`
(`src/lib/mollie/config.ts`) is the one reader and turns Mollie off, logging the
reason once, for any of its `MollieConfigProblem` reasons: none of the three
Mollie variables set (`unset`, a warning), only some of them (`partial`), a key
that does not decode to 32 bytes (`token-key-length`), or a
`NEXT_PUBLIC_APP_URL` that is missing or not an http(s) URL (`app-url`). It
drops the app URL's trailing slashes. Replacing the key makes every
stored token unreadable, so a teacher reconnects; the version byte names the
layout a later key rotation would read both of. Only server code imports the module
(`server-only`), which `pnpm run build` is what checks.

### Email (`lib/email.ts`)

One seam: `sendEmail({ to, audience, content, unsubscribe, headers?, idempotencyKey? })` never throws and answers a `SendResult`. `unsubscribe` is required: `null` for mail the recipient cannot switch off, otherwise the target whose `List-Unsubscribe` headers `sendEmail` adds (see *One-click unsubscribe*). `audience` decides Reply-To and route: `platform` mail carries `EMAIL_REPLY_TO` and uses the default route; `class` mail carries no Reply-To and uses `LETTERMINT_CLASS_ROUTE` (the default route when unset). `delivery: 'sent'` in the result means the provider accepted the message, not that it was delivered. In production, with no `LETTERMINT_API_TOKEN` and `EMAIL_DRY_RUN` not `1`, it refuses with `ok: false` rather than pretending to send. The throwing per-email wrappers sit on top of it. Design and audience table: `docs/superpowers/specs/2026-10-10-email-provider-seam-design.md`.

### One-click unsubscribe

Opt-out-able mail carries `List-Unsubscribe` and `List-Unsubscribe-Post`
headers plus a footer link. `sendEmail` builds only the headers, from the
`unsubscribe` target it is handed; each opt-out-able sender builds its own
footer link with `unsubscribeLinks(target)?.page` and passes the same target
to `sendEmail`. The link's `t` is a signed token, `<payload>.<mac>`: the
base64url of `v1.<kind>.<subject id>` and its HMAC-SHA256
(`src/lib/unsubscribe-token.ts`), keyed by `UNSUBSCRIBE_SECRET`. With the
secret unset in production, mail sends without the headers or the link and
verification refuses every token. An invitation's subject also carries a tag
of the address it was sent to, so a link at an address since edited away
declines nothing.

What each kind of link switches off is the table in
`docs/superpowers/specs/2026-10-10-list-unsubscribe-design.md` (Decision 3);
`src/services/unsubscribe.ts` is the only writer on the unsubscribe path.

- `POST /api/unsubscribe?t=<token>` with a form body `List-Unsubscribe=One-Click`
  (urlencoded or multipart) performs the opt-out. It needs no session and
  accepts a foreign Origin (see *Cross-site writes*). A change answers 200;
  a repeat answers 200 `outcome: 'unchanged'`.
- Every token that cannot act (forged, malformed, missing, unknown subject,
  erased subject, readdressed or deleted invitation) answers the same 404
  `UNSUBSCRIBE_LINK_INVALID` with the same body, so the answer says nothing
  about which accounts exist.
- `GET /api/unsubscribe?t=<token>` never mutates, because mail scanners and
  link prefetchers issue GETs. It redirects (303) to `/unsubscribe#t=<token>`;
  the app's own logs carry only the pathname, and the fragment keeps the token
  out of logs from the redirect onward (the `?t=` URL itself still reaches the
  proxy's access log on GET and POST). The page's button does the POST.
- Rotating `UNSUBSCRIBE_SECRET` invalidates every link already sent. Those
  links answer the uniform 404, whose copy points to Settings.

### Error responses

A refusal is `respondError(message, status, code)` for a single literal code
known at the call site, or `respondRefusal(refusal)` for one read whole off a
`Record<Reason, CodedRefusal>` map — splitting such a refusal into separate
`status`/`code` arguments stops compiling once its reasons span more than one
status, because a union-typed `code` no longer pins a single status (#649).
The code comes from
`src/lib/api-error-codes.ts`, which fixes one status per code: a 409 without
a code, or a code at another status, does not compile. A `CodedRefusal` value
is built with `codedRefusal(code, message)` from that same module, which reads
`status` out of the registry rather than letting a call site hand-type it
beside `code`. Clients branch on the code through `readError`
(`src/lib/client-errors.ts`) rather than on the
status — two refusals can share a status and mean different things. The
exceptions are the statuses `ApiErrorStatus` excludes, today 401 and 429: no
code can ever carry one, so a client that must recognise a dropped session or
a rate limit has only the status to read, and several do. A 503 is read by
status too: an app-written 503 means a retryable failure, and among them
`DATABASE_CONNECTION_FAILED` alone leaves the outcome unknown (see "Database
errors"). Tests assert
it with `expectRefusal` (`tests/api-assertions.ts`), never the message, so
copy can change without touching a test.

**The one exception is comparing a message against its own exported
constant, never a literal — and only where several doors share one code and
the sentence is the only thing that says which door answered.**
`src/app/api/invitations/[id]/shared.ts`'s `DECLINED(door)` is the worked
example: `edit`, `remove` and `resend` all send `DECLINED_IS_PERMANENT`, so
the code cannot tell a caller which sentence was sent, and
`cas-scope.test.ts` compares the body against `DECLINED_MESSAGE.remove` (its
own exported entry), never the quoted sentence, so rewording the copy stays
free while the door-routing pin still holds. This is the only reason to write
a NEW server-side assertion that reads `error.message` (spec §8.3). Older
assertions predate the rule and still read messages directly — enumerate them
with

```bash
grep -rnE "error\.message\)\.(toBe|toContain)\('" tests/integration src/app/api
```

— so finding one is not a licence to add another. Without this written down, whoever next
meets a mutation that leaves a test green cannot tell "nothing caught this"
from "nothing was ever meant to" — the question #197's own PR (`8e22db04`)
had to answer the hard way, by re-deriving the acceptance criterion from the
issue itself after a first pass pinned prose at five sites that did not need it.

A client `catch` binds its error, and a failed request logs through
`logRequestFailure` (`src/lib/client-errors.ts`). Its `context` carries
ids, flags and enum-like values — never an email, a name, a sign-in code or anything else the
user typed, which the type cannot tell from an ID. `err` itself can quote the
start of a response body, which matters if a client error sink is ever plugged
in. `src/components` and `src/app` refuse a bare `catch` and a parameterless
`.catch` handler (or one whose parameter is `_`-named) by lint
(`bareCatchSelector` and `discardedRejectionSelector` in `eslint.config.mjs`);
a catch that is correct as bare says why in its `eslint-disable-next-line`.
`src/lib` is outside the rule; its client helpers log through the same helper,
held by review rather than lint. The design is in
`docs/superpowers/specs/2026-09-29-bare-catch-logging-design.md`.

**Already done is not an error.** A request whose goal the server can prove
already holds answers `respondUnchanged(data)`: 200, `{ data, outcome:
'unchanged' }`, no write, no side effect. "Prove" means the stored state
equals what the request asks for, including every value the request carries;
a request carrying values the stored row lacks is not a retry of the request
that made it. In a handler the check sits:

1. after authentication and ownership — before them, "unchanged versus 404"
   would answer whether something exists;
2. after refusals that make the goal moot — the class is cancelled, the
   payment is settled;
3. before every other status, window or capacity refusal, so a retry is never
   refused for a state its own first attempt created.

A delete of a row that is already gone cannot be proven a retry, so it stays
404 `NOT_FOUND`, and the component that issued the delete treats that code as
done. A create that meets its twin stays a refusal naming the conflicting
row.

**Copy.** A refusal message:

- uses the user's terms — never a model or table name, a status literal, an
  id, or a list of valid values;
- says what is true, then the next step when there is one;
- says "someone else" only when the server knows it was not this user;
- is a full sentence in sentence case with a closing period — no "Invalid…",
  "Cannot…: …" or "Must be…", and no apology;
- may vary with the action or the row it names, while its code keeps one
  meaning;
- names anything in the UI by the label the UI shows.

**Adding a code:** one registry entry at its status; the route sends it; a
test asserts it with `expectRefusal`. A reason → response map types its
values `CodedRefusal`, so each entry's status is checked against its own code.
`classifyApiError`'s fallbacks (`src/lib/api-errors.ts`) carry codes too.

### Relation loads over platform-wide sets

**The mechanism.** Prisma loads a relation (`include` / nested `select`) with
a second statement that binds the parent keys as parameters. For a
**composite** relation — one keyed on more than one column, such as
`Class.calendarEntry` — the query compiler sends one scalar `IN` list per key
column, `"id" IN ($1…) AND "kind" IN (…) AND "live" IN (…)`, so the statement
binds 3n + 1 parameters for n parents. The query compiler does not split a
composite relation load, and since Prisma 7 it refuses one past its own
ceiling: measured on 7.10.1, 16,000 parents (48,001 parameters) resolve and
21,844 (65,533, inside Postgres's wire limit of 65,535) are refused with
`P2029`, which reaches the caller as a 500. The edge between them is not a
clean line: 16,375 parents resolve, 16,377 to 16,382 dropped the connection or
stalled, and 16,383 and up are refused, so no test pins a boundary, only the
two sides. A scalar `IN` list is flat in Postgres, so the load no longer
overflows the parser's stack: 16,000 parents resolve even under a 200 kB
`max_stack_depth`. Relation **filters**
(`where: { calendarEntry: { cancelledAt: null } }`) compile to a `JOIN`, not
an `IN` list, and are unaffected.

**`in:` lists.** Prisma caps a Postgres statement at 32,766 bound parameters,
and handles a statement over the cap in one of two ways. A plain `findMany`
whose `in:` filter is the overflow — no `orderBy`, no `take` — and a
**single-key** relation load (`Class.registrations`, keyed on
`Registration.classId`) are split into statements of at most 32,765 values:
200,000 ids resolve, and a 70,000-parent single-key load runs as three
statements. Every other statement is sent whole, and one over the cap is
refused before it is sent, with `P2029` (`The query parameter limit supported
by your database is exceeded.`), which also reaches the caller as a 500.
Measured refused past the cap: `count`, `groupBy`, `updateMany`,
`deleteMany`, a `findMany` with `orderBy` or `take`, and an `in:` nested under
a relation filter. The composite relation load above is refused too, at a higher
ceiling than 32,766, and never split. So an `in:` list that grows
with the platform needs a bound whatever operation carries it, and
`readInSlices` (`src/lib/read-in-pages.ts`) hands the list over
`SWEEP_PAGE_SIZE` keys at a time.

Re-deriving the numbers: the composite limit is the `bind-parameter limit`
test, which seeds 21,844 classes by `generate_series` and loads 16,000 and
21,844 of them unpaged (about 4 s of seed and loads on a dev machine):

```bash
pnpm exec vitest run --project unit-sweeps src/services/sweep-page-ceiling.test.ts -t "bind-parameter limit"
```

The `in:` behaviour, from the repo root (`pnpm exec tsx split.ts 32765 32766 200000`
with this as `split.ts`; it prints the parameter count of every statement, or
the refusal). The plain `findMany` splits; add `orderBy: { id: 'asc' }` to it,
or swap it for `db.class.count({ where: { id: { in: ids } } })`, and every size
past the cap answers `P2029`:

```ts
import 'dotenv/config';
import { createPrismaClient, type Prisma } from '@/lib/prisma-client';

const db = createPrismaClient({ log: [{ emit: 'event', level: 'query' }] });
const counts: number[] = [];
(db as unknown as { $on(e: 'query', cb: (e: Prisma.QueryEvent) => void): void }).$on('query', (e) => {
  counts.push((JSON.parse(e.params) as unknown[]).length);
});
void (async () => {
  for (const n of process.argv.slice(2).map(Number)) {
    counts.length = 0;
    const ids = Array.from({ length: n }, (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`);
    try {
      await db.class.findMany({ where: { id: { in: ids } } });
      console.log(n, counts);
    } catch (e) {
      console.log(n, (e as { code?: unknown }).code);
    }
  }
  await db.$disconnect();
})();
```

**The rule.** A sweep whose parent set grows with the whole platform never
loads a relation over that set in one statement — it reads its snapshot in
keyset pages through `readInPages` (`src/lib/read-in-pages.ts`), which pages
at `SWEEP_PAGE_SIZE` (500, so a composite load binds at most 1,501
parameters) and leaves the keyset — the `where` and matching `orderBy` — to
the caller, so every site keeps Prisma's nested result type. Per-tenant reads
(a teacher's or a student's own history) are left alone: see the verdict
below.

**How the ceiling tests reproduce it.** `tests/stack-ceiling.ts`'s
`lowStackClient` builds a client whose `options` startup parameter carries
`-c max_stack_depth=200kB` (`CEILING_STACK`), so every connection its pool
opens parses under it, and it records the most parameters any one statement
on that client binds (`peakBoundParams`, read from Prisma's `query` event).
The harness asserts that a `SWEEP_PAGE_SIZE` relation load binds
3 × `SWEEP_PAGE_SIZE` + 1 parameters and an unpaged `CEILING_ROWS` (1,000)
load 3 × `CEILING_ROWS` + 1. Each per-site test then seeds a `CEILING_ROWS`
parent set and asserts that no statement the paged read sends binds more
than a page's parameters — 3 × `SWEEP_PAGE_SIZE` + 1, or 2 ×
`SWEEP_PAGE_SIZE` + 1 for `readStudioGenerationCandidates`, whose
`StudioClassTemplate.scheduleRule` key has two columns. Un-paging a site's
read sends the whole set in one statement and turns its test red on the
number, which is how each was verified. One stack test remains, for SQL the
app writes itself: a `CEILING_ROWS` row-value `IN` list through `$queryRaw`
still overflows the lowered stack (`54001`, `isStackDepthError`), and a
`SWEEP_PAGE_SIZE` one does not; `expectLowered` confirms each client really
runs under the lowered stack. A last test proves the bind limit above is
real. The per-site tests live in `src/services/sweep-page-ceiling.test.ts`.

**Per-tenant verdict.** A read bounded by one teacher's or one student's own
history is left unpaged — including the GDPR export, `/schedule/past`,
reporting, and the unfiltered `GET /api/classes` / `GET /api/studio-classes`,
among other per-tenant reads. At 6
classes a week, one teacher takes decades to reach the refusal point
above, and a student's bookings or GDPR export is
smaller again. Not a defect anyone will hit.

**Re-deriving the census.** Composite relations:

```bash
grep -n "fields: \[[^]]*,[^]]*\]" prisma/schema.prisma
```

Load sites (excluding tests — read each hit to separate a load from a
filter):

```bash
grep -rnE "\b(calendarEntry|classes|studioClasses|teacherRoom|classTemplates|studioClassTemplates|scheduleRule)\s*:\s*(\{|true)" src | grep -v '\.test\.ts'
```

Cross-tenant sites — each a background sweep whose parent set grows with the
whole platform — paged through `readInPages`:

| Function | File | Note |
|---|---|---|
| `autoCancelClasses` | `class-transitions.ts` | windowed (`cancelCandidateDates`); the page reads no registrations, the deciding count is taken per class under its row lock |
| `autoTransitionToInProgress` | `class-transitions.ts` | |
| `autoCompleteClasses` | `class-transitions.ts` | |
| `reconcileWaitlists` | `waitlist-reconciliation.ts` | `readInSlices` over the grouped candidate ids, not `readInPages` |
| `readGenerationCandidates` | `class-generator.ts` | |
| `readStudioGenerationCandidates` | `studio-class-generator.ts` | |
| `getUnreadForEmailFallback` | `notifications.ts` | keyset on `(createdAt, id)`, not `id` alone |
| `readDuePayments` | `payment-reminders.ts` | |
| `processClassReminders` | `class-reminders.ts` | windowed (`reminderCandidateDates`); a class's registrations are read per class (plus a count when the teacher's reminder is due), never as a relation load over the paged set |

**Three pitfalls the next paged read will meet:**

- TypeScript infers `T = unknown` from an inline callback passed to
  `readInPages` — pass the type argument explicitly, derived from the page
  function's own return type (`Awaited<ReturnType<typeof readXPage>>[number]`).
- Spreading a cursor into a `where` that already uses that key — an `id: { in
  }`, or a top-level `OR` — replaces the existing filter instead of narrowing
  it. Merge the cursor into the existing key, or combine both under a
  top-level `AND: [...]`.
- A keyset `orderBy` and its cursor comparison must describe the same strict
  total order. A column that is not itself unique (`createdAt`) needs a
  tie-break on `id` in both the `orderBy` and the cursor, or a page boundary
  landing inside a tie skips or repeats rows.

### Pricing Engine (`services/pricing.ts`)

The most critical piece of logic. Takes a class's economic settings and its registrations, returns the price each student pays.

```typescript
// One of five discrete income bands — not a bare number. See src/lib/tiers.ts.
type IncomeTier = 1 | 2 | 3 | 4 | 5;

interface ClassPricingInput {
  roomCost: number;
  minRate: number;
  targetRate: number;
  minStudents: number;
  maxStudents: number;
  vatPercent: number;         // added on top of room + teacher rate; 0 for none
  studentTiers: IncomeTier[]; // one tier per charged student
}

interface PricedStudent {
  tier: IncomeTier;       // the tier this student was charged at
  ratio: number;          // the tier ratio applied
  price: number;          // this student's price, after largest-remainder allocation
  vat: number;            // the VAT contained in price
}

interface PricingResult {
  effectiveTeacherRate: number;
  totalCost: number;
  studentCount: number;
  students: ReadonlyArray<PricedStudent>; // one record per charged student, same order as studentTiers
}

function calculateClassPricing(input: ClassPricingInput): PricingResult {
  // Step 1: Calculate effective teacher rate
  //   Linear interpolation between minRate and targetRate
  //   based on student count between minStudents and maxStudents

  // Step 2: Calculate total class cost
  //   (roomCost + effectiveTeacherRate) × (1 + vatPercent / 100) (teacher rate is per-class, not per-student)

  // Step 3: Distribute across tiers using compressed spread
  //   Tier ratios: [0.65, 0.80, 1.00, 1.20, 1.35]
  //   Each student's share = totalCost × (theirRatio / sumOfAllRatios)

  // Step 4: Return per-student records, each pairing a price with the tier
  //   and ratio it was computed from
}
```

This function is pure — no side effects, no database calls. It's the most tested code in the system.

### Class Lifecycle (`services/class-lifecycle.ts`)

Manages the class state machine:

```
draft → open → in_progress → completed        (+ cancelled, off to one side)
```

`full` is derived from the registration count, never stored. `cancelled` left
`ClassStatus` in issue 327: it is `CalendarEntry.cancelledAt`, so a cancelled
class keeps whatever status it held and cancellation is not a transition — see
`api/classes/[id]/cancel/route.ts`, which is its own endpoint for that reason.

```typescript
interface ClassTransition {
  from: ClassStatus;
  to: ClassStatus;
  guard: (classData: Class) => boolean;
  onTransition: (classData: Class) => Promise<void>;
}

// Key transitions:
// open → in_progress:      when the class start instant is reached
// in_progress → completed: when the teacher finishes the class (from 15 min
//                           before its end, but never before its start), or
//                           automatically 15 min after its end
// completed triggers:      pricing calculation → payment creation → notifications
//
// Not a transition: cancellation. `auto_cancel_check` firing below minStudents
// writes `cancelledAt` on the entry and leaves `status` alone.
```

### Waitlist (`services/waitlist.ts`)

Implements the hybrid promotion model:

```typescript
// More than 1h before class start: auto-promote the queue head
// Final hour before start: first-come-first-claimed broadcast
// At or after start: frozen — nothing happens
async function handleSpotFreed(db, classId, now?): Promise<SpotFreedResult> {
  const cls = await db.class.findUnique({
    where: { id: classId }, include: { calendarEntry: true }, ...
  });
  // Liveness is TWO reads since #327: the status, and the entry's cancelledAt.
  if (!cls || cls.status !== 'open' || cls.calendarEntry.cancelledAt !== null) {
    return { action: 'none' };
  }

  // Reads only the entry's date/startTime and a timezone — the cancel
  // deadline plays no part in the window (#236).
  const window = getWaitlistWindow(cls.calendarEntry, tz, now);
  if (window === 'frozen') return { action: 'frozen' };

  if (window === 'auto_promote') {
    // promoteNext: under the Class row lock, checks capacity, promotes the head
    return ...;
  }

  // first_come_first_claimed: under the Class row lock, counts free seats
  // (#212 — it used to notify without checking), declines if a broadcast
  // already stands for this claim window (#691), then notifies everyone
  // waiting. The first claim wins; claimSpot re-checks capacity.
  return ...;
}
```

#### What closes a queue

A `waiting` entry leaves contention in one of two ways, and every writer that
takes an entry out of `waiting` is one or the other:

- **Closed without a seat** — a terminal status or a deleted row. A class that
  starts has its queue closed to `expired` by `closeQueueOnStart`
  (`waitlist.ts`), atomically with each `open → in_progress` exit
  (`autoTransitionToInProgress`, `transitionClass`, and `completeClass`'s
  inline bump when a teacher completes an `open` class directly), so a class
  leaves `open` with no `waiting` rows. A cancellation, a withdrawal or an
  unlink writes `removed`. `deleteStudentAccount` (`gdpr.ts`) and the
  retention sweep (below) delete rows outright.
- **Fulfilled** — `promoteNext`, `claimSpot`, and a queued student booking
  directly through `POST /api/registrations` write `promoted`/`claimed`. Self-
  limiting: the entry leaves `waiting` because the student got a seat.

`addToWaitlist` (`waitlist.ts`) is the writer that puts entries in, creating
or reactivating a `waiting` row; every other writer only renumbers `position`.

This is the property the reconciliation sweep's candidate query
(`reconcileWaitlists`, `waitlist-reconciliation.ts`) leans on for its cost:
its `open`-and-live join stays a bound on a set that does not grow with the
life of the deployment. Re-derive the writers rather than trusting the list
above:

    grep -rnE 'waitlistEntry\.(create|update|delete|upsert)' src | grep -v '\.test\.' \
      | grep -vE ':[0-9]+: *(\*|//)'

The last filter drops comment lines, which mention these calls too; then read
each hit for which status it writes, or whether it deletes the row.

### Waitlist retention (`services/waitlist-retention.ts`)

`reapClosedWaitlistEntries` deletes entries that never became a registration,
on terminal classes more than `WAITLIST_RETENTION_DAYS` past their date
(policy: `docs/data-model.md`, WaitlistEntry → Retention). Nothing else removes
such a row: `deleteStudentAccount` deletes only its own subject's entries, a
`Class` cascade fires only from the template archive, which deletes future
instances and so never reaches a terminal class, and a `Student` is anonymised
rather than deleted. Without the sweep the population grows for the life of
each account — which is also most of what grows the erasure's `Class` lock
set (`deleteStudentAccount`'s pre-lock joins `WaitlistEntry` with no status
predicate; the sweep reaps only unfulfilled entries, so that set shrinks but
is not bounded).

**Why deleting is safe.** Both halves of the sweep's predicate are columns of
one `CalendarEntry` row, and that row's schedule is frozen by the database:
terminality is `classCompletedAt IS NOT NULL OR (kind = 'regular' AND
cancelledAt IS NOT NULL)`, the predicate `entry_frozen_schedule_guard`
evaluates before it refuses a change to `date`, `startTime` or
`durationMinutes`. So on any row the sweep considers, `date` cannot move from
any client, raw SQL included, and "more than 365 days past" is a property of
the row. Terminality is itself held: `entry_completion_marker_guard` makes
`classCompletedAt` write-once, and `entry_terminal_liveness_guard` refuses to
clear `cancelledAt` on a regular entry or set it on a completed one. A raw-SQL
walk of a cancelled class's `Class.status` among the live statuses remains
possible (the `KNOWN-OPEN` beside `TERMINAL_CLASS_STATUSES`,
`class-lifecycle.ts`), but a cancelled regular entry satisfies the predicate
on its own, so the walk changes nothing here. `updateClass` refuses every edit
to a terminal class as service policy; the trigger is what this deleting sweep
depends on, because it holds against clients that never call that function.

No `WaitlistEntry` writer can produce a row the sweep would wrongly reap. Run
the grep above and classify each hit: guarded by class liveness (it requires
the class live, or runs inside the write that makes it terminal), scoped to
`status: 'waiting'` (on a terminal class a `waiting` row is legacy that
reaping removes), or a deleter, which shrinks the population rather than
adding to it.

**Why it cannot deadlock against the erasure**, and why it is one class per
transaction: `docs/lock-order.md`, Known conformance →
`reapClosedWaitlistEntries`.

### Notification Dispatcher (`services/notifications.ts`)

`createNotification` / `createBulkNotifications` do only two things: write the
`Notification` row (the inbox, layer 2) and call `emitToBus`, a
fire-and-forget publish to the in-process SSE bus (layer 1) that clients treat
as a refresh hint, never as the payload itself. Neither function schedules
email or push — those are separate sweeps, each reading committed
`Notification` rows on its own column and its own cutoff: `email-fallback.ts`
(layer 3, `emailSent`/`isRead`, see Cron Jobs) and `push-dispatch.ts` (layer 4,
`pushHandledAt`, see Cron Jobs and Web Push below). Push and email are
decided independently of each other.

### Web Push (`lib/push/`, `services/push-dispatch.ts`)

Full design: `docs/superpowers/specs/2026-10-02-web-push-design.md`.

- `lib/push-policy.ts` decides WHETHER (`shouldPush`, keyed by the
  `StudentPushGroup`/`TeacherPushGroup` preference columns a notification
  type maps to), WHAT (`buildPushPayload` — redacts the body to a fixed line
  for money groups, caps title and body in raw UTF-8 bytes, then shrinks the
  body further when JSON escaping would take the serialised payload past
  `PUSH_PLAINTEXT_MAX_BYTES` — the push service's 4096-byte limit less RFC
  8291's encryption overhead), and urgency (`pushUrgency`).
- `lib/push/{vapid,encrypt,send}.ts` implement RFC 8292 VAPID and RFC 8291
  payload encryption on `node:crypto`. `sendPush` follows no redirect
  (`redirect: 'manual'`) and reports an outcome for everything the push
  service or the network can do: a 2xx is `delivered`; a 404/410 is `gone`,
  the subscription is dead; stored keys it cannot encrypt against
  (`InvalidSubscriptionKeysError`) are `invalid`; any other status, a
  redirect, a network error or a timeout is `failed`, carrying the error as
  `cause` or the start of the response body as `reason`. Any other throw — a
  signing or encryption fault — propagates.
- `lib/push/endpoint.ts`'s `isPushServiceEndpoint` is the host allowlist
  `POST /api/push/subscriptions` applies before it stores an endpoint:
  `https:` on a known browser push service and nothing else, because the
  sweep POSTs to whatever is stored. `savePushSubscription`
  (`services/push-subscriptions.ts`) keeps each account to
  `MAX_PUSH_SUBSCRIPTIONS_PER_ACCOUNT` rows, evicting the least recently
  active (`lastUsedAt ?? createdAt`) in the same transaction as the upsert.
- `services/push-health.ts`'s `runPushDispatchTick` is wired into the
  scheduler (Cron Jobs, below) and wraps `services/push-dispatch.ts`'s
  `dispatchPushes`, the sweep: a worker claims each committed `Notification`
  row just before its sends, with a compare-and-swap on `pushHandledAt` so
  concurrent runs send once, and rows it never reached are left unclaimed.
  It sends to every subscription on the resolved recipient's account, deletes a
  subscription whose outcome is `gone` or `invalid`, and never retries a
  `failed` one. A sender throw is a fault, not a verdict on the row: it
  rejects the tick, which the scheduler logs and records as `lastError`, and
  the subscription stays. A row already older than the stale cutoff
  (`PUSH_STALE_AFTER_MS`, 15 minutes) when a tick reads it is retired without
  sending — a row still within the cutoff at that read can still be sent even
  if it ages past it before the tick finishes. When `diagnoseVapidConfig()`
  (`lib/push/config.ts`) finds the `VAPID_*` environment unusable, every row
  is claimed and stamped without sending (and counted `unsendable` unless
  `VAPID_*` is simply unset); once per process the sweep warns when no
  `VAPID_*` variable is set, and logs an error naming the reason for any
  other problem.

### Offline (service worker)

Full design and the alternatives it rejected: `docs/superpowers/specs/2026-10-04-offline-schedule-design.md` (#725). `public/sw.js` is the worker (it also carries push, above); `src/components/layout/offline-snapshot.tsx` wraps the pages it may store; `src/lib/offline-status.ts` is the page-side connection store; `src/lib/offline-client.ts` posts the worker its `warm` and `clear` messages. The one write a teacher can make offline is an attendance tap on a class page, which is queued on the device and sent when the connection returns (Queued check-in (#726), below). On a page wrapped in `OfflineSnapshot`, offline, every control inside it is disabled except the class page's queueable attendance region (its row buttons, "Edit attendance" and its inline Dismiss); the layout's attendance sync status block (its Open class and Dismiss) sits outside every page's fieldsets and stays enabled.

**What is stored, and why only that.** Three path shapes: `/schedule`, `/class/<id>` and `/studio-class/<id>` (`<id>` not `new`, nothing deeper). They are what a teacher needs at the door, and they carry names only (`studentNameSelect`, `src/lib/student-visibility.ts`), never contact data, which lives on `/students/[id]` and is never stored. Other same-origin navigations go to the network and, when that fails, get the offline page (never stored); `/_next/static/*` is the only other request it answers. RSC fetches, API routes, the SSE stream and cross-origin requests are passed through untouched.

**Network first, with patience.** The network is asked first. The stored copy is served when the request fails, when it answers 502, 503 or 504 (a deploy or an outage), or when 8 s pass with no response and a stored copy exists; a slow response that does arrive still replaces the stored copy. `/` and `/start` (the installed app's launch URL and both detail pages' back link) redirect to the stored schedule when they fail; with none, any failed navigation gets the offline page, an inline "You're offline" HTML string inside `sw.js`, so it cannot fail to install.

**Three caches** (`fy-pages-v1`, `fy-static-v1`, `fy-meta-v1`):

| Cache | Holds | Cleared by |
|---|---|---|
| `fy-pages-v1` | the stored pages, keyed by pathname alone, each rebuilt with `x-fy-owner` and `x-fy-stored-at` | a `clear` message, a redirect on a cacheable path, an owner change, 24 h age, a cache-name version bump (the `-v1` suffix) |
| `fy-static-v1` | `/_next/static/*` files referenced by a stored page | no stored page referencing the file, a cache-name version bump (the `-v1` suffix) |
| `fy-meta-v1` | the clear generation | a cache-name version bump (the `-v1` suffix) |

An entry missing either header, or with one unparseable, is never served. Retention is 24 h, enforced when a page is read and whenever the worker runs (activate, a `warm` message, a navigation to a cacheable path); static files are pruned by reference, so a file lives while any stored page names it. Pruning and a store's put-and-pull of static files take turns on one promise chain in `sw.js`, so a prune cannot delete a file a page just stored is about to rely on. When a page is stored, every `/_next/static/` URL in its body is fetched into `fy-static-v1` (`<script src>`, `<link href>` and the flight payload's chunk references, which carry the `/_next/` prefix); measured on a production build, the pattern matched every `<script src>` chunk on `/schedule`, `/class/<id>` and `/studio-class/<id>`. Without that a warmed page would hydrate offline against missing chunks.

**The owner marker.** `OfflineSnapshot` renders `data-offline-owner="<accountId>"` in the page HTML. The worker cannot see the session (the cookie is `HttpOnly`), so the marker is how it knows whose page it holds: it refuses to store a page without exactly one owner value, and storing a page whose owner differs from a stored one empties `fy-pages-v1` first. The marker therefore has to sit inside each page's own tree, not in a layout. Measured on a running server: a class page the signed-in teacher does not own, or a deleted one, answers HTTP 200 with an in-body redirect (a `<meta http-equiv="refresh">` and `NEXT_REDIRECT` in the flight data), never a 3xx, so it carries no marker and is neither stored nor wipes the cache (pinned by `tests/integration/class-page-offline-marker.test.ts` and `tests/integration/studio-class-page.test.ts`). Were a page to answer with a real 3xx or an opaque redirect (a signed-out request for a teacher page is a 307 to `/login`), the worker treats it as "no valid session" and empties `fy-pages-v1`; a missing or foreign id that did redirect that way would cost one re-warm, accepted.

**Clear sites.** `clearOfflinePages()` posts `{type: 'clear'}` to the worker and deletes `fy-pages-v1` itself; the worker aborts its in-flight warms and bumps the generation in `fy-meta-v1`, and every store re-checks the generation before it touches `fy-pages-v1` at all (so a stale store cannot wipe the next account's pages for an owner mismatch) and again just before `put`, and a request's generation is read before it is sent, so a warm begun under the old cookie in another tab cannot put the signed-out account's page back. It runs on sign-out, on every sign-in completion and after account deletion. Re-derive the list of callers: `grep -rn "clearOfflinePages()" src --include='*.ts' --include='*.tsx' | grep -v test`.

**Warming.** A schedule load asks the worker to fetch the teacher's class and studio-class pages for today (in their timezone), so a class never opened is stored. A warm skips a page stored in the last 10 minutes or being stored now. Wiping for an owner change inside one warm can delete a sibling page that same warm just stored: data lost, nothing leaked, healed by the next warm.

**Offline detection and the stale-while-online rule.** The page, not the worker, decides it is offline: `navigator.onLine`, the `online` / `offline` events and a ping to `GET /api/ping` (no auth, no database, 5 s timeout). Pings fire on mount, on the `online` event, on returning to the tab, and every 15 s while offline. The wrapper then shows "Offline — showing what was loaded at HH:MM" (with the day when the load was not today in the teacher's timezone) and puts the content in a `<fieldset disabled>`, so every descendant control is disabled by the browser, except in the `queueable` slot, which sits outside it (Queued check-in (#726), below); links stay live (an uncached target lands on the offline page). The disabled look comes from the components' own `disabled:` styles, with one rule in `src/app/globals.css` dimming any control that has none. The stale rule is not snapshot-only: a successful ping makes any page wrapped in `OfflineSnapshot` (the only ones that know when they rendered) whose render is more than a minute behind the server's clock call `router.refresh()` once, so a page left open for more than a minute refreshes when the teacher returns to the tab, and this is also what recovers a `RefreshAt` refresh skipped while offline (offline, `router.refresh()` is a hard reload of a stored page, so `RefreshAt` and `LiveUpdates` do not refresh while offline).

**Deploys.** Pages are network first and static files are content-hashed, so a new app build is picked up online with no worker change. The worker itself updates the standard way: the browser byte-compares `/sw.js` on navigation, a changed one calls `skipWaiting()` on install and `clients.claim()` on activate, and `activate` deletes every `fy-*` cache outside its current set. A change to the stored format ships as a bump of the `-v1` suffix on the cache names.

**Residual.** A session revoked elsewhere while this device stays offline keeps its pages until the device reaches the server or a clear runs; the person holding the device is the one who loaded them.

**End-to-end.** `tests/e2e/offline.spec.ts` is the one spec that runs with the worker (`serviceWorkers: 'allow'`); `playwright.config.ts` blocks it everywhere else so no other spec's behaviour depends on it, and Playwright's `setOffline` reaches a worker's fetches only when the worker is allowed. It needs a production build, and when the server at `BASE_URL` (`tests/helpers.ts`; `INTEGRATION_BASE_URL` moves it) is a dev server (its HTML names the `hmr-client` chunk) it throws on CI and skips locally: under `next dev` the page's own lazily loaded dev chunks (the turbopack HMR client) are not named in any stored page, fail offline, and the page never hydrates, so no marker appears. CI runs the production standalone build. It also skips locally during the 23:00 UTC hour, when its class has started and a running scheduler would move it to `in_progress`; CI sets `CRON_SCHEDULER: 'off'`, so nothing moves it there. That skip sits in the shared `beforeAll`, so it skips the queued check-in test too. That test's own class is seeded `in_progress`, 60 minutes long, starting five minutes before the run but never before 00:00 UTC that day (`checkinClassStart`), so its date is always today: in the first minutes after midnight UTC it has been under way for less than five, and check-in shows either way because the status, not the clock, puts the page in check-in.

#### Queued check-in (#726)

Full design and the alternatives it rejected: `docs/superpowers/specs/2026-10-04-offline-checkin-design.md`. `src/lib/attendance-outbox.ts` is the store, `src/lib/attendance-sync.ts` sends it, `src/components/layout/attendance-sync-status.tsx` holds the provider and the status line, and `src/components/class/checkin-gate.tsx` decides when the attendance list shows. Replay runs in the page, never in the worker, so nothing depends on Background Sync (iOS has none).

**The outbox.** One JSON document in `localStorage` under `fy-outbox-v1` (`OutboxState`): `pending`, `confirmed` and `refused`, each keyed by registration id, so a new tap replaces that registration's pending entry. A pending entry (`PendingEntry`) carries the owner's account id, the class, the name the page showed, the status, when it was recorded and an id from `crypto.randomUUID()` (where that is missing, one built from the clock and `Math.random()`). Every write is a read-modify-write of a fresh read under the Web Lock `fy-outbox`, so while storage takes every write two tabs cannot lose each other's entries; without Web Locks a single tab is still correct. The rule when storage refuses a write (a full quota, a private window, blocked storage): the stored copy may lag behind the tab's outbox, but never contradicts it. Storage then keeps only the entries it already held that the new outbox holds identically, a document no larger than one that fit; for every registration where the two differ, that tab keeps its own entries in memory, logged with the error's name when it starts holding any. Every later change in that tab tries the whole write again and falls back the same way, so a mark corrected or settled in memory cannot come back from storage on a reload, and once a whole write succeeds the tab is back on storage alone. While it holds entries in memory, a teacher page (its layout subscribes to the outbox) also tries again on every `storage` event, since another tab's write may have freed room, and when the page is hidden (`visibilitychange` to hidden, or `pagehide`), best-effort, since an unloading page may not finish it. If storage refuses even the smaller write, the stored copy is removed (logged); if it refuses the removal too, that tab stops reading storage. Such a tab does not try again on those events: its write reads nothing first, so it would erase whatever another tab stored since, and reading first would drop its own entries against the very copy storage refused to remove. It writes again only with its next change, which overwrites what another tab stored since in the same way. Other tabs keep every entry storage still holds, and the tab with entries in memory keeps reading theirs. For each registration it holds in memory, that tab remembers everything storage held for it when the write was refused, entries a read prunes included, and when it took that copy from storage; once a read finds storage holding anything else for that registration, another tab has written it since, and the memory copy is dropped for good, so it cannot come back once the other tab settles, clears or dismisses its entry. Pruning is not such a change: a refusal past its expiry counts as absent on both sides, and a confirmation storage no longer holds is a change unless a read since may have pruned it, which is so only for one already stamped more than 5 minutes ahead of the device clock when the tab took its copy, or one past its 24 hours now. Any other absence is another tab's write: a refused write leaves out a stored confirmation that tab no longer agrees with, as when it has just settled that registration again. So a confirmation stamped more than 5 minutes ahead of a device clock that runs behind the server, hidden when the teacher corrects that registration and visible minutes later, does not drop the correction. A tab that first reads storage after that other write is gone again, with storage holding for the registration exactly what it held before (another tab sent it and a 403 dropped it), cannot tell, and keeps its memory copy. A clear is not such a write: every clear is recorded for the other tabs (below). A read that throws changes nothing in storage: the tab keeps what it last read, logged once, and a change made on that read is kept in that tab's memory without a write, as if storage had refused it, since a write built from an old read could overwrite what another tab stored since; the next attempt on a read that works writes it. If another tab wrote the same registration after this tab's last read that worked, that next read finds storage changed and drops this tab's change, as though the other tab's write were the newer. `clearOutbox` always tries to remove the stored copy; if storage refuses, that tab stops reading it. Each clear is then recorded under a second key, `fy-outbox-clears-v1`, written after the removal so the removal has made room for it: `clearOutbox` replaces the token for the whole outbox (and drops every per-account one), `clearOwnedOutbox` replaces that account's token. Every tab reads the record whenever it reads the outbox or rebuilds its view of it (one that stopped reading storage too), on a `storage` event for either key, and under the lock before every write, the retry included; a token changed since its last read means a clear it did not make, and it drops what it holds in memory for that clear, every registration for a whole-outbox clear, the registrations whose entries are that account's for an account's, and never writes those back. The record is written after the removal, so another tab may see the removal first; where the browser has Web Locks, that tab's retry waits for the `fy-outbox` lock, which the clear holds until the record is written. If storage refuses even the record (logged), or a tab cannot read it, that tab cannot tell, and a tab holding entries in memory may write them back. `useOutboxVolatile(ownerId)` reports whether this tab shows pending entries of that account that storage refused (server snapshot `false`); while it does, the status line adds "This device can't keep them if the page reloads." Another account's entries held in memory never make it true for the signed-in one. Parsing never throws: a stored document that cannot be read, or entries that fail validation, are discarded with one `console.warn` per stored document giving how many (no names); expired entries are pruned without one. The maps are null-prototype objects, so a stored `__proto__` key is an ordinary entry. Reads go through `useSyncExternalStore` with an empty server snapshot, so a page served from the worker hydrates against no outbox and fills in after mount. Pending entries never expire; confirmed entries are pruned after `CONFIRMED_TTL_MS` (24 h), or when stamped more than `CONFIRMED_FUTURE_SLACK_MS` (5 minutes) ahead of the device clock, since such a stamp would keep masking the server's status; refused ones after `REFUSED_TTL_MS` (7 days). `localStorage` rather than IndexedDB because only a worker would need IndexedDB.

**One write path.** Every attendance tap, online or offline, is written to the outbox and then triggers a flush (`AttendanceList`); nothing calls the attendance `PUT` directly, so a direct write can never land before an older queued one for the same row and be overwritten by its replay. A row shows `shownStatus`: the pending entry if there is one, captioned with its status label and "waiting to sync" ("Present · waiting to sync"); else a confirmed entry whose `confirmedAt + 1000` is later than the page's `renderedAt` (`confirmedAt` comes from the response's `Date` header, which has one-second resolution, or the device clock if that header is missing or unreadable); else the status the page was rendered with. A tap computes its next status from what the row shows. A tap whose outbox write fails is neither queued nor shown, so the list says "Couldn't save this mark on this device." below the rows until a later tap is saved. The list announces through one screen-reader-only `role="alert"` that is always mounted, empty when there is nothing to say, and holds text only: that sentence, and the refusals for this class that arrived while the list was mounted. The Attendance heading carries "N waiting to sync" while that class has pending entries.

**Flushing.** One flush at a time across tabs, under a second Web Lock, `fy-outbox-flush`; within a tab a trigger arriving during a flush makes it run another pass when the current one ends, for the owner the last such trigger named (Bound to the account, below). Each pass re-reads the outbox from storage (`readOutbox`), since another tab may have replaced or settled an entry, and sends entries in `recordedAt` order, one at a time, each `PUT /api/registrations/[id]` with a `REQUEST_TIMEOUT_MS` (10 s) timeout. A request that gets no answer (it throws or times out) ends the pass, since the next entry would wait out the same failure while holding the flush lock; the entries stay pending for the next trigger or the backoff. Every answer but a 401 lets the pass carry on to the next entry (What each answer does, below). Triggers: the teacher layout mounting (every teacher page, including one served from the worker), a tap, sign-out and Finish class (both below), the browser's `online` event, the tab becoming visible, the connection store (`offline-status.ts`) flipping from offline to online, and a backoff timer (`BACKOFF_MS`: 5 s, 15 s, then every 60 s). The timer arms only after a pass that left something to retry, only while the tab is visible, and only while a started sync (`startAttendanceSync`, run by the provider) is active, so stopping one holds even against a flush still in flight.

**What each answer does** (`classify` in `attendance-sync.ts`). Settling an entry removes it only if it is still the entry that was sent (same id); a newer tap made during the request stays pending.

| Answer | Outcome |
|---|---|
| 2xx whose `data` is `{id, status}` matching what was sent (applied or unchanged) | confirmed, at the `Date` header's instant (the device clock if it is missing or unreadable) |
| 2xx with any other body, or none that parses | kept and logged (ids and statuses, no name); retried on the next trigger or the backoff |
| 409 `CONCURRENT_MODIFICATION`, 408, 429, 5xx | kept; retried on the next trigger or the backoff. A 408, 429 or 5xx is logged (ids and statuses, no name) while `navigator.onLine` says the device is online |
| timeout, network failure | kept, and the pass stops; retried on the next trigger or the backoff. Logged (ids and statuses, no name), except a timeout while `navigator.onLine` says the device is offline |
| 401 | kept; the pass stops, and the status line adds "sign in to sync them" until a later pass in this tab gets a 2xx that answers the write sent, or a 4xx other than 401, 408 or 429 with the app's JSON error body, or finds nothing pending for its account |
| 403 with the app's JSON error body (`{ error: { message, code? } }`) | dropped, and logged with the registration id and status (no name): the signed-in account may not write this registration, and a refusal shown here could show one account's student to another |
| any other 4xx with the app's JSON error body | refused, with the server's message; never retried |
| a 4xx other than 401, 408 or 429 (403 included) without the app's JSON error body (a proxy, captive portal or filter answered) | kept and logged; retried on the next trigger or the backoff |

Refusals are matched to the mounted list by class, not by row: a refusal for the mounted list's class shows below the rows, with a Dismiss button; it is announced only if it arrived while the list was mounted, never one already stored when the list first rendered. One that arrives while the list is mounted also refreshes the page, so the next tap is judged against what is now true; one already stored when the list mounted does not, and a success refreshes nothing. Refusals for a class whose list is not mounted show in the layout's status line instead, with a link to the class. Dismiss moves focus to the next refusal's Dismiss, else to the Attendance heading in the list or to the status block (a `role="group"` named "Attendance sync") in the layout, so focus never drops to the page. A refusal stays until it is dismissed, expires, or a later write for the same registration is confirmed; a retap alone leaves it, since the retry has proved nothing yet. The list and the status line both read the outbox through `ownedOutbox`, so each shows only the signed-in account's pending and refused entries.

**What the teacher sees on every teacher page.** `AttendanceSyncStatus` renders after the page content in the teacher layout, so it never pushes content down: "N attendance changes waiting to sync" while the signed-in account has pending entries (with "This device can't keep them if the page reloads." while this tab holds some of the signed-in account's pending entries only in memory), and each refusal not shown inline, in danger text, with Open class and Dismiss. Text only, no badge, no motion. None of that is a live region. What is announced goes through a separate screen-reader-only `role="status"`, always mounted (empty when there is nothing to say) and holding one summary string. The waiting count, with "sign in to sync them" when a sign-in is needed and "This device can't keep them if the page reloads." while this tab holds some of the signed-in account's pending entries only in memory, is announced only while it is more than a round trip in progress: the connection store says offline, the last flush in this tab left something to try again (`SyncState.retrying`: an entry it tried and must retry, or a pass that failed before trying any), or a sign-in is needed. "N attendance changes couldn't be recorded." counts the refusals the block shows that arrived while the layout was mounted: never one already stored when it mounted, nor one a mounted attendance list showed (and announced) first, so leaving a class page does not announce its refusals again. When a refusal the summary counted leaves it (dismissed, or shown by an attendance list the teacher opened), the others it counted go quiet rather than being announced again under a smaller count.

**Bound to the account.** Each entry carries `ownerId`, the session's `accountId` (the same id as `data-offline-owner`), which the teacher layout provides by context. A flush is for one owner: it sends that owner's entries and leaves every other owner's untouched, neither sent nor settled, since under this session's cookie they would only be refused. So a different account signing in on the device, after a session expiry or over a live one, neither sends nor drops the first account's entries; they stay hidden (the list and the status line read through `ownedOutbox`) and are sent once that account is signed in again. Sign-out (`SignOutButton`, given the session's `accountId` by each page that renders it, or null in signup's ticket mode, which has no session and so sends nothing) flushes that account's pending entries, waiting at most `FLUSH_WAIT_MS` (3 s), then counts the registrations on the device with a change the server does not hold, pending or refused (a refusal that flush just produced included), whoever made it; if any remain it says how many haven't synced and that signing out discards them, and offers "Sign out anyway". A flush pass already running when the teacher chooses "Sign out anyway" keeps sending the entries it read at its start, and those it sends before the session `DELETE` land, so some taps the warning counted as discarded may still be recorded. Leaving clears the outbox (`clearOutbox`) in the same `finally` as `clearOfflinePages()`, whatever the session `DELETE` returned, and so discards every account's entries, in storage and, through the recorded clear (The outbox, above), those another open tab held only in memory; that tab drops them rather than write them back. Account deletion (`DataAndDeletion`, given the session's `accountId`) clears only that account's pending and refused entries (`clearOwnedOutbox`), in storage and, through the recorded clear, in another open tab's memory; the record keeps that account id, and no name, until the next sign-out on the device replaces it. Another account's entries stay hidden, and the next sign-out on the device counts them in its warning. Sign-in clears nothing, so a teacher signing back in after their session expired keeps their taps. Residual: a tab still showing one account's pages after a different account signed in from another tab keeps flushing the first account's entries under the second account's cookie; the app answers 403 and they are dropped (logged).

**Finishing a class.** Completion words each payment request from the statuses the server holds (Payment-request wording, below), so Finish does not overtake queued taps unawares. After the teacher confirms Finish, `CompleteClassButton` (given the session's `accountId` by the class page) looks for that account's pending entries for this class; if there are any it flushes with sign-out's wait (`flushWithinWait`, at most `FLUSH_WAIT_MS`), and if any of this class's are still pending it posts nothing and says "N attendance changes for this class haven't synced.", with Cancel and Finish anyway. Focus moves to Cancel, both buttons are described by that sentence, and Cancel returns focus to Finish class. Another class's entries, and another account's, do not hold Finish back.

**The `queueable` slot and the clock gate.** `OfflineSnapshot` renders `children`, then `queueable` outside any fieldset, then `after` in a second `data-offline-fieldset` fieldset, so offline only `queueable` stays enabled. On the class page `queueable` is the attendance region and nothing else: the check-in gate on a live class (`open` or `in_progress`, not cancelled), the locked list on a completed one, absent otherwise; walk-ins, the pricing preview and the Actions section sit in `after`, and the header's action (Publish, or Finish class) sits in `children`, so all of them are disabled offline. "Edit attendance" on a completed class is local state, so it works offline, and the corrections it opens are queued like any tap. `CheckinGate` shows the attendance list once the server rendered check-in or the device clock reaches `checkinAt` (from `classPageClock`), and the "Registered students" list until then. A list the server showed stays shown whatever the device clock says; one shown by the device clock alone hides again if that clock is set back before `checkinAt`, until it reaches `checkinAt` again. The clock is re-read by a timer at `checkinAt` and on `visibilitychange`, and its server snapshot is `false`, so the first paint is the server's. That is what lets a page warmed in the morning, before check-in opened, show the check-in list at the door with no signal. The walk-in form and the pricing preview stay server-gated: walk-ins are not queued.

**Payment-request wording after completion (the user's decision).** An attendance change after completion, made online or by a late replay, changes the registration and nothing else: no `Payment.amount`, no `Class.totalRevenue`, no second message. Prices and payment requests are fixed by `completeClass`, so a student marked no-show after completion keeps the neutral payment request they were sent, whose amount is right; only a student already marked no-show at completion gets the no-show wording. Nothing is re-sent. Pinned by `'a post-completion no-show changes no money and sends nothing'` (`tests/integration/registrations-api.test.ts`). A follow-up message and a replay-time notice to the teacher were rejected.

**Last writer wins across devices.** A replay from a phone hours later overwrites a correction made on a laptop in between; a late replay is a correction like any other. `recordedAt` orders one device's sends, not writes across devices.

**End-to-end.** `'check-in taps made offline survive a reload and sync when the connection returns'` in `tests/e2e/offline.spec.ts`: taps every student on an `in_progress` class offline, reloads from the worker, sees them still waiting, goes online and reads the server's statuses.

### Entry Generator (`services/entry-generation.ts`)

Runs hourly as part of the in-process scheduler (see Cron Jobs below). For each template whose `ScheduleRule` is active and unarchived it tops up the rolling 4-week window — **at most one entry per week per template** (#194) — and reports every candidate date it could **not** fill along with the reason. Only the sweep also declines a candidate already past its auto-cancel check (`past_cancel_check`, #859); on create and resume the same function fills that date and the teacher is warned instead:

```typescript
// generateEntriesForRule(db, family, template, caller, from) — one template,
// one window, either family. `caller` is `'sweep'` or `'teacher'`
// (`GenerationCaller`, `@/lib/generation`).
// Real identifiers, bodies elided: `dates`, `free` and `startTime` are the
// actual locals, `getNextOccurrences` and `classStartInstant` the actual
// helpers. A sketch that invents names is a sketch nobody can grep, which is
// how the loop this replaced went on being documented after it was gone.
// `dayOfWeek`, `startTime` and `teacherId` left `ClassTemplate` for
// `ScheduleRule` in issue 298, so they're reached through `template.scheduleRule.*`.
// `startTime` is `ScheduleRule.startTime` itself (a `@db.Time` `Date`) — no
// `timeToHHmm` round trip, since `classStartInstant` and
// `CalendarEntry.startTime` (issue 327 Task 1) both want that type directly.
const startTime = template.scheduleRule.startTime;
const dates = getNextOccurrences(template.scheduleRule.dayOfWeek, startDate, DEFAULT_WEEKS + 1)
  .filter((d) => classStartInstant(d, startTime, tz) > startDate)
  .slice(0, DEFAULT_WEEKS);

// ONE query per question, and since #194 there are two. Both read
// `CalendarEntry`, not `Class`: issue 327 moved the calendar identity there,
// so a teacher's occupancy is one table spanning both families. This one
// classifies each candidate DATE: already generated, blocked by a cancelled
// instance of this template, or the teacher's slot taken by another entry —
// of either family, which is why the pre-check needs no sibling read.
const occupants = await db.calendarEntry.findMany({
  where: { teacherId: template.scheduleRule.teacherId, date: { in: dates } },
  select: { scheduleRuleId: true, kind: true, date: true, startTime: true,
            durationMinutes: true, cancelledAt: true },
});

// And this one classifies its WEEK — `already_this_week`. Keyed on
// `scheduleRuleId`, not `teacherId`: it rides `@@unique([scheduleRuleId,
// date])`, and the date-scoped read above structurally cannot see the class
// that holds a week from a DIFFERENT day, which is the whole case it exists
// for. No liveness filter, deliberately — a cancelled entry holds its week.
const heldWeeks = new Set(
  (await db.calendarEntry.findMany({
    where: { scheduleRuleId: template.scheduleRuleId, date: { gte: weekStart, lt: weekEnd } },
    select: { date: true },
  })).map((e) => mondayOf(e.date)),
);

// Read once, before the loop: the `past_cancel_check` judgement, the stamp
// `createChildren` writes, and `firstCreated.at` are this one instant.
const at = new Date();

for (const date of dates) {
  // own date → week → exact slot → overlap, each `skipped.push` + `continue`
  // …
  // LAST, and sweep-only: the family's `pastCancelCheck` judged at `at`.
  if (caller === 'sweep' && family.pastCancelCheck?.(/* template, candidate, tz, */ at)) {
    skipped.push({ date, reason: 'past_cancel_check' });
    continue;
  }
  free.push(date);
}

// The reasons are what the teacher and the operator get told.

// TWO inserts since #327, and only the first can conflict. `skipDuplicates`
// compiles to a bare `ON CONFLICT DO NOTHING` — no conflict target, so it
// covers `CalendarEntry_teacher_slot_excl` as well as the unique key — and a
// date lost to a concurrent insert costs that date and nothing else. The
// child rows below are keyed on the entry ids that landed, so nothing is
// left for a second `ON CONFLICT` to catch.
const inserted = await db.calendarEntry.createManyAndReturn({
  data: free.map((date) => ({ /* rule's calendar fields + date */ })),
  skipDuplicates: true,
  select: { id: true, date: true, startTime: true },
});
if (inserted.length > 0) {
  // The family's own write, not this function's: `class.createMany` under
  // `CLASS_GENERATOR`, `studioClass.createMany` under `STUDIO_GENERATOR`,
  // each keyed on `entry.id` and carrying only that family's economics.
  await family.createChildren(db, template, inserted, at);
}

const earliest = /* the row of `inserted` with the minimum date, or null */;
return {
  created: inserted.length,
  skipped,
  firstCreated: earliest && { date: earliest.date, startTime: earliest.startTime, at },
}; // GenerationResult
```

**Not a per-date insert loop, deliberately.** It was one until #164. Every production path into this function runs inside an interactive transaction the CALLER owns — stated as that property rather than as a roster, which is what went stale here and in the function's own docblock. Re-derive the paths with `grep -rn 'generateInstancesForTemplate(\|generateStudioInstancesForTemplate(\|generateEntriesForRule(' src/ | grep -v '\.test\.'` — both adapters, which pass `'teacher'`, and the two hourly sweeps, which call `generateEntriesForRule` directly with `'sweep'` — and note that the grep is not exhaustive on its own: `CLASS_FAMILY.generate` and `STUDIO_FAMILY.generate` (the two `*-template-lifecycle.ts` files) hold their adapters by reference, so the shared `pauseOrResumeRule` (`services/rule-lifecycle.ts`) reaches them without a call site the grep can see. Prisma does not savepoint individual queries inside an interactive transaction, so a per-date insert that hit a unique violation aborted the whole transaction, and a clash on the last date let `COMMIT` return the `ROLLBACK` tag with no error at all. A teacher resuming a template was told it worked while the template stayed paused. See `docs/superpowers/specs/2026-08-11-generator-slot-reporting-design.md`.

**One generator, two families, since #284.** The code sketched above is `generateEntriesForRule` (`services/entry-generation.ts`), which both families run. Each supplies a `GeneratorFamily` descriptor naming its `CalendarEntry.kind`, its log noun, its child table, and how to read and write its own children — `CLASS_GENERATOR` in `services/class-generator.ts`, `STUDIO_GENERATOR` in `services/studio-class-generator.ts` — and each keeps a named per-template adapter (`generateInstancesForTemplate`, `generateStudioInstancesForTemplate`) because call sites and comments name it. The week key, the skip reasons and the `GenerationResult` are therefore the same code on both sides rather than the same shape written twice; the studio family gained the week key with the merge. The same file holds `claimRuleForGeneration` and `probeFirstEffectiveWeek`, likewise one copy for both.

**A template edit reaches no generated class.** `updateClassTemplate` (`services/class-template-lifecycle.ts`) still touches no generated class: since #194 there is no propagation service. But it is no longer a single-table, single-statement write — issue 298 split the wire schema across `ClassTemplate` and `ScheduleRule`, so its `$transaction` writes `ClassTemplate` always and `ScheduleRule` only when the edit touches a slot field (`classType`/`dayOfWeek`/`startTime`/`durationMinutes`), up to three statements across the two tables. The transaction also takes the child row's `FOR UPDATE` lock the sibling template functions serialise against (`docs/lock-order.md`, "The child row is the lock node for the template families"), not merely `SET LOCAL lock_timeout` over a single `update`. The PUT then runs a read-only probe that predicts the first week the new schedule can reach, and says so in its response. For a class template it also answers whether that week's class would start inside its cancellation deadline (`lateFirstClass`, `docs/superpowers/specs/2026-10-13-template-late-first-class-design.md`; the probe skips a first class the sweep would decline, so the answer is `past_deadline` or `null`, never `past_check` — `docs/superpowers/specs/2026-10-13-sweep-past-check-skip-design.md` §4).

---

## Authentication Flow

### Magic Link (primary)

Nothing here is signed. The token is `crypto.randomBytes(32)`, unguessable on
its own merits; `@oslojs/crypto`'s only job is hashing it (SHA-256) before the
row is written, so a database read yields no usable token — same shape as a
password hash, not a signature.

Every mint also binds the token to `fair_yoga_origin`, a long-lived nonce
cookie identifying the browser that asked for the link (`deliverSignInLink`,
the one function all three link-emitting routes go through). That is what
`/verify` uses to tell a click on the requesting browser from a click
anywhere else — a forwarded link, a second device, a mail scanner
prefetching it — without ever asking the user which one this is:

```
1. User enters email on /login (or /signup, or a booking page)
2. API mints a random token, stores its SHA-256 hash in DB with a 15-min
   expiry, bound to a hash of this browser's fair_yoga_origin nonce
3. The transactional email provider delivers email with link to /verify?token=xxx
4. /verify checks the opening browser's nonce against the bound hash:
   - matching nonce: consumes the token, creates a session cookie (httpOnly,
     secure, sameSite)
   - no cookie, or another browser's: consumes nothing — stamps a one-time
     6-digit code on the token instead and shows it, for the browser that
     actually asked for the link to redeem via POST /api/auth/magic-link/claim
5. Redirect to dashboard (teacher) or bookings (student), once a session exists
```

On iOS, an installed home-screen app keeps its own cookie jar, separate from
the browser's, so a link tapped in Mail opens in the browser and takes the
code branch; the app redeems the code like any second browser (#723). `/login`
offers the code field without a fresh request ("Have a code from the email
link?"), because iOS may reload a backgrounded installed app while the
person is reading their mail.

### Passkey (returning users)

```
1. User clicks "Sign in with passkey" on /login
2. Browser triggers WebAuthn ceremony via @simplewebauthn/browser
3. Server validates assertion via @simplewebauthn/server
4. Creates session cookie, same as magic link flow
5. Redirect to dashboard
```

### Installed app start URL

`/start` (`src/app/(public)/start/page.tsx`) is the installed app's
`manifest.ts` `start_url`. It routes by profile — a teacher to `/schedule`, a
student-only account to `/bookings`, a two-hat account to the teacher home,
and a signed-out visitor to `/login` rather than the public pitch `/` shows —
and it stays outside `SIGNED_IN_SECTIONS` in `src/proxy.ts` deliberately: the
proxy would turn the signed-out case into `/login?redirect=/start`, trading
`/start`'s own per-profile routing for a fixed redirect target nobody asked
for. (The proxy's matcher does cover it, since every page needs a CSP nonce.)
Pinned by `tests/integration/pwa.test.ts`.

### Content Security Policy

Pages carry a per-request nonce policy with `'strict-dynamic'`
(`src/lib/csp.ts`, applied in `src/proxy.ts`). A page whose scripts the policy
refuses (for example, no matching nonce) still renders but never hydrates, so a
violation is surfaced in two places (#793):

- **CI.** The e2e suite fails the test. `cspViolations` in
  `tests/e2e/fixtures.ts` is an auto fixture armed on the default context and on
  every context the test opens itself through `browser.newContext()` or
  `browser.newPage()`. `tests/e2e/csp-watch.spec.ts` pins it. Its self-test
  injects an inline event handler, which violates `script-src-attr`, rather than
  a script element: under `'strict-dynamic'` a script inserted by script runs
  even without a nonce, so it would not be a violation. `cspViolationsAllowed`
  exists only so that spec can trigger violations on purpose.
- **Production.** The policy ends in `report-uri /api/csp-report`. That route
  (`src/app/api/csp-report/route.ts`, summary in `src/lib/csp-report.ts`) logs
  one `warn`, `csp violation`, carrying the directive, the blocked resource
  reduced to its origin, bare scheme or keyword, the document path without its
  query, and the disposition. It is IP-rate-limited (60 a minute), and there is
  no global log throttle beyond that: a distributed sender can fill logs through
  it as through any other unauthenticated route. A report the route refuses (a
  content type other than `application/csp-report`, a missing or oversized
  `Content-Length`, a body that is not JSON or not a report) is not silent
  either: it logs one `warn`, `csp report refused`, per reason per minute, with
  the reason, the content-type token and the declared length and never the body,
  so "no violations" and "every report is being refused" read differently.
  The default-context case of `csp-watch.spec.ts` also waits for the report
  Chromium sends for its violation and asserts the route answered 204.

The policy uses `report-uri`, not `report-to`. Measured in Chromium only,
against a throwaway server, headless Chromium 149 on `http://localhost` delivered a `report-uri`
report within 3 s and no `report-to` report within 75 s, and Chromium ignores
`report-uri` whenever `report-to` is present, so adding the second would replace
the one path that can be observed with one that cannot
(`docs/superpowers/specs/2026-10-08-csp-violation-signal-design.md`, section 1).

### Cross-site writes

Writes are refused cross-origin in `withErrorHandler` (`src/lib/cross-origin.ts`,
403 `CROSS_ORIGIN`, logged at `warn` with the reason), so SameSite=Lax is not
the only CSRF layer. `src/lib/write-handler-wrap-census.test.ts` fails when an
exported write handler under `src/app/api` is not wrapped in it.
`/api/unsubscribe` is the one route that opts out (`crossOrigin:
'token-authorised'`): its credential is the signed token in the URL and it
reads no session, so a foreign Origin forges nothing. The same test pins that
no other route passes the option.

`parseBody` also refuses any body not sent as `application/json` (415
`UNSUPPORTED_MEDIA_TYPE`). That closes the content types a cross-site form can
post without a preflight — `text/plain`, urlencoded and multipart — but only
for routes that read their body through `parseBody`. A route that reads its
body itself relies on the Origin check alone: the multipart photo upload
(`POST /api/teachers/[id]/photo`) and the optional archive body of
`PATCH /api/students/[id]`, and `POST /api/csp-report`. The last has no
`parseBody` because its content type is `application/csp-report`, not JSON, so
the 415 above cannot close the form-post path for it. A browser's cross-site
report carries the foreign `Origin` and is refused 403 `CROSS_ORIGIN`
(`tests/integration/csp-report.test.ts` pins it); a sender with no `Origin`
header is not a browser page and gets at most one `warn` per accepted report,
bounded by the IP rate limit. Find others with
`grep -rln "formData()\|request.text()\|request.json()" src/app/api`.

### Unauthenticated API routes

`find src/app/api -name route.ts` finds **92** routes. **16** carry no session
guard; **10** of those are rate-limited (`magic-link/claim`, `magic-link/send`,
`student-signup`, `teacher-signup`, `slug-available`,
`passkey/authenticate/options`, `payout-pause`, `unsubscribe`, `passkey-revoke`,
`csp-report`), leaving **6** with neither (16 - 10 = 6):

| route | why that is correct |
|---|---|
| `health` | Public summary `{ status, db }`; per-job detail and the degradation count need the cron secret (`hasCronSecret`). |
| `ping` | Public reachability probe: touches no database and answers only the server's clock. |
| `auth/magic-link/verify` | Token is `crypto.randomBytes(32)` — 256 bits, stored hashed, 15-minute TTL. Brute force is infeasible. |
| `auth/passkey/authenticate/verify` | Gated on a one-time 5-minute challenge plus WebAuthn signature verification; `redirect` is `relativePath.optional()` in `passkeyAuthVerifySchema`. |
| `webhooks/mollie` | Mollie's classic webhook, whose body is only a payment id. An id that is not a `tr_` id, or that no attempt holds, costs at most one indexed read and answers 200 with no Mollie call. A known id's status is never read from the request: it is fetched from Mollie with the attempt's own teacher's token, and only that answer is applied. A repeated or forged call therefore changes nothing a fetch would not. |
| `teacher-photos/[photoId]` | Public by design (#46): the teacher's public page shows the photo to signed-out visitors. The id is a per-upload `randomUUID`, regenerated on every upload and replace, and the route answers 404 once a photo is replaced or its teacher erased. |

`processor/mollie/callback` is not a row: it calls `requireTeacher` and so
prints a guard in the loop below. A visitor without a teacher session is sent to
sign in, and the single-use `OAuthState` it consumes is bound to the session
that started the connect, so a forged or replayed link refuses without
changing anything.

Re-derive with:

```sh
find src/app/api -name route.ts | wc -l
for f in $(find src/app/api -name route.ts | sort); do
  ids=$(grep -ohE "require[A-Za-z]+\(|getSession[A-Za-z]*\(|resolveProfileAuthorization\(|resolveTicketOnlyProfileAuthorization\(|CRON_SECRET|hasCronSecret\(|checkIpRateLimit\(|checkRateLimit\(|checkStudentWriteLimit\(" "$f" \
        | tr -d '(' | sort -u | tr '\n' ' ')
  printf "%-60s %s\n" "${f#src/app/api/}" "$ids"
done
```

The loop prints one row per route and expects all of them to be read, rather
than filtering to a count. A filtering grep gets this wrong:
`notifications/stream` guards with `getSessionToken`, not `requireSession`, so a
pattern listing only the `require*` helpers files it as unguarded.

Two further limits worth knowing: `sort -u` collapses a file to one row per
unique identifier, so a file with one guarded method and one unguarded method
beside it (a guarded `GET` next to a wide-open `POST`, say) reads as a single
guarded row — the command finds unguarded *files*, not unguarded *methods*.
And it only recognizes the guard helpers named in the pattern: the two
profile routes, `account/teacher-profile` and `account/student-profile`,
call no `require*` helper themselves — each authorizes through a resolver in
`src/lib/auth/profile-authorization.ts` (`resolveProfileAuthorization`,
`resolveTicketOnlyProfileAuthorization`) that accepts a signup ticket or a
live session, which is why the pattern names those resolvers. A route that
guards through a helper the pattern does not name prints an empty row. And a
`hasCronSecret` in a row gates only `health`'s detail, not access: count it as
no guard.

### Passkey authentication options

`POST /api/auth/passkey/authenticate/options` never sends `allowCredentials`,
and reads nothing at all from the request body.

It used to accept an email, look up the account, and return that account's
credential ids. The key was absent for an unknown address, an empty array for
an account with no passkey, and a populated array otherwise — so an
unauthenticated caller could read account existence, passkey count and the
credential ids themselves off the response shape.

Equalising the response would not have been enough. The lookup is a timing
signal in its own right: one query for an unknown address, two for a known one.
Deleting the input removes both channels and leaves an invariant a reviewer can
check from the signature — no request-controlled value reaches the response.
`generatePasskeyAuthenticationOptions` therefore takes no parameter rather than
an unused optional one, so restoring the leak is a signature change.

**The cost.** Without a credential list the authenticator cannot pre-select,
so the ceremony needs a *discoverable* credential. Registration uses
`residentKey: 'preferred'`, so platform authenticators (iCloud Keychain,
Windows Hello, Android) are unaffected, while a hardware key whose resident
slots are full produces a non-discoverable credential that can no longer sign
in — that person falls back to the magic link, which is what the sign-in
button's failure copy points at.

**This population cannot be measured from our data.** Knowing whether a stored
credential is discoverable needs the `credProps` extension at registration,
which this codebase neither requests nor stores; `transports` is the only proxy
(a row without `'internal'`). The decision rests on inference about
authenticator behaviour, not measurement.

### Passkey user verification

Both ceremonies ask the authenticator for user verification (`'required'`) and
both verifiers require it, derived from one declaration in
`src/lib/auth/passkey.ts` (`USER_VERIFICATION`) so the request and the check
cannot disagree (#732). A passkey is therefore two-factor: the device, plus the
PIN or biometric that unlocks it.

The options used to ask for `'preferred'` while the verifiers, by
`@simplewebauthn/server`'s default, required verification anyway. Adding a
passkey with an authenticator that honours "preferred" by skipping it — a
roaming security key with no PIN set — completed the browser ceremony and was
then refused by the server, behind generic copy. With `'required'` the browser
stops that key before anything is sent for verification. That the browser's
own UI then says why (Chrome typically offers to set a PIN on the key) is
inference about real browsers, not measurement: the e2e test drives Chromium's
CDP virtual authenticator, which has no UI.

Sign-in is different. Chromium's virtual authenticator refused a UV-less
authenticator holding a discoverable credential under `'preferred'` as well as
`'required'` — this app's sign-in sends no `allowCredentials` (see "Passkey
authentication options"), the likely reason, not isolated further. No browser
test can therefore tell the two values apart at sign-in, and the authentication
options' `'required'` is pinned only by the unit tests in
`src/lib/auth/passkey.test.ts`. A physical key may behave differently.

Nobody who could use a passkey before is affected: the server already demanded
verification, so every stored credential was registered with it and every
successful sign-in supplied it.

Rejected:

- **Accept possession alone** (`requireUserVerification: false`). A PIN-less
  key would work, but a stolen key would become a full sign-in for any
  authenticator that skips verification — a looser posture for everyone, to
  rescue a population that has the magic link to fall back on.
- **Split by ceremony** (presence for registration, verification for sign-in).
  A key registered without verification could then never sign in.

### Passkey challenge store

`src/lib/auth/passkey.ts` keeps WebAuthn challenges in memory, one bounded
partition per `ChallengePurpose`: `registration` (1,000) and `authentication`
(10,000).

They are separate because their writers differ in trust. Registration is
session-gated and keys by `accountId`; authentication is unauthenticated and
keys by a server-generated random id. One shared map would let a flood on the
ungated side evict the gated side's entries, and would let
`authenticate/verify`'s caller-supplied `challengeId` reach a registration
challenge — consuming a victim's in-flight one if their `accountId` were known.

Sizing: roughly 200 B per entry (32 B key, 43 B base64url challenge, 8 B
timestamp, ~120 B Map and object overhead), so both partitions full is about
2.2 MB against the 2 GB VPS. `registration`'s ceiling is a backstop rather than
a working limit — that partition holds at most one entry per account with a
registration in flight.

**Ordering invariant:** within a partition, iteration order is non-decreasing
in `expiresAt`. It holds because the TTL is constant, `expiresAt` is never
refreshed on read, and `storeChallenge` deletes a key before re-inserting it so
a re-stored entry moves to the tail. Two things depend on it: cleanup walks
from the head and stops at the first live entry (complete, not a sample), and
the head is the correct eviction victim under capacity pressure.

### Session Management

Sessions are stored in the database (not JWTs) so they can be revoked. Session cookie points to a session record with `expires_at`. Middleware checks session validity on every authenticated request.

**Lifetime.** A session slides: once fewer than 15 days of `expiresAt` remain, a
request pushes it out to 30 days — but never past a 90-day ceiling measured from
`createdAt` (`ABSOLUTE_LIFETIME_MS`, `src/lib/auth/session.ts`). The cookie's
`Max-Age` is that ceiling; the server enforces the real expiry. The notification
stream revalidates its session on every keepalive tick and closes when it is gone.

**Recent authentication.** Adding a passkey is the one action that creates a new
way into an account, so `POST /api/auth/passkey/register/options` and
`.../register/verify` both refuse, `403 RECENT_AUTH_REQUIRED`, a session whose
`createdAt` is more than 5 minutes old (`hasRecentAuth`,
`src/lib/auth/recent-auth.ts`; `requireRecentAuth`, `src/lib/api-utils.ts`).
`createdAt` is the time of last authentication because every sign-in door mints a
new session (roster in Session-issuing doors, below) and a sliding extension only moves `expiresAt`. The
check runs in `verify` before the challenge is consumed, so a refusal leaves the
challenge standing. The way through is the ordinary emailed sign-in link, which
mints a fresh session — except for a resume that requires a passkey (below),
whose fresh session must come from signing in with that passkey, since a
link's session cannot satisfy it; the resume screen says so in place of the
server's copy. Removing a passkey (`DELETE /api/auth/passkey/[id]`) and
signing out everywhere (`DELETE /api/auth/session/all`) are not gated on recent
sign-in: both only take ways in away. Removing a passkey is refused, `409
PASSKEY_REMOVAL_PAUSED`, while the account's teacher has payments paused
(`deletePasskey`, `src/services/passkey-credentials.ts`); an account without a
teacher profile is never refused. The removal reads the pause under the
teacher row's lock, its first lock (`docs/lock-order.md`, "The `Teacher` row
is the first lock"), so a removal and a pause serialise and the refusal is
exact. A removal that goes through deletes the passkey and writes a
`RemovedPasskey` row (the removed credential's `createdAt`, and when) in one
transaction, and emails the account address once it has
committed (`deliverPasskeyRemovedNotice`, `FireAndForget`, the same shape as
the added notice below). The pause itself
(`POST /api/payout-pause`, `pausePayments`) signs out everywhere inside its own
transaction through `signOutEverywhereTx`, the transaction-taking form of
`signOutEverywhere`. Signing out everywhere ends the account's sessions and its
push subscriptions in one transaction (`signOutEverywhere`,
`src/services/account-sign-out.ts`), because a subscription is keyed by
account, not session, and would otherwise keep delivering to a device that was
signed out. That transaction, and every other that writes more than one of an
account's sessions (a passkey delete writes them through its `SET NULL`),
first locks the `Account` row, and `signOutEverywhereTx` takes the proof of
that lock rather than an account id (`docs/lock-order.md`, "The `Account` row
orders multi-session sign-out writes"). A successful registration emails the account address
(`deliverPasskeyAddedNotice`, `FireAndForget`: the registration has committed
and its response must not depend on the provider, and the mint of the email's
link sits inside that body for the same reason). The email carries a **This
wasn't me** button to `/passkey-revoke`, minted per registration
(`mintPasskeyRevokeToken`, a `PasskeyRevokeToken` row holding the hash of the
secret, which rides in the URL fragment and lives
`PASSKEY_REVOKE_TOKEN_TTL_DAYS`). Redeeming it
(`POST /api/passkey-revoke`, `revokePasskeyByLink`) signs out everywhere,
deletes the account's sign-in links, and removes that one passkey with a
`RemovedPasskey` record; while payments are paused it signs out and keeps the
passkey. A failed mint is logged and the email goes out without the button, its
remedy still in words
(`docs/superpowers/specs/2026-10-10-passkey-added-sign-out-link-design.md`,
Decisions 9 and 10).

**Which passkey a session signed in with.** `Session.passkeyCredentialId` names
the credential a passkey sign-in verified: `passkey/authenticate/verify` passes
it to `createSession`, and every other session-issuing door (below) leaves it
null, so a magic-link session records no passkey. It is `ON DELETE SET NULL`
against `PasskeyCredential`, so deleting a passkey leaves its sessions
standing with no credential named.

**Resuming paused payments** (`POST /api/teachers/[id]/payments-resume`,
`resumePayments` in `src/services/payout-resume.ts`) is the one action that
reads that column. In order: ownership; `requireRecentAuth`, the same 5-minute
rule as adding a passkey; a teacher who is not paused answers `200` unchanged,
so a double-submit is answered rather than refused; then the passkey the pause
froze. The pause writes a `pausePasskeyCutoff` when the account then held a
passkey created before it, or had removed one created before it at or after
the cutoff (a `RemovedPasskey` row): so someone signed in by an emailed link
who removes the teacher's passkeys and then changes the details has not
removed the requirement. The pause counts the standing passkeys first and
the removals second (`heldPasskeyBefore`, `src/services/payout-pause.ts`);
since a removal deletes and records in one transaction, one committing
between the two reads moves its passkey from the first read's set into the
second's, never out of both. When the pause wrote one and fewer than
`PAUSE_PASSKEY_FALLBACK_DAYS` (14) have passed since `paymentsPausedAt`, the
session's `passkeyCredentialId` must name one of the account's credentials
created before the cutoff, else `403 PASSKEY_REQUIRED`. A passkey registered
after the pause, or in the lookback before its window, is never eligible, and
the passkey-removal refusal above keeps the eligible ones in place during the
pause. When only a removed passkey set the cutoff, none left can satisfy it,
and the resume screen says resuming opens when the fallback does. After the
fourteen days, or with no cutoff, no passkey is required. One more case the
gate trusts: a passkey an inbox thief registers more than
`PAUSE_PASSKEY_LOOKBACK_DAYS` (7) before changing the details is older than
the cutoff, so it is eligible; the passkey-added email to the account address
is the signal for it, and while the link works its button acts on it: before
a pause it removes that passkey, during one it signs out and keeps it. Its
mirror: passkeys removed more than `PAUSE_PASSKEY_LOOKBACK_DAYS` before the
details change leave a `RemovedPasskey` older than the cutoff, so the pause
sets no requirement; the passkey-removed email, sent at the removal, is the
signal for that. Both are
the residual risk the design states
(`docs/superpowers/specs/2026-10-08-payout-change-alert-design.md`,
Decisions 4 and 5). Last, under the teacher's `FOR NO KEY UPDATE` lock, it
re-checks paused and the passkey, and compares the fingerprint the resume
screen posted (`payoutFingerprint`, `src/lib/payout-fingerprint.ts`: sha256
over every bank account in every currency, column by column, and the link)
with the details now, else `409 PAYOUT_DETAILS_CHANGED`. A resume from the
resume screen refreshes it, so the screen's not-paused answer states the last
resume (`paymentsResumedAt`) rather than only that payments are not paused;
the refresh is what keeps a Back to the schedule from showing the paused card
it cached.

**Offline cache and `Clear-Site-Data`.** The service worker keeps visited pages
for 24 hours so a teacher with no signal in a studio can still open them. Ending a
session elsewhere is already handled without the header: local sign-out and
account deletion call `clearOfflinePages()`, "sign out everywhere" does too on the
device that performs it, and `public/sw.js` empties the page cache on any redirect
response, which is what the next online page request of a revoked session gets.
`Clear-Site-Data: "cache"` is not the fix: it clears the HTTP cache, while Cache
Storage, where the worker keeps pages, is under `"storage"`, which also wipes
IndexedDB and with it the unsynced offline check-in queue. A shared device that
stays offline keeps up to 24 hours of pages, accepted because that window is the
feature (`docs/superpowers/specs/2026-10-06-credentials-outlive-session-design.md`,
premise table).

### Session-issuing doors

Every site that mints a session cookie also clears the signup-ticket cookie:
a browser holding a session has no use for a ticket, and the profile routes
will not read one while a session cookie is present (`ticketTokenFrom`,
`src/lib/auth/profile-authorization.ts`).

Re-derive the roster with:

```sh
grep -rl "setSessionCookie" src --include='*.ts' --include='*.tsx' \
  | grep -v '\.test\.' | grep -v 'src/lib/auth/session.ts'
```

Five at the time of writing: `magic-link/verify`, `magic-link/claim`,
`passkey/authenticate/verify`, and the ticket paths of `teacher-profile` and
`student-profile`.

Two things about that command, both learned by getting it wrong. It matches
the bare name rather than `setSessionCookie(`, so a wrapped or reformatted
call still counts; and it searches `src`, not `src/app`, so a door added
outside the route tree cannot hide. `src/lib/auth/session.ts` is excluded
because it defines the helper rather than using it. Cross-check against

```sh
grep -rl "createSession(" src --include='*.ts' --include='*.tsx' \
  | grep -v '\.test\.' | grep -v 'src/lib/auth/session.ts'
```

which should name the same five files. The two are 1:1 today, and a
divergence is itself the signal that a door was added or lost.

The one door that ends a session rather than issuing one is the ticket-minting
branch of `magic-link/verify` and `magic-link/claim`: minting a ticket clears
AND revokes any session the request carried, because the precedence rule below
would otherwise leave the new ticket unusable for its whole life.

### The signup-ticket precedence rule

A signup ticket is readable only when the request carries no session cookie —
presence, not validity. `ticketTokenFrom` (`src/lib/auth/profile-authorization.ts`)
is the only place that decision is spelled; everything else calls it. Four
callers at the time of writing: the two resolvers in that same module (serving
`POST /api/account/teacher-profile` and `POST /api/account/student-profile`),
and the two server-rendered pages that prefill a form from a ticket —
`/signup/profile` and the booking page. Re-derive with:

```sh
grep -rn "ticketTokenFrom(" src --include='*.ts' --include='*.tsx' \
  | grep -v '\.test\.'
```

A page that re-derived the rule from `getSession()` instead would be subtly
wrong in the same way twice over: `getSession()` is falsy both when no session
cookie was sent and when one was sent but failed to validate, and only the
first of those may fall back to a ticket.

Presence has one definition because one parser answers it. `getSessionToken`
reads `NextRequest.cookies`, the same store `ticketTokenFrom` asks; a second,
hand-rolled `Cookie`-header split used to disagree with it about headers the
platform parser refuses.

---

### Admin surface

The platform-admin surface (#60) is a short-lived, passkey-only part of the app
that answers on its own host. Who may enter is `AdminGrant`
(`docs/data-model.md`, AdminGrant); grants are made only from a shell
(`scripts/admin-grant.ts`, run from the `migrate` image: `DEPLOYMENT.md`, Admin
access). Its pages live in the `(admin)` route group, under `/admin`.

**The host.** `ADMIN_HOST` is a host with optional port, compared with the
request's `Host` header (`src/lib/admin-host.ts`). Unset or blank, the surface is
off: every admin path answers 404. That is the default for self-hosters. A value
that is not a bare `host` or `host:port`, or that equals the app's own host
(which would redirect every main-site page), also turns it off.
Neither the hostname nor the paths are secret (the repo is public and
certificates are in Certificate Transparency logs); what is withheld is whether
an account holds a grant.

**The proxy shapes pages only.** Its matcher excludes `/api/*` (a matched path
has its body buffered, which would defeat the photo upload's early size
refusal), so it can route pages by host but cannot guard an API route. The
host check that holds is the gate's. On the admin host the proxy redirects any
page outside the admin tree to `/admin`, redirects an admin path with no
session cookie to `/admin/sign-in?redirect=...`, and stamps
`X-Robots-Tag: noindex, nofollow`. On the main host it does nothing: `/admin`
passes through and the page-level host check renders the 404. The proxy imports
`admin-host.ts`, which imports only the dependency-free `src/lib/safe-path.ts`
(`isSafeRelativePath`), so the proxy stays off the database; a test pins
`admin-host.ts`'s imports.

**The gate.** `resolveAdminAccess` (`src/lib/admin-access.ts`) answers in this
order, and the order is the disclosure rule:

1. `Host` equals `ADMIN_HOST`, else `not_found`.
2. A valid session, else `sign_in`.
3. An active grant on the session's account, else `not_found`.
4. The session was created by a passkey sign-in (`passkeyCredentialId` set) and
   is younger than `ADMIN_AUTH_WINDOW_MS`, else `sign_in`.
5. `granted`, carrying an `AdminProof`.

A non-grantee therefore reaches only `not_found` or the session-less (or unrecognised-session) `sign_in`,
and sees the same 404 a nonexistent route gives. Only a grantee can reach the
step-4 redirect, which discloses nothing a non-grantee could use.
`ADMIN_AUTH_WINDOW_MS` is its own constant, not `RECENT_AUTH_WINDOW_MS`, whose
docblock makes it the passkey-adding rule; both are measured from
`Session.createdAt` for the reason given under Recent authentication above.
The admin pages are consequently a short window after each passkey sign-in, and
signing in again is the expected rhythm.

**`AdminProof`.** `{ accountId, sessionId }` with a compile-time brand
(`unique symbol`) and a runtime binding: the only mint is
`resolveAdminAccess`, which freezes the object and records it in a `WeakSet`.
Admin services take a proof and call `assertAdminProof`, so a route that skips
the gate does not compile, and a cast literal or spread copy throws. The brand
alone would not do: it is erased at runtime and an `as AdminProof` passes every
type check. `src/lib/admin-session.ts` (`requireAdminSession`) only wraps the
resolver for Next, turning `not_found` into `notFound()` and `sign_in` into a
redirect, and caches per request.

**Every page in the gated tree calls `requireAdminSession` itself,** not only the layout.
App Router renders a layout and its page concurrently, so the layout's redirect
does not stop the page's data fetch. The layout's call is the user-facing
redirect; the page's is the one that guards the data. Pages render dynamically.

**Sign-in.** `/admin/sign-in` offers one passkey button and no email field and
uses the ordinary `/api/auth/passkey/authenticate/*` routes, which answer on
any host. `getExpectedOrigin()` (`src/lib/auth/passkey.ts`) returns an array of
the app origin and the admin origin when `ADMIN_HOST` is set, and one origin
otherwise. Production sets `PASSKEY_RP_ID` to the parent domain (the
registrable domain of both hosts), so a passkey registered on the main site
signs in on the admin host. Sign-out is `SignOutButton` with `redirectTo`
`/admin/sign-in`.

**What the host split buys, and what it does not.** It buys host-only session
cookies (no `Domain` attribute), so the browser never sends the admin cookie to
the main host or the reverse; a test pins the absence of `Domain`. It does not
buy protection against a stolen session token, which a client can present on
either host: the recency window bounds that. The two hosts are same-site and
cross-origin, so `SameSite` does not separate them and a script on one can make
a credentialed request to the other; CORS keeps it from reading the response,
and `crossOriginRefusal` (`src/lib/cross-origin.ts`) refuses a write through its
`host-mismatch` branch, not `sec-fetch-cross-site`, since the browser sends
`Sec-Fetch-Site: same-site`.

**Testing, and the local limit.** Chrome refuses the WebAuthn ceremony on
`admin.localhost` (`The RP ID "localhost" is invalid for this domain`), so the
admin passkey sign-in cannot complete locally. Production, with
`PASSKEY_RP_ID` set to the parent domain and the admin host a subdomain of it,
is the ordinary registrable-parent case. Tests therefore seed a session as the
ceremony would leave it (a session bound to the grantee's passkey credential):
`seedPasskeySession` in `tests/admin-fixtures.ts` for unit tests, and
`tests/e2e/admin/admin-dashboard.spec.ts` for the browser, whose `admin`
Playwright project runs against the admin host.

That the registration and the authentication verifiers accept the admin origin
is pinned by the passkey unit test (`src/lib/auth/passkey.test.ts`, the
admin-origin blocks). The first real sign-in is the post-deploy smoke test in
`DEPLOYMENT.md` (Admin access).

**The dashboard.** `getPlatformCounts` (`src/services/admin-metrics.ts`) returns
aggregates only (no names, addresses or emails) from one `RepeatableRead`
transaction, since a batch at Read Committed gives each statement its own
snapshot. The service returns the parts and no total field, so a total cannot disagree
with them.

## Database

### Where Prisma comes from (#884, #886, #888)

The client is generated by the `prisma-client` generator into
`src/generated/prisma` (gitignored; `prisma generate` writes it, and the
`postinstall` and the Dockerfile's build and migrate stages run that).
`generator client` in `prisma/schema.prisma` writes `moduleFormat = "cjs"` and
`runtime = "nodejs"` out. The package is not `"type": "module"`, and the
default ESM output opens with
`globalThis['__dirname'] = path.dirname(fileURLToPath(import.meta.url))`, a
process-wide global pointing at the output directory for every other module in
the process; the `cjs` output uses the module's own `__dirname`. With the client engine
(below) the output carries no `*.node` engine; what the client loads at run
time comes from installed packages, which the standalone trace copies into
the runner image, so `next.config` needs no `outputFileTracingIncludes`.

`src/lib/prisma-client.ts` and `src/lib/prisma-enums.ts` import the output,
and no other module in `src`, `tests` or `scripts` does (re-derive:
`git grep -ln "generated/prisma" -- src tests scripts ':!src/generated'`; the
hits besides those two are the tests and the vitest seam described below):

- `src/lib/prisma-client.ts` re-exports `../generated/prisma/client`, so
  `Prisma`, the model types and the enums come from `@/lib/prisma-client`. It
  exports `PrismaClient` as a type only. `createPrismaClient` there is
  therefore the one place a TypeScript module constructs a client:
  `new PrismaClient()` anywhere else is a compile error (TS1362 for a named
  import, TS2339 through a namespace import). The CommonJS client probe,
  `scripts/prisma-client-probe.cjs`, constructs no client; it boots the built
  server (`docs/supply-chain.md`, "Prisma's engine in the images"). `@/lib/db` is the app singleton built from the
  factory; tests, scripts and the seed call it for clients of their own, and
  each call is a new pool. The specifier is relative because the migrate image
  copies this file without a `tsconfig.json` to resolve `@/`.
- `src/lib/prisma-enums.ts` re-exports `../generated/prisma/enums` and nothing
  else. It exists for client-reachable code: `src/lib/schemas.ts` is imported
  by client components and value-imports enums. The generated client has no
  `browser` field to swap in a browser build, so a client-reachable value
  import of `@/lib/prisma-client` pulls the Prisma runtime into the client
  bundle and `next build` panics with
  `the chunking context (unknown) does not support external modules (request: node:module)`.
  `enums.ts` imports nothing, so `prisma-enums.ts` is safe there, and on the
  server both modules hand back the same module, so an enum object has one
  identity. The generated `browser.ts` is not used: it exports a browser
  `Prisma` namespace whose `Decimal` is a different class from the server's.
  Server-only code, and anything that needs a type, imports
  `@/lib/prisma-client`.

Lint (`@typescript-eslint/no-restricted-imports`, `eslint.config.mjs`) holds
this: `@prisma/client` and every subpath of it are refused everywhere, and the
generated output (`@/generated/*`, `**/generated/prisma`,
`**/generated/prisma/*`) and the pool's packages (`pg`, `pg/*`,
`@prisma/adapter-pg`, #885) are refused everywhere except the modules in the
rule's `ignores`, which are those two. `prisma-enums.ts` is exempt from the
pool group too; its import pin (below) is what keeps the pool out of it.
Type-only imports are included. It does not see an inline
`import('@prisma/client')` type query or a dynamic `import()` expression,
neither of which is an import declaration. The rule covers every `.ts`,
`.tsx` and `.mts` file outside the config's global ignores, and `src/generated`
is among the global ignores, so the rule never sees the generated files.

No TypeScript module imports the package. Besides `prisma-client.ts` and
`prisma-enums.ts`, the vitest
seam names the generated client module: `vi.mock('../../src/generated/prisma/client')`
in `tests/setup/undefined-filter-guard.ts`, with its `vi.doUnmock` counterpart
in `src/lib/e2e-prisma-factory.test.ts`. The mock names the generated client
module because that is the module the factory constructs `PrismaClient` from;
a mock left on any other specifier no longer reaches it.
`src/lib/prisma-client.test.ts` pins both modules' imports ("prisma funnel
imports") and asserts that they return the same enum object. Every remaining mention of
the package is listed by `git grep -n "@prisma/client" -- ':!docs'`.

`next build` bundles the generated client and `@prisma/adapter-pg`. The
externals it leaves are `@prisma/client/runtime/client`, the query compiler's
`@prisma/client/runtime/query_compiler_fast_bg.postgresql.js` and
`…/query_compiler_fast_bg.postgresql.wasm-base64.js` (re-derive:
`grep -rhoE '@prisma/client[^"]*' .next-build/server --include='*.js' | sed -E 's/-[0-9a-f]{16}//' | sort -u`),
and `pg`, as a hashed external linked from `.next-build/node_modules/`. Next
externalises `pg` and `@prisma/client` by default, so the config sets no
`serverExternalPackages`, and there is no `export *` warning over a CommonJS
external. The image therefore carries `pg` with the packages it
depends on, the client runtime and the query compiler's files, and no Prisma `*.node`; the commands that show it,
and what the runner probe proves, are in `docs/supply-chain.md` ("Prisma's
engine in the images").

The Prisma 7 upgrade (#889) changes the `createPrismaClient` factory in
`src/lib/prisma-client.ts` and the schema's generator and datasource blocks,
plus the probe.

**The engine and the pool (#885).** The generator declares
`engineType = "client"`: queries are planned by Prisma's TypeScript client
engine (its query compiler) and run through the `@prisma/adapter-pg` driver
adapter, which owns a `pg.Pool`. `createPrismaClient` builds
`new PrismaClient({ adapter: new PrismaPg(pool, { onPoolError, onConnectionError }), transactionOptions: transactionOptionsFor(pool), errorFormat, log })`
with `pool = poolConfigFor(options)`; `transactionOptionsFor` sets the
client's default `maxWait` a margin past the pool bound ("Database errors").
`PrismaPg` drops an error on an idle or transaction-held connection with only
a `debug` line unless given those two hooks; `src/lib/db.ts` logs both at
`error`. The factory never passes `datasources` or `datasourceUrl`: Prisma 7
has neither option. The connection string reaches the pool through
`poolConfigFor`, so a different database or a startup parameter
(`lowStackClient`'s `options=-c max_stack_depth=…`) travels in the `url`
option.

`PrismaClientFactoryOptions`, all optional:

| Option | pg setting | Omitted |
|---|---|---|
| `url` | `connectionString` | `DATABASE_URL`, read when the client is built |
| `poolMax` | `max` | `DEFAULT_POOL_MAX` |
| `connectionTimeoutMs` | `connectionTimeoutMillis` | `DEFAULT_CONNECTION_TIMEOUT_MS`, 10 000 |
| `errorFormat` | (Prisma's) | Prisma's default |
| `log` | (Prisma's) | none |
| `onPoolError` | `PrismaPg`'s `onPoolError` | the adapter drops the error |
| `onConnectionError` | `PrismaPg`'s `onConnectionError` | the adapter drops the error |

`poolConfigFor` is the pure half: it returns the pool config without opening
anything, so the defaults are unit-tested on their own
(`src/lib/prisma-client.test.ts`, `poolConfigFor`).

- **`DEFAULT_POOL_MAX` is `os.availableParallelism() * 2 + 1`.** Prisma's own
  pool used physical cores × 2 + 1, and Node exposes no physical-core count.
  Where a CPU has no SMT, logical equals physical and the two agree; on SMT
  hardware the stand-in gives a larger pool. Connections open lazily, but one
  opened stays until the idle timeout below.
- **Production: 9.** The host is a Hetzner CAX21, 4 Ampere Arm vCPUs, and
  those have no SMT, so 4 × 2 + 1 = 9. This is derived from the host's
  published spec, not measured on the host; `docker-compose.prod.yml` sets no
  CPU limit (`grep -n -i cpu docker-compose.prod.yml` prints nothing).
  Re-derive on the server:
  `docker compose -f docker-compose.prod.yml exec app node -e "console.log(require('os').availableParallelism())"`
  must print `4`.
- **One pool for the whole process, production included (#933).** A
  production build evaluates `src/lib/db.ts` once per bundle entry:
  instrumentation (the scheduler), the route layer and the page layer, three
  evaluations measured on 2026-10-29. `db.ts` holds the client on
  `globalThis.__fairYogaPrisma`, so the first evaluation builds it and every
  later one reuses it, and the scheduler, routes and pages share one pool of
  `DEFAULT_POOL_MAX`. A sweep burst therefore waits
  on the same pool as requests; `connectionTimeoutMs` (below) bounds that
  wait and `pool_exhausted` reports it. Measured on a local production build
  with the pool pinned to 9: 20 concurrent cron sweeps beside 10 sequential
  `GET /api/health` held the database at 9 connections and logged no
  `pool_exhausted`; the slowest health check took 47–68 ms under that load
  against 37–71 ms idle, so no slowdown was distinguishable, on a small
  dataset.
  Re-derive: put a temporary
  `console.log('db.ts eval', globalThis.__fairYogaPrisma !== undefined)` at
  the top of `db.ts`, `pnpm run build`, `next start`, load a page and call an
  API route; every line after the first must print `true`.
- **`connectionTimeoutMs` bounds two waits with one knob**: waiting for a
  pooled connection, and establishing a new one (pg-pool hands its options to
  each `Client`). The 10 s default is Prisma's former `pool_timeout`. An
  unreachable host therefore takes up to 10 s to fail. A wait for a pooled
  connection past the bound fails with pg-pool's wait timeout, which
  `transientDbFailure` classifies `pool_exhausted` (`src/lib/api-errors.ts`);
  a new connect past it fails with pg-pool's connect timeout, `connection`. An interactive transaction can
  instead end as `P2028` (`tx_budget`); which wait ends as which kind is
  under "Database errors" (Transient kinds).
- **`idleTimeoutMillis` is 300 s, fixed.** It matches the idle lifetime of
  Prisma's former pool, and keeps a `poolMax: 1` client on one backend between
  statements, which the lock-order tests rely on when they identify their
  backend once by `pg_backend_pid()`. pg's 10 s default would reopen
  connections often and could change that backend mid-test.
- **`allowExitOnIdle` is `true`, fixed.** pg-pool's idle sockets otherwise
  hold the event loop for the whole idle timeout, so a `tsx` script, vitest
  worker or Playwright process that ends without `$disconnect()` would linger
  for up to five minutes. It only unrefs idle clients and closes nothing, so
  a single-connection client keeps its backend. The production server is held
  open by its HTTP listener anyway. Pinned by `prisma-client.test.ts`'s "a
  client left connected does not hold a finished process open".
- **`$connect()` connects nothing.** On the client engine it resolves without
  opening a connection (against a refused port it resolves; the first query
  is what fails). A test that called it to keep connection setup out of a
  timing window runs a `SELECT 1` instead, as `handoff.test.ts` does.
- **A raw query's JS `Date` is bound untyped.** The adapter sends it as a
  zone-less string of its UTC wall-clock time (`2026-08-15 00:00:00` for
  `2026-08-15T00:00:00Z`) with no type, so Postgres resolves it from its
  context. Against a `date` it is that UTC date, so `e.date > ${today}` is
  `date > date` in every session `TimeZone` (`archiveOrUnarchiveTemplate`'s
  pre-lock relies on lock ⊇ delete, which this makes an equality). Read as a
  `timestamptz` it is taken in the session `TimeZone`: the same instant only
  while the session runs UTC, which production's and CI's `postgres:16-alpine`
  do by default. Where nothing fixes its type (`SELECT ${date} IS NULL`) it
  fails `42P18` (`could not determine data type of parameter`); a bare
  `SELECT ${date}` resolves to `text` (`SELECT pg_typeof(x) FROM (SELECT
  ${date} AS x) s`). Measured 2026-10-29 on 7.10.1 with `SELECT
  ${date}::text`, `'2026-08-15'::date > ${date}` and `SELECT
  ${date}::timestamptz::text` under `SET LOCAL TimeZone` = UTC,
  `America/New_York` and `Asia/Tokyo` (`$queryRaw` inside a transaction, on the
  test database).
- **A missing or empty URL throws at construction**:
  `createPrismaClient: no url given and DATABASE_URL is not set`. pg would
  read an empty `connectionString` as "libpq defaults" (localhost as the OS
  user) rather than refuse. A `poolMax` or `connectionTimeoutMs` that is not
  a positive integer throws `RangeError`: pg reads a `connectionTimeoutMillis`
  of 0 as "wait forever", which the `maxWait` derived from it cannot mirror.

Nothing in the client loads `.env`. Next, vitest (`vitest.config.ts`),
Playwright (`playwright.config.ts`) and the Prisma CLI (`prisma.config.ts`)
load it themselves, and a `tsx` entry point that constructs a client imports
`dotenv/config` first; without it `createPrismaClient` throws the missing-URL
error above.

### How the CLI gets its config and URL (#887)

The Prisma CLI gets its configuration from `prisma.config.ts` at the repo root
(`schema`, `migrations.path`, `migrations.seed`), and its URL from
`DATABASE_URL`. The file loads `.env` through `dotenv/config`, which is a
silent no-op when there is none and never overrides a variable already set, so
an explicit `DATABASE_URL` (CI, `src/lib/db-provision.ts`, compose) wins over
`.env`. With the variable set, the file passes it as the datasource URL; with
it unset, it adds no datasource (the schema's `datasource` block carries no
`url`, which Prisma 7 refuses there). So `prisma generate` (the
`postinstall`, which can run before any `.env` exists: a fresh clone's
install, the image's `deps` stage) still works and a command that needs a URL
fails with "The datasource.url property is required in your Prisma config file". The
`env()` helper from `prisma/config` is not used because it throws while the
config loads, and every command loads it, `generate` included.
`src/lib/prisma-config.test.ts` drives the real CLI for the `.env`-only case,
the explicit-env-wins case, the no-URL `generate` case and the no-URL refusal
case.

Run the Prisma CLI from the repo root. The config is found only in the working
directory; from elsewhere it is not loaded and `db seed` exits 0 without
seeding (measured: `cd src && pnpm exec prisma db seed --schema
../prisma/schema.prisma` exits 0 and seeds nothing). pnpm scripts and CI run
from the root.

### Database errors

`src/lib/pg-error.ts` is the one module that knows where the pg driver adapter
(`@prisma/adapter-pg`) puts Postgres's fields. Every read of a SQLSTATE or a
constraint name goes through it, and the SQLSTATE always comes from a
structured field. What remains of Prisma's framing is its own codes
(`P2002`, `P2025`, `P2028`, `P2034`), matched on the typed
`PrismaClientKnownRequestError` only. So a raw call's `23505`, which arrives
as `P2010`, meets no `P2002` check: `classifyApiError`'s 409 `UNIQUE_CONFLICT`
fallback answers a typed `P2002` only, and a raw `23505` that escapes its
route answers 500 by design.

**`pgErrorOf(err)`** answers a `PgError` (`sqlState`, `message`, optional
`constraint`) or `null`. It is shallow: it reads `err` itself and never
follows `Error.cause`; a caller that walks a chain calls it once per link. It
finds the adapter's cause object on exactly one of two paths:

1. `err` is an `Error` whose `name` is `'DriverAdapterError'` (identified by
   name, never by import) and whose `cause` is an object → `err.cause`. An
   interactive transaction's `COMMIT` throws one bare when a reset cuts it in
   flight
   (`kind: 'ConnectionClosed'`, produced in
   `src/lib/db-connection-drop.test.ts`); no statement measured under 7.10.1
   does.
2. `err` is a `Prisma.PrismaClientKnownRequestError` whose
   `meta.driverAdapterError` is an object named `'DriverAdapterError'` with an
   object `cause` → that `cause`.

From the cause it requires `originalCode` to be a string matching
`/^[0-9A-Z]{5}$/` and `originalMessage` to be a string; otherwise `null`. The
adapter sets both from pg's `DatabaseError` (`code`, `message`) before any
per-code mapping, so they exist for every Postgres-originated error whatever
`kind` it gets. A cause with no `originalCode` — one the adapter builds
without a Postgres error, such as `DatabaseNotReachable` — has no SQLSTATE and
answers `null`. There is no `detail` field: it carries row
values (`Failing row contains (…)`, `Key (…)=(…)`) and nothing reads it.

The shapes it reads, measured on the client engine plus the pg adapter
(C+A), Prisma 7.10.1, on 2026-10-27. Source: the adapter's `convertDriverError`
and `mapDriverError` in
`node_modules/.pnpm/@prisma+adapter-pg@7.10.1/node_modules/@prisma/adapter-pg/dist/index.js`.
Where each row is produced against the real database:
`src/lib/db-transient-shapes.test.ts` and `src/lib/pg-error.test.ts` for the
SQLSTATE rows, the `P2028` rows, and the pool wait behind an
interactive-transaction holder, with `db-transient-shapes.test.ts` also
producing `57P01` (`pg_terminate_backend` on the backend of a throwaway
single-connection client, mid-statement) and `53300` (a role created with `CONNECTION LIMIT 0`);
`src/services/sweep-page-ceiling.test.ts` for `P2029` and for `54001`;
`src/lib/prisma-client.test.ts` for the connect timeout and `ECONNREFUSED` on
all three paths (raw, model, interactive transaction);
`src/lib/db-connection-drop.test.ts` for the dropped-connection rows, through a
`net` relay between a throwaway client and the database that is cut, by ending
its sockets or resetting them, mid-statement on all three paths and around an
interactive transaction's `COMMIT`. The produced connection rows were measured
on 2026-10-29. No test produces the `P2025` row, the pool wait behind
a raw holder, or the `ENETUNREACH` / `EHOSTUNREACH` rows; those were measured
once, on 2026-10-27, and are not re-checked. `57P02` / `57P03` and
`ETIMEDOUT` are read from source only on every path, and `57P01`
on its typed path. `57P02` and `57P03` are never produced because a crash
restart and a starting-up server would disturb the shared database container
(they take the same `postgres`-kind path `57P01` proves); `ETIMEDOUT` is read
from the adapter's `mapSocketError` and the client
runtime's kind→code switch, as is `ENOTFOUND`, which `mapSocketError` maps to
the same `DatabaseNotReachable` as `ECONNREFUSED`.

| What failed | Thrown | Where the adapter's error sits | `kind` | Fields present |
|---|---|---|---|---|
| Unmapped SQLSTATE on a typed call (`23514`, `23P01`, `55P03`…) | `PrismaClientKnownRequestError` `P2039`, `meta {modelName, driverAdapterError}` | `err.meta.driverAdapterError.cause` | `postgres` | `originalCode`, `originalMessage`, `code`, `severity`, `message`, `detail?`, `column?`, `hint?` |
| Same SQLSTATE on a raw call, and `54001`, `57014`, which only raw calls here raise | `PrismaClientKnownRequestError` `P2010` | `err.meta.driverAdapterError.cause` | `postgres` | as above |
| `23505` (typed `P2002`, raw `P2010`) | Known | `meta.driverAdapterError.cause` | `UniqueConstraintViolation` | `originalCode`, `originalMessage`, `constraint` (`{index}` when pg names the constraint, else `{fields}`), `table`; **no `message`** |
| `23503` (typed `P2003`, raw `P2010`) | Known | `meta.driverAdapterError.cause` | `ForeignKeyConstraintViolation` | `originalCode`, `originalMessage`, `constraint.index`; no `message` |
| `40001` or `40P01` (typed `P2034`, raw `P2010`) | Known | `meta.driverAdapterError.cause` | `TransactionWriteConflict` | `originalCode` (`'40001'` or `'40P01'`), `originalMessage`; **no `code`** |
| `P2025` | Known | none | — | `meta {modelName, operation}` |
| `P2028` budget expired | Known | none | — | `meta {modelName, operation, timeout, timeTaken}` |
| `P2028` `maxWait` exceeded | Known | none | — | `meta {}` |
| Pool wait exceeded `connectionTimeoutMillis` (`$queryRaw`, `$executeRaw`, a model call, a batch `$transaction([…])`, each behind a raw or an interactive-transaction holder) | plain `Error('timeout exceeded when trying to connect')`, own key `clientVersion` only | none | — | — |
| Over 32,766 parameters in one statement Prisma does not split, or a composite relation load of 16,383 parents or more, refused before it is sent | `PrismaClientKnownRequestError` `P2029` | none | — | — |
| Connect exceeded `connectionTimeoutMillis` | plain `Error('Connection terminated due to connection timeout')`, enumerable own key `clientVersion` only, non-enumerable own `cause` pg's `Error('Connection terminated unexpectedly')` | none | — | — |
| `ENETUNREACH` / `EHOSTUNREACH` (raw, model) | Known, `code: 'ENETUNREACH'` | none | — | — |
| Same, inside an interactive transaction | the raw pg `Error`, `code: 'ENETUNREACH'` | — | — | — |
| `ECONNREFUSED`, and `ENOTFOUND` (read from source) | raw: `P2010`; model: `P1001` with `meta {modelName, driverAdapterError}`; inside an interactive transaction: `P1001` with `meta {driverAdapterError}` | `meta.driverAdapterError.cause` | `DatabaseNotReachable` | `host`, `port`; no `originalCode` |
| `53300` (typed `P2037`, raw `P2010`) | Known | `meta.driverAdapterError.cause` | `TooManyConnections` | `originalCode`, `originalMessage`, `cause` (the primary message again); no `code` |
| `57P01` (typed `P2039`, raw `P2010`; raw produced, typed read from source) | Known | `meta.driverAdapterError.cause` | `postgres` | as the unmapped-SQLSTATE row, `severity: 'FATAL'` |
| `57P02`, `57P03` (read from source) | as `57P01` | `meta.driverAdapterError.cause` | `postgres` | as `57P01` |
| The server ends the socket mid-statement (raw, model, interactive transaction) | plain `Error('Connection terminated unexpectedly')` (pg's `client.js`), enumerable own key `clientVersion` only; no `code`, no `cause` | none | — | — |
| The socket resets mid-statement (`ECONNRESET`) | Known: model `P1017`, raw and inside an interactive transaction `P2010` | `meta.driverAdapterError.cause` | `ConnectionClosed` | `kind` only; no `originalCode` |
| An interactive transaction's `COMMIT`, cut by a reset while in flight | bare `DriverAdapterError`, own `name`, `cause` | `err.cause` | `ConnectionClosed` | `kind` only (**the write landed**) |
| `COMMIT` in flight when the server ends the socket | plain `Error('Connection terminated unexpectedly')`, **no** enumerable own key; no `code`, no `cause` | none | — | — (**the write landed**) |
| `COMMIT` after pg has handled the end or reset (either cut) | plain `Error('Client has encountered a connection error and is not queryable')` (pg's `client.js`), no enumerable own key; no `code`, no `cause` | none | — | — (nothing lands). **Not classified: a 500** |
| `COMMIT` racing pg's handling of the cut (observed, not pinned: the winner differs by platform) | macOS: a bare `DriverAdapterError` `ConnectionClosed` on an end, plain `Error('write EPIPE')` (`code`, `errno`, `syscall: 'write'`) on a reset; Linux CI, 2026-10-29: a plain `Error` on an end, the bare `ConnectionClosed` on a reset | — | — | nothing lands. `EPIPE` stays a 500 by design, since a bare `EPIPE` can come from any socket, not only the database's |
| `ETIMEDOUT` (read from source) | Known: model `P1008`, raw `P2010` | `meta.driverAdapterError.cause` | `SocketTimeout` | `kind` only; no `originalCode` |

So a `40001` or a `40P01` is recognised by `originalCode` on both its typed and
its raw shape (`code` is absent on both), and the primary message is `originalMessage`,
which every kind carries, not `cause.message`, which only `postgres` does.

**`constraint`** comes from `CONSTRAINT_SOURCE`, keyed by SQLSTATE and typed
`satisfies Record<'23503' | '23505' | '23514' | '23P01', …>`, so a SQLSTATE
cannot be added without saying where its name comes from:

| SQLSTATE | Source | Read |
|---|---|---|
| `23503` | structured | `cause.constraint.index` (a string). Absent → no `constraint`; the adapter writes `{fields: [column]}` instead only when pg sets `column`, which Postgres does not for a foreign-key violation |
| `23505` | structured, then Postgres's primary message | `cause.constraint.index` (a string); absent → `/^duplicate key value violates unique constraint "([^"]+)"$/` on `originalMessage` |
| `23514` | Postgres's primary message | `/ violates check constraint "([^"]+)"$/` on `originalMessage`. A terminality trigger's own text never matches, so a trigger raise has no `constraint` |
| `23P01` | Postgres's primary message | `/^conflicting key value violates exclusion constraint "([^"]+)"$/` on `originalMessage` |

The `23514` and `23P01` names have no structured carrier: their `postgres`
cause carries no `constraint` (`mapDriverError`). `23505` has one. The
adapter writes `{index}` whenever pg's `DatabaseError` names the constraint,
and Postgres names the index on every btree unique violation, expression and
partial indexes included. When pg names none, the adapter writes
`{fields}` parsed from `detail` instead. So a unique violation on any
`UNIQUE_CONSTRAINTS` member (`src/lib/unique-conflict.ts`) is named from a field no locale touches, and the
message is read only when `index` is absent. That happens if the adapter stops
writing `index`, or for a `23505` that names no constraint, which only a hand
raise produces, and no migration here has one
(`grep -rn "23505\|unique_violation" prisma/migrations` finds none).
`src/lib/pg-error.test.ts` pins every `23505` its real-DB cases produce
(single-column, composite, and expression partial indexes) to carrying
`{index: name}` and to keeping its name under a localised message, so that
regression reddens a test rather than reopening the exposure below. The
primary message is Postgres's own text, and the clauses are anchored, so free
text that merely quotes a clause (a template name, a trigger's message) names
no constraint.

**Locale and Postgres major.** The message clauses are Postgres's English
primary messages. A server with a non-English `lc_messages` localises them,
and every `23514` and `23P01` name match misses, as would a `23505` reaching
the fallback: the 409s they back become 500s. The production
image and CI's run the default (English) locale, and the real-DB tests run
against that image, so a locale change in test infrastructure reddens them. A
Postgres major-version bump has the same exposure: if the next major rewords
one of those messages, every name match on it misses in production. The
real-DB tests catch that only if CI runs the image production runs. The
service-image check (`src/lib/service-image-check.ts`; `docs/supply-chain.md`,
"The database image") enforces that pins of one tag agree on one digest, but it
groups by tag and a major bump changes the tag. **So a Postgres major bump
moves production and CI together, in one PR.**

**`isPgPoolTimeout(err)`** is true when `err` is an `Error` whose `message` is
exactly `PG_POOL_TIMEOUT_MESSAGE` (`'timeout exceeded when trying to
connect'`), with no own `code` and no Postgres error on it. That literal is
pg-pool's, matched here only; re-derive it with
`grep -n "timeout exceeded when trying to connect" node_modules/.pnpm/pg-pool@*/node_modules/pg-pool/index.js`.
`src/lib/pg-error.test.ts` reads the same file, so a pg-pool rewording reddens
a test.
`isPgConnectTimeout` applies the same rules to `PG_CONNECT_TIMEOUT_MESSAGE`
(`'Connection terminated due to connection timeout'`); re-derive it with
`grep -n "Connection terminated due to connection timeout" node_modules/.pnpm/pg-pool@*/node_modules/pg-pool/index.js`,
and `pg-error.test.ts` pins it the same way.
`isPgConnectionTerminated` applies them to `PG_CONNECTION_TERMINATED_MESSAGE`
(`'Connection terminated unexpectedly'`, pg's text for a socket that ended
while the client was not ending it); re-derive it with
`grep -n "Connection terminated unexpectedly" node_modules/.pnpm/pg@*/node_modules/pg/lib/client.js`,
and `pg-error.test.ts` pins it the same way.

**Transient kinds.** `transientDbFailure` (`src/lib/api-errors.ts`) decides
the `TransientKind` link by link along `Error.cause`, from structured fields
only: first the SQLSTATE `pgErrorOf` reads (`55P03` → `lock_timeout`, `40P01`
→ `deadlock`, `40001` → `serialization`, and `53300`, `57P01`, `57P02`,
`57P03` → `connection`), then Prisma's code (`P2028` →
`tx_budget`, `P2034` → `deadlock`: that code means a `40001` or a `40P01`,
and only one with no SQLSTATE reaches this step, so it takes the kind that
logs at `error`), then the adapter's `kind` that `adapterKindOf` reads
(`DatabaseNotReachable`, `ConnectionClosed`, `SocketTimeout` and
`TooManyConnections` → `connection`; keyed on the kind rather than the Prisma
code because a raw call carries all four as `P2010`), then `isPgPoolTimeout` →
`pool_exhausted`, then `isPgConnectTimeout` → `connection`, then
`isPgConnectionTerminated` → `connection`. The only error text read is
pg-pool's and pg's exact messages (`PG_POOL_TIMEOUT_MESSAGE`,
`PG_CONNECT_TIMEOUT_MESSAGE`, `PG_CONNECTION_TERMINATED_MESSAGE`), each pinned
to the driver's source by `src/lib/pg-error.test.ts`, so a message quoting a
SQLSTATE is never relabelled transient. `P2024` is in no map: on the client engine with
the adapter a pool wait arrives as pg-pool's plain `Error`, never as `P2024`.
Every kind is produced against the real database, typed and raw where both
are reachable, in `src/lib/db-transient-shapes.test.ts` and, for
`ECONNREFUSED` and the connect timeout, `src/lib/prisma-client.test.ts`, and,
for a connection dropped mid-query, `src/lib/db-connection-drop.test.ts`; within
`connection`, `57P02` / `57P03`, `ETIMEDOUT` and `ENOTFOUND` are
matched from source only on every path, and `57P01` on its typed path (see the
shape table). The connect timeout carries pg's termination error as its
`cause`, so both depths match; the walk stops at depth 0, and the answer is
the same `connection` either way. The dropped-connection shapes left a 500 are
pg's not-queryable error and `write EPIPE`, both on a `COMMIT` that never
reached the server; the shape table says why. A `connection` failure never
reaches a service's `busy` arm, whose copy says nothing was changed: a
connection lost mid-`COMMIT` was measured to have applied the write on both
cuts, so the service rethrows it to `classifyApiError`, which answers the
`connection` 503 and its copy, which says the request may not have gone
through. Of `classifyApiError`'s transient 503s, only `connection`'s carries a
code, `DATABASE_CONNECTION_FAILED`, because every other kind rolled back. A
client that reads an app-written 503 as "nothing happened" must route this
code to its outcome-unknown state instead; re-derive the clients that do with
`grep -rln DATABASE_CONNECTION_FAILED src/app src/components --exclude='*.test.*'`.
A route that maps a transient failure itself keeps its own code for this case:
`erasureFailure` (`src/app/api/account/route.ts`) answers it as `ERASURE_BUSY`
/ `PARTIAL_ERASURE_BUSY` with copy saying the account may not have been
removed. Any `connection` 503 routes there, including one refused before a
statement ran (a connect timeout, `ECONNREFUSED`, `53300`), which errs toward
"couldn't confirm" over "nothing happened".

What `pool_exhausted` covers, measured there on 2026-10-27 (`poolMax: 1`, the
one connection held by an interactive transaction): any call whose wait for a
pooled connection outlives `connectionTimeoutMs`. That is a model call, a
`$queryRaw`, a batch `$transaction([…])`, **and an interactive transaction**
that runs on the client's default `maxWait`.
Prisma's `maxWait` is a real deadline: it fires at its own time whether or not
a connection has arrived, so a `maxWait` equal to the pool bound races
pg-pool's timeout and the race went to `P2028` (6 of 6 runs), which logs at
`warn` where the pool timeout logs at `error`.

So `createPrismaClient` sets the client's default `maxWait` a margin
(`MAX_WAIT_MARGIN_MS`) past the pool bound (`transactionOptionsFor`), and
pg-pool's wait is the one bound a waiting interactive transaction meets. Under
pool saturation its 503 arrives at the pool bound (10 s by default), as
`pool_exhausted` at `error`. A transaction that acquires its connection inside
the bound proceeds: `src/lib/prisma-client.test.ts` tests it with a connection
freed at 2.5 s, past Prisma's own 2 s default and inside a 4 s pool bound.

An explicit `maxWait` below the pool bound always wins, at its own deadline,
as `P2028` with `meta {}`, `tx_budget` at `warn`; `db-transient-shapes.test.ts`
measures it (`maxWait: 300`, pool bound 5 s, connection freed at 1.5 s →
`P2028` after about 300 ms, well before 1.5 s).

An expired transaction budget (`timeout`) is a different
`P2028`, with `meta.timeout` and `meta.timeTaken`, also `tx_budget`.

**`adapterKindOf(err)`** reads `cause.kind` from the same two paths, for the
log facet and `transientDbFailure`'s adapter-kind step, and answers a member of `ADAPTER_KINDS` or `undefined`. That
set is the runtime's `MappedError` kinds minus the other databases' (`mysql`,
`sqlite`, `mssql`). `MappedError` lives in `@prisma/driver-adapter-utils`,
which the repo does not depend on directly, so `src/lib/pg-error.test.ts`
tethers the set by reading that package's `index.d.ts`, resolved through
`@prisma/adapter-pg`. Re-derive it with
`sed -n '/^export declare type MappedError = {/,/^};/p' "$(dirname "$(node -p "require.resolve('@prisma/driver-adapter-utils', { paths: [require.resolve('@prisma/adapter-pg')] })")")/index.d.ts" | grep -oE "kind: '[A-Za-z]+'"`
and drop `mysql`, `sqlite` and `mssql`. A kind outside the set is not logged.

**What the log keeps of a database error.** `serializeErr`
(`src/lib/log-serializers.ts`) withholds the message of every Prisma query
error and of a `DriverAdapterError`, and lifts its facets through the two
readers above, never from text:

- `sqlState` is `pgErrorOf(err).sqlState`; `constraint` is its `constraint`
  when the name is `[A-Za-z0-9_]+`;
- `constraintUnparsed: true` when `sqlState` is one whose name
  `CONSTRAINT_SOURCE` can read from the primary message, alone or as the
  fallback (`namesConstraintInMessage`), and none was found, and no `trigger`
  was recognised either. It is the operator's signal for the exposure in
  "Locale and Postgres major": a localised or reworded message, where every
  name match on that SQLSTATE misses. On a `23505` it also means the
  structured `index` was absent, which no `23505` the real-DB cases above
  produce is. A `23514` raised by a trigger outside
  `TERMINAL_TRIGGER_TAILS` (the currency guards) carries it too, since its
  message names no constraint; on a `23514` it therefore means "neither a
  constraint nor a known trigger";
- `trigger` and `rowIds` come from the Postgres primary message
  (`pgErrorOf(err).message`) of a `23514` that names no constraint, and never
  from `detail`;
- `adapterKind` is `adapterKindOf(err)`, emitted only where there is no
  `sqlState`;
- `txError` on a `P2028` is `expired` when `meta.timeout` and
  `meta.timeTaken` are both finite numbers and `other` otherwise, because
  nothing structured tells a `maxWait` refusal apart from any other `P2028`.

A withheld error's `cause` is walked only when it is an `Error`, so the
adapter's plain cause object under a `DriverAdapterError` is never reached
that way. Something can still log that object directly, or as the `cause` of
an error the serializer does not withhold (`new Error('…', { cause })`). Its
`message` is Postgres's primary message, and its `detail` is
`Failing row contains (…)`. So an object carrying a string `originalCode` or
`originalMessage` is withheld too, as `Driver adapter error (detail withheld
from the log)`, whether or not it has a `message` (a `23505` cause has none,
and would otherwise be passed through unserialized). Its `type` is
`DriverAdapterCause`, and its facets (`sqlState`, `constraint`,
`constraintUnparsed`, `adapterKind`) are lifted from the object itself through
`pgErrorOfCause` / `adapterKindOfCause`; the matchers never read a bare cause.

A typed call's error is a `PrismaClientKnownRequestError` (`constructor.name`
and `name` both `PrismaClientKnownRequestError`) with a `code` such as `P2039`.
Its stack begins `PrismaClientKnownRequestError: Invalid \`prisma.<model>.<op>()\`
invocation` followed by frames, and the serializer keeps only those frames.
`tests/integration/log-redaction.test.ts` pins this against the real database.

### PostgreSQL Configuration

Single PostgreSQL instance alongside the Next.js application. For a donation-funded app serving independent yoga teachers, this handles significant load before needing to scale.

**Estimated capacity on a 2GB VPS:** ~500 active teachers with their students comfortably. PostgreSQL connection pooling via Prisma. The main query patterns (class list for a teacher, registrations for a class, notifications for a user) are all simple indexed lookups.

### Key Indexes

```sql
-- Teacher schedule view (most frequent query). On "CalendarEntry" since
-- issue 327: both class families share one calendar table.
CREATE INDEX "CalendarEntry_teacherId_date_idx" ON "CalendarEntry" ("teacherId", date);

-- Student's upcoming bookings
CREATE INDEX idx_registration_student_status ON "Registration" (student_id, status);

-- Notification inbox
CREATE INDEX idx_notification_recipient ON "Notification" (recipient_type, recipient_id, is_read);

-- Waitlist processing
CREATE INDEX idx_waitlist_class_position ON "WaitlistEntry" (class_id, position);

-- Payment tracking
CREATE INDEX idx_payment_status ON "Payment" (status, created_at);
```

### Migrations

Prisma handles migrations. Every schema change produces a migration file that's committed to git. Migrations run automatically on deployment.

#### What the drift check enforces

CI's `Check schema/migration drift` step runs `prisma migrate diff
--from-config-datasource --to-schema … --exit-code` against a
database built by `migrate deploy`. It was added to catch a schema edit
committed without a migration, and it does. What it enforces is wider, and
that is a decision this project made (#329), not an accident of the tool:

> **Everything Prisma can model must be declarable in `prisma/schema.prisma`.**

Every hand-authored database object falls into one of three categories:

1. **Declarable.** Prisma models it and the schema can say so.
   `CalendarEntry.span` and `ScheduleRule.slot` are `Unsupported(...)` with
   `@default(dbgenerated())`: declared, so the two sides agree.
2. **Invisible.** Prisma does not model it, so the diff never sees it:
   every `CHECK`, every `EXCLUDE USING gist` constraint, every trigger and
   trigger function, and every partial or expression unique index
   (`Room_private_identity_unique`, `WaitlistEntry_waiting_position_key`).
   The same goes for an attribute Prisma does not read on an object it does:
   `DEFERRABLE INITIALLY DEFERRED` on a declared foreign key passes the
   check. These pass because Prisma cannot see them, which says nothing
   about whether they are right. The evidence for them is the tests that
   exercise them, and the seed step that runs right after the drift step.
3. **Visible but not declarable.** Prisma models the kind of object but the
   schema language cannot express the variant. The first case was #328's
   composite foreign key with PostgreSQL 15's column-list
   `ON DELETE SET NULL ("scheduleRuleId")`. **Such an object fails the
   check, and this repo does not ship one.**

Which category an object falls in is a fact about the pinned Prisma
version, not about PostgreSQL, so measure it rather than guess: apply the
object to a migrated scratch database and run the step's command against
it. Guesses have been wrong in both directions. #329 expected
`ON DELETE SET DEFAULT` and a `DEFERRABLE` foreign key to be category 3,
but the first is declarable (`onDelete: SetDefault`) and the second is
invisible. A Prisma upgrade can move an object between categories.

`20260829120000_entry_rule_kind_guard`'s header gives a different reason
the composite key was not used: that `ON DELETE SET NULL` would null every
referencing column, `kind` included. The column-list form above removes
that reason, and what remains is this check. The correction is recorded
here because the migration file is immutable.

**Why the check is not narrowed to its original purpose.** A
category-3 object and a genuinely unmigrated schema edit produce the same
diff. Measured on #329: #328's column-list foreign key applied to a
migrated database, and separately an `onDelete` change made in the schema
with no migration, each yield a `DropForeignKey` plus `AddForeignKey` hunk
on `CalendarEntry_scheduleRuleId_fkey` and exit 2. Nothing in the output
tells intent apart, so narrowing means allowlisting one constraint's exact
diff text: a frozen string that rots silently and weakens the check for
the whole repo to serve one object.

**The way out is category 2, and it has a price.** Express the rule as a
trigger instead, as `20260829120000_entry_rule_kind_guard` did for #328.
`CREATE CONSTRAINT TRIGGER … DEFERRABLE` is the form for a check that
must run at commit. A trigger standing in for
a foreign key does not get a foreign key's `FOR KEY SHARE` lock on the
referenced row, so its behaviour under concurrent writes has to be argued
rather than inherited. #328's argument is its second trigger:
`ScheduleRule.kind` is immutable, so the guard's unlocked read of it cannot
go stale, and the single-column foreign key still guarantees the row exists.
That argument is stated in the migration's own header. A new one belongs in
`docs/lock-order.md`, beside the lock arguments already there.

**When to revisit:** a category-3 object with no category-2 equivalent that
can be argued safe under concurrent writes. That is a concrete case to
measure a narrower check against, and it has not happened yet.

---

## Real-Time Updates

Server-Sent Events (SSE) for real-time notifications. Simpler than WebSockets, works through most proxies, and is sufficient for one-directional server-to-client updates (which is all we need — notifications flowing to the user).

```typescript
// API route: /api/notifications/stream
export async function GET(request: Request) {
  const session = await getSession(request);

  const stream = new ReadableStream({
    start(controller) {
      // Subscribe for whichever profiles the account holds — a dual-role
      // account hears both its teacher and student notifications.
      const unsubscribe = subscribeToNotifications(
        { teacherId: session.teacherId, studentId: session.studentId },
        (notification) => {
          controller.enqueue(`data: ${JSON.stringify(notification)}\n\n`);
        }
      );

      request.signal.addEventListener('abort', unsubscribe);
    }
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream' }
  });
}
```

A stream also ends when the server shuts down, so a deploy does not wait on it (Deployment, Shutdown).

---

## Cron Jobs

Every job skips a tick while its own previous run is still in flight, and from the second refused tick on it reads unhealthy (`STALLED_AFTER_SKIPPED_TICKS`, `src/lib/scheduler.ts`); Overlapping triggers, below, records which jobs were examined for a manual call overlapping a scheduled tick — a job it does not name was not examined. Each job's first run happens shortly after the Node server boots (15 seconds after the scheduler registers it, or one interval after it when the interval is no longer than that, as for the 10-second push job, which gets no separate 15-second run), then on its own `setInterval` (`src/lib/scheduler.ts`, wired from `instrumentation.ts`). The `/api/cron/*` endpoints remain for manual runs alongside the scheduler: `ls src/app/api/cron` lists them, and a job in the table below with no directory there — waitlist reconciliation and push dispatch — runs only on the scheduler. `CRON_SCHEDULER=off` is a CI setting, not a production mode (`DEPLOYMENT.md` §5). No tick starts once shutdown has begun (Deployment, Shutdown).

| Job | Schedule | What it does |
|---|---|---|
| Class transitions | Every minute | Advances open → in_progress, auto-cancels classes below min_students, auto-completes classes 15 minutes after their end |
| Email fallback | Every 5 minutes | Sends email for unread notifications older than 30 minutes, or on the next sweep regardless of age for a type in `IMMEDIATE_EMAIL_TYPES` (`src/services/notification-policy.ts`) |
| Class generation | Every hour | Extends recurring class and studio-class instances on the rolling 4-week window |
| Payment reminders | Every hour | Flips pending payments to overdue after 7 days, then reminds on overdue payments not reminded in the last 7 days |
| Class reminders | Every 5 minutes | Reminds registered students and the teacher of an open class at each one's chosen moment (`reminderMoment`, `src/lib/reminder-moment.ts`), in the inbox and/or by direct email — once, and never at or after the class's start |
| Daily cleanup | Daily | Purges expired sessions and auth tokens and ended handoff-code budgets, reaps closed waitlist entries past retention, deletes notifications past their type's retention period (`NOTIFICATION_RETENTION_DAYS`, `src/lib/notification-retention.ts`), deletes push subscriptions unused past `PUSH_SUBSCRIPTION_RETENTION_DAYS` (`src/services/push-subscription-retention.ts`), emails the operator the degradation events that are new or have fired again, and audits stored teacher timezones — failing the job if any teacher's zone is unresolvable or an offset identifier (`isValidTimeZone`) |
| Waitlist reconciliation | Every minute | Re-checks waitlists against freed seats — auto-promotes the next in queue, or broadcasts a first-come claim in the final hour before class start |
| Push dispatch | Every 10 seconds | Sends each committed `Notification` row with `pushHandledAt: null` to the recipient's subscribed devices where preference allows, and retires one older than `PUSH_STALE_AFTER_MS` (15 minutes) without sending (`src/services/push-dispatch.ts`); what a tick logs, how long it can run and when it alarms: Push dispatch, below |

### Push dispatch

Reads committed `Notification` rows with `pushHandledAt: null`, sends to the recipient's subscribed devices where preference allows, and retires (stamps `pushHandledAt` without sending) any row already older than `PUSH_STALE_AFTER_MS` (15 minutes) when this sweep reads it (`src/services/push-dispatch.ts`); a tick that retired a row, had a send come back `failed`, `gone` or `invalid`, or claimed rows it could not send (`unsendable`: `VAPID_*` is set but unusable) logs one `info` line with the tick's counts, and a tick that throws logs it too, with `faulted: true`, before rethrowing, so the rows it retired and the sends that happened before the fault leave a trace.

**Tick bound.** Four workers each claim a notification just before sending it, in parallel across its devices, and stop claiming `PUSH_CLAIM_DEADLINE_MS` (10 s) into the tick, so a tick ends within one send timeout (`DEFAULT_TIMEOUT_MS`, 5 s) of that: about 15 s plus the DB calls a worker makes after its last deadline check (the 5 s margin below the 20 s stall line absorbs them), under the 20 s that `STALLED_AFTER_SKIPPED_TICKS` (2) × the 10 s interval allows. A timeout burst of any size therefore stays healthy on the steady 10 s grid (the push job's first tick is the interval's, at 10 s; see Each job's first run above); the rows it did not reach are unclaimed and wait for the next tick (or are retired as stale after 15 minutes). `scheduler.test.ts` ("keeps a push tick shorter than the scheduler's stall line") re-derives the inequality from the constants.

**Post-send writes.** Sends hold no database connection while in flight; only the `pushSubscription` write after each verdict (`lastUsedAt` on a delivery, a delete on `gone` / `invalid`) takes one, so up to `PUSH_WORKERS` × `MAX_PUSH_SUBSCRIPTIONS_PER_ACCOUNT` writes can queue on the pool at once when every device answers together. Measured on a full fan-out (every device answering at the same instant, once all have been sent to) against warm pools of 1, 3 and 5 connections on a local database (the script sets each with the factory's `poolMax`; the default pool size and production's are in "Where Prisma comes from"), measured on Prisma's library engine before #885: the whole tick, its retire, read and claim statements included, took 30-100 ms past the sends at the median and 180 ms at worst over 20 ticks per row, and a single write took at most 76 ms at a pool of 3 or 5 and 153 ms at a pool of 1, so the fan-out uses under 4% of the 5 s margin even at a pool of 1. What can spend the margin is the pool being held by something else: with every connection occupied by another query for 2 s when the verdicts landed, each write waited about 2 s plus its idle-pool write time (the slowest was 2.08 s) at each pool size measured. The wait is the other holder's time and is bounded by the pool's `connectionTimeoutMs` (10 s by default), after which the write throws and is reported as that send's fault; so a pool starved that long can end a tick past the stall line, as it can any job whose claims and reads wait on the same pool. Coalescing a notification's writes into one statement would shorten the burst, not the wait, and was not done. Re-derive: `pnpm exec tsx --conditions=react-server --env-file=.env scripts/measure-push-fanout.ts` (a worktree's own database, with its dev server stopped: `pnpm run worktree:down`, since that server's scheduler would claim the script's rows).

**Degraded.** A tick that tried to send and delivered nothing (`sent === 0` with `failed > 0`, or any tick, claimed rows or not, while `VAPID_*` is set but unusable: the result's `misconfigured` carries the reason on every tick, so a bad deployment alarms without waiting for a notification) extends a streak; a delivery resets it; idle ticks and `gone` / `invalid` verdicts leave it alone. A tick whose dispatch throws (a send fault, `PushSendFault`, or a claim or read failure inside a worker) counts as a failed tick whatever else it delivered, and the fault, not the alarm, is what that tick throws. A delivery resets the streak even from a tick that also failed elsewhere: the alarm says push is delivering nothing, not that every send succeeded. A failed tick more than 15 minutes (`PUSH_ALARM_QUIET_MS`) after the previous one starts the count over at one. At 3 such ticks the job throws `PushDispatchDegradedError`, whose message names the last failing tick's `PushFailureCause` (`src/services/push-health.ts`; a quiet tick after it does not replace the cause), and `/api/health` reports it degraded, on every tick until its last failed tick is 15 minutes old (`PUSH_ALARM_QUIET_MS`), then clears. Bound, measured from the start of the first failed tick: about 20 s of continuous fast failures (the 3rd failed tick starts 2 × 10 s later), at most 55 s when every send times out (ticks start 20 s apart because a 15 s tick refuses the next one); under sparse traffic it is the 3rd failed tick, provided each followed the last within 15 minutes, since a failed send cannot be observed without a send; a misconfiguration needs none, so it alarms on the 3rd tick after boot (the push job's first tick is one interval in, so about 30 s). While it stands the job logs one `error` per 10 s tick. A restart resets the streak.

### Overlapping triggers

The jobs named in this section have had their send guarded at the DB layer
against a manual `/api/cron/*` call overlapping a scheduled tick, and were
measured:

- **Payment reminders** stamps `Payment.reminderSentAt` with a conditional
  `updateMany` inside a `$transaction` and abandons the notification when the
  count is zero (`payment-reminders.ts`).
- **Email fallback** claims each notification — `emailSent: false → true`,
  count checked — before sending, and releases the claim if the send
  fails (`email-fallback.ts`).
- **Class reminders** claims each reminder with a conditional `updateMany` on
  its stamp (`Registration.classReminderSentAt`, `Class.teacherReminderSentAt`),
  count checked, before writing an inbox row or sending anything
  (`class-reminders.ts`).
- **The degradation digest** claims each due event with a conditional
  `updateMany` keyed on the `lastSeenAt` it read, count checked, before
  sending, and puts the claims back if anything from the first claim through
  the send fails (`degradation-digest.ts`; Degradation events, below).

That is a statement about the jobs it names, NOT a survey. Class transitions
also sends recipient-visible notifications — `autoCancelClasses` writes a
`class_cancelled` set (`class-transitions.ts`) and `autoCompleteClasses`
reaches `completeClass`'s `payment_request` set (`class-lifecycle.ts`) — and
neither was examined for this.

### Degradation events

A degradation is a place where the app substitutes or withholds a value because
data that should have been impossible turned up: a tier outside 1–5, a timezone
that will not resolve. The user sees a page that works; nobody sees that a
fallback ran. Such a site calls `logDegraded` (`src/lib/degradation.ts`), which
logs the message and the allowlisted context and records the event so the operator is told.
`docs/degradation-sites.md` holds the audit of which log sites qualify and why
the rest do not, and one runbook section per code.

- **Registry.** `DEGRADATION_CODES` (`src/lib/degradation-codes.ts`) names every
  code with its log level, a description and its allowed context keys. The
  `DegradationEvent` table keeps one row per code, not one per occurrence:
  `occurrences`, `firstSeenAt`, `lastSeenAt`, `lastNotifiedAt` and the latest
  `sample` (`docs/data-model.md`).
- **Allowlist.** The context a site passes is filtered to the code's
  `contextKeys`, and to strings (truncated) and finite numbers, at runtime as
  well as in the types. Keys hold ids, enums, numbers or a zone string,
  never anything a person typed, so the row and the email carry no personal
  data by construction.
- **Coalescing.** The log line is written on every occurrence; the database
  write is coalesced to at most one per code per `COALESCE_WINDOW_MS`. The
  first occurrence after a quiet window writes at once; later ones are held as
  a count plus the latest sample and written when the window ends, so the last
  occurrence before silence is never left unwritten while the process lives.
  The digest needs that trailing write: it tells the operator again only when
  `lastSeenAt` has moved past `lastNotifiedAt`, so an occurrence that never
  reached the row would never count as having fired again since they were
  told. The count is approximate by construction: what is held when the process
  exits is lost.
- **Digest.** A code is due when `lastNotifiedAt` is null or older than
  `lastSeenAt`. The `daily-cleanup` job (`notifyOperatorOfDegradations`,
  `src/services/degradation-digest.ts`) claims each due row with an
  `updateMany` conditional on the `lastSeenAt` it read, emails the claimed rows
  as one message, and if a claim, the render or the send fails puts back
  every claim made so far and throws, which flips the job unhealthy on the
  verdict `/api/health` reports. The sweep sits just before the
  timezone audit, which stays last (`src/lib/scheduler.ts`).
- **Why `lastNotifiedAt` takes the `lastSeenAt` value.** Stamping the clock
  would swallow an event that lands between the read and the stamp: its
  `lastSeenAt` would be older than the stamp and the row would look told.
  Stamping the value that was read leaves a later event ahead of the stamp, so
  that row is due again next run. For the same reason the claim's `where`
  names that value, so a newer event makes the claim count 0 and the row is
  left for the next run.
- **A failed release.** If putting a claim back fails, the event stays marked
  told without an email; `degradation-digest.ts` logs the code at `error` and
  throws. That is the same exposure as a crash between claim and send, which
  the claim-before-send design accepts: the alternative, sending before
  claiming, lets overlapping runs email the same event twice.
- **Unset `OPERATOR_EMAIL`.** The scheduler logs an `error` at boot in
  production. When an event is due and the address is unset, the digest logs
  the due codes at `error` and throws, so the job reads unhealthy on
  `/api/health` (per-job detail needs the cron secret) instead of the events sitting unseen; nothing is claimed.
- **Health.** `/api/health` reports `degradations.open`, the number of events
  whose `lastSeenAt` is within the last 24 hours, as a bare number, in the body
  a request carrying the cron secret receives; the public body is `{ status, db }`.
  Which codes fired, and what they carried, appear only in the digest email and
  the server log, never on `/api/health`. When the count cannot be read, `degradations` is
  omitted and `db` still reports up.

---

## Deployment

### Single VPS Setup

```
┌─────────────────────────────────────────┐
│  VPS (2GB RAM, 1 vCPU)                  │
│                                         │
│  ┌─────────────┐  ┌──────────────────┐  │
│  │   Nginx     │  │  Let's Encrypt   │  │
│  │  (reverse   │  │  (SSL certs)     │  │
│  │   proxy)    │  │                  │  │
│  └──────┬──────┘  └──────────────────┘  │
│         │                               │
│  ┌──────▼──────┐  ┌──────────────────┐  │
│  │  Next.js    │  │  PostgreSQL      │  │
│  │  (Docker)   │──│  (Docker)        │  │
│  │  Port 3000  │  │  Port 5432       │  │
│  └─────────────┘  └──────────────────┘  │
│                                         │
│  ┌─────────────────────────────────────┐│
│  │  Backups: daily pg_dump to S3/B2   ││
│  └─────────────────────────────────────┘│
└─────────────────────────────────────────┘
```

### Rate limiting

`src/lib/rate-limit.ts` is an in-memory sliding-log limiter. Buckets are partitioned by key prefix (`PREFIX_CAPACITIES`, each keyed via `rateLimitKey()` off a `RateLimitPrefix` literal), so a flood on one prefix can never evict or throttle-suppress another prefix's state — including between the IP- and email-keyed sub-buckets of the *same* route, which are separate prefixes (`magic-link:ip` vs `magic-link:email`, `student-signup:ip` vs `student-signup:email`) for the same reason.

**Client IP trust boundary.** `clientIp()` reads the LAST entry of `x-forwarded-for`, trusting exactly one proxy hop. This is only correct because `deploy/nginx.conf.example` sets `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`, which appends the real client address (`$remote_addr`, as nginx sees it) to whatever the client sent — so the last entry is always nginx's own observation, and anything before it is client-controlled. Reading the first entry would trust that client-controlled prefix and let a caller spoof any IP for rate-limit purposes. If a second hop (a CDN, a load balancer) is ever added in front of nginx, this assumption needs re-deriving: the last entry would then belong to that hop, not the real client.

When `clientIp()` can't resolve any address at all (`x-forwarded-for` and `x-real-ip` both absent), the request is *not* exempted from its IP-keyed check — `checkIpRateLimit` routes it into one bucket shared by every such caller instead (`UNRESOLVED_IP_ID`), and logs a throttled warning, so an operator learns the trusted-proxy assumption above has broken rather than the check silently vanishing. Under normal operation (nginx configured as documented) this path never fires.

### Production compose

The production stack is `docker-compose.prod.yml`; read it there rather than in a copy here. Its database publishes no port, so Postgres is reachable only on the compose network.

### Shutdown

On SIGTERM (or SIGINT) the app ends its notification streams and exits by itself, without waiting for Docker's kill. Next 16's production server already owns the exit: its signal listener calls `server.close()`, which refuses new connections and waits for every open one to end, and then calls `process.exit` with 128 plus the signal number: 143 on SIGTERM, 130 on SIGINT. A notification stream never ends on its own, so without the sequence below the close would wait on it until `stop_grace_period` ran out.

The sequence, in order:

1. The signal arrives. Next's listener begins `server.close()`. `src/instrumentation.ts` installs a second listener (`installShutdownSignal`, `src/lib/shutdown.ts`) that calls `beginShutdown`. Next registers its listener before instrumentation loads, so its listener runs first; the order is immaterial because neither listener reads what the other did.
2. Every open stream, subscribed with `onShutdown`, runs the same `cleanup` an abort runs and ends. A request for a new stream that arrives after shutdown began is answered 503, checked after the session lookup so no stream can slip in between the check and its subscription (`src/app/api/notifications/stream/route.ts`).
3. `makeTick` (`src/lib/scheduler.ts`) starts no tick once shutdown has begun, and a refused tick does not count toward `skippedTicks`.
4. With the streams gone, `server.close()` completes as soon as ordinary requests finish, and Next exits.

`NEXT_MANUAL_SIG_HANDLE` stays unset: setting it would hand the whole sequence to the app, including a `server` handle that the generated standalone `server.js` does not expose. Once our listener exists Node no longer exits on SIGTERM by default, so the exit depends on Next's own listener; with `NEXT_MANUAL_SIG_HANDLE` set Next registers none, and SIGTERM would be ignored until the orchestrator's kill. A tick already running is abandoned rather than awaited, because Next awaits nothing the app registers in production. Work a request started without awaiting (`FireAndForget`, see "Work that must not be awaited" above) is cut by `process.exit` the same way. The cost is what a SIGKILL always cost: the tick's open transaction rolls back and the next container's scheduler runs the sweep again. A sweep is not one transaction, so the repeat is not always a clean redo: `processEmailFallback` claims a notification (`emailSent: true`) before it sends, so a cut between the claim and the send leaves one marked sent that never went out.

`stop_grace_period` in `docker-compose.prod.yml` is the backstop, not the mechanism: it bounds a request that does not finish. A stream cut this way reconnects to the new container.

### CI/CD

GitHub Actions runs on every PR:

```yaml
# .github/workflows/ci.yml
- TypeScript type checking (tsc --noEmit)
- Linting (eslint)
- Unit + integration tests (vitest)
- E2E tests (playwright against test database)
- Build verification (next build)
```

Main branch deploys automatically to VPS via SSH + Docker pull.

### Visual baselines, and the change that renders nothing

`check-visual-baseline-freshness` flags a route whose source file moved in this
diff while its screenshot did not — usually someone forgot
`pnpm exec playwright test visual --update-snapshots`.

Sometimes the edit genuinely does not render: a predicate extracted into a
shared module, an import reordered. Then the regenerated screenshot is
byte-identical, git has nothing to record, and the route **cannot clear on its
own** — the check compares a diff, and there is no diff to find.

That case is settled by an attestation in
`tests/e2e/visual-baseline-attestations.json`: a maintainer's record that one
exact source and one exact baseline were verified to render the same. Write it
with `pnpm run attest-visual-baseline <route> ["why"]`, which refuses unless
it can earn the claim — it reruns the whole visual suite itself and aborts if
a single baseline byte moved, because a change that moved a pixel needs its new
screenshot committed, not a note saying it didn't.

The record is two content hashes, not a route name, so it self-invalidates:
edit the source again and `sourceSha256` stops matching; regenerate the
baseline for real and `baselineSha256` does. It can never become a standing
exemption for a route, only for the pairing someone actually checked. An
allowlist entry or a `SKIP_VISUAL=1` would silence the route forever and leave
no trace of why.

Baselines are macOS-only (every file is `-darwin.png`), so the command refuses
to run anywhere else: a Linux digest would attest to bytes CI never renders.

---

## Environment Variables

```env
# Database
DATABASE_URL=postgresql://yoga:password@localhost:5432/ethical_yoga

# Auth
PASSKEY_RP_ID=              # Relying party ID for WebAuthn (e.g. "ethicalyoga.app"); the parent domain when ADMIN_HOST is set
PASSKEY_RP_NAME=            # Display name (e.g. "Ethical Yoga")

# Email
LETTERMINT_API_TOKEN=       # Transactional email provider; production refuses to send without it
LETTERMINT_CLASS_ROUTE=     # Slug of a second transactional route for class mail
UNSUBSCRIBE_SECRET=         # >=32 bytes; signs unsubscribe links. Unset in production: mail sends without them
EMAIL_REPLY_TO=             # Platform mail's Reply-To; default hello@fair.yoga
OPERATOR_EMAIL=             # Receives the daily degradation digest
EMAIL_FROM=                 # e.g. "noreply@ethicalyoga.app"

# Mollie Connect: all three unset turns Mollie off; some set is a logged misconfiguration.
# It also needs NEXT_PUBLIC_APP_URL (below), an http(s) URL: Mollie's redirect, return and webhook URLs are built on it
MOLLIE_CLIENT_ID=           # The Mollie app's client id (OAuth)
MOLLIE_CLIENT_SECRET=
PROCESSOR_TOKEN_KEY=        # 32 bytes, base64 (`openssl rand -base64 32`); encrypts stored tokens (Processor token cipher)
MOLLIE_TESTMODE=            # "1" creates test-mode payments

# Payments (Stripe, added later)
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=

# Push — generate with `pnpm run vapid:keys`. Unset disables push. Rotating
# the pair silently orphans every existing subscription — browsers
# re-subscribe only when the user turns push on again.
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=              # a mailto: or https:// URL, e.g. "mailto:ops@fair.yoga"

# App
NEXT_PUBLIC_APP_URL=        # e.g. "https://ethicalyoga.app"
ADMIN_HOST=                 # e.g. "admin.ethicalyoga.app"; unset turns the admin surface off (Admin surface)
```

---

## What's Intentionally Left Out

These are deferred, not forgotten:

- **Native mobile app.** The teacher dashboard is mobile-first responsive web. If native is needed later, the services layer can be extracted into a standalone API.
- **Multi-language / i18n.** English first. Next.js has built-in i18n routing for when we add languages.
- **Rate limiting / abuse prevention.** Needed before public launch, but not for initial development.
- **Log-based monitoring / observability.** A fallback that substitutes a value is recorded as a `DegradationEvent` row by `logDegraded` and emailed to `OPERATOR_EMAIL` in a daily digest, and `/api/health` carries the aggregate for a request with the cron secret (Cron Jobs → Degradation events). Every other log line stays on stdout. A log backend (Grafana/Loki or similar) remains deferred until logs leave the box. Errors logged through `@/lib/log` are allowlisted (`src/lib/log-serializers.ts`, #739): every `Error` at the top level of a log call's first argument, any error-like value under `err`, and the `msg` pino falls back to; a value that cannot be serialized is replaced by a placeholder, never logged raw. Only named fields survive, and a cause appears under `err.cause` rather than folded into the message. A Prisma query error's message is withheld, since it renders row values; any other error's message is kept as written. Shipping logs still needs the rest of the stdout stream accounted for. Next prints an error a page or route throws outside `withErrorHandler` through `console.error`, with its message, stack, enumerable properties and cause chain; an `onRequestError` hook in `src/instrumentation.ts` would run beside that print, not instead of it, so that stream needs handling outside the app. Third-party text the app copies into its own messages is kept verbatim: the email provider's error message carried in `SendResult.reason` and in the errors `lib/email.ts`'s wrappers throw, `reason: error.message` strings, the push failure `cause` string `lib/push/send.ts` builds, and the push service's response body. Values copied out of an error into sibling keys (`constraint: pgErrorOf(err)?.constraint`) bypass the allowlist. An error nested below the top level of a log object, passed in the message position, passed as a format argument, or bound with `log.child` under any key but `err` is written by pino as its own enumerable properties, without the allowlist. And dry-run email mode logs only the subject from `sendEmail`; the `[DEV]` console lines, which print on any dry run (a production build with `EMAIL_DRY_RUN=1` included), print the magic link and the invitation sign-in URL together with the address.
- **GDPR tooling.** Data export and account deletion endpoints. Required before launch, designed later.
- **Level 2 payment retry logic.** Open question — parked for now. There is no automatic charging to retry; a student whose Mollie payment failed or expired pays again from the pay page.
