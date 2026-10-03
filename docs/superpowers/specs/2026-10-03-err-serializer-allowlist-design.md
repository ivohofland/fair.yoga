# Allowlist what an error puts in a log line (#739)

**Status:** design, self-adjudicated. The session was asked to run end to end
without interaction, so each gate's choice is recorded below with the options
it weighed, for review after the fact. One adversarial review pass ran on the
first draft; its findings are folded in and listed at the end.

## The issue's premise, measured

The issue says pino's default `err` serializer leaks "the error's own
enumerable properties", that for a `PrismaClientValidationError` those include
the query arguments, and proposes an allowlist of `type`, `message`, `stack`,
`code` and Prisma's `meta.target`.

Measured on Prisma 6.19.3 and pino 10.3.1 (pino-std-serializers 7.1.0) by
throwing each error against a worktree database with a fake student
(`Alicepii Surnamepii`, `pii.<n>@example.com`), under `NODE_ENV=production`,
and logging it with a bare `pino()`:

| Error | Own enumerable keys | Where the student's data was |
|---|---|---|
| `PrismaClientValidationError` (unknown argument) | `name`, `clientVersion` | **`message`**: the whole argument tree, names and email included |
| `PrismaClientValidationError` (wrong type) | `name`, `clientVersion` | **`message`**: the `where` email and the offending value |
| `PrismaClientUnknownRequestError` (CHECK `23514`, both `Student_income_tier_check` and `Student_email_lowercase_check`) | `name`, `clientVersion` | **`message`**: Postgres `DETAIL` — `Failing row contains (<id>, Alicepii, Surnamepii, pii…@example.com, …)` |
| `PrismaClientKnownRequestError` `P2010` (raw query, bad cast) | `code`, `meta`, `clientVersion`, `name` | **`message` and `meta.message`**: `invalid input syntax for type integer: "Alicepii pii…@example.com"` |
| `P2002`, `P2003`, `P2025` | `code`, `meta`, `clientVersion`, `name` | none: field, constraint and model names only |

So the premise is **half right**. The leak is real, and wider than the issue
names: CHECK violations and raw-query errors carry row values too. But for the
error the issue names, the data is not in an enumerable property. It is in
`message`, and therefore also in `stack`, which V8 begins with
`${name}: ${message}`. **The proposed allowlist keeps both, so it would have
closed none of the measured leaks except P2010's `meta.message`**, and that
duplicates the message it keeps.

Two more channels the issue does not mention, both in pino itself
(`pino/lib/proto.js` `write`):

- **The `msg` fallback.** `log.error({ err })` with no message string, or
  `log.error(err)`, copies the raw `err.message` into `msg`. That happens
  before any serializer or formatter runs, so no serializer can redact it.
- **Other keys.** Only `err` is serialized. An Error under any other
  top-level key is plain-stringified: its enumerable properties only, which
  for a P2010 includes `meta.message` and so the row value. `probeErr` is such
  a key today (`grep -rn "probeErr," src --include='*.ts'`).

And one leak among non-Prisma errors: Node's `new URL()` TypeError
(`ERR_INVALID_URL`) carries an enumerable `input`, the URL it refused. In
`push-dispatch.ts`, that is a push endpoint: a capability URL.

## What must not be lost

A census of every custom `Error` subclass in `src/` and every log site that
can receive one found:

- **`cause` carries the real failure** for `SpotFreedError` (a Prisma error,
  a lock timeout, or `RosterLinkVanishedError`), `PushSendFault`,
  `DegradationDigestError` and `InvalidSubscriptionKeysError`. pino today
  folds the cause's message into `message` and its stack into `stack`. The
  cause must survive, and it must pass through the same redaction, since a
  `SpotFreedError`'s cause is often a Prisma error.
- **`ErasureLockSetError.strays`** (`classId`, `status`, `createdAt` per
  entry) is the only record of what the erasure found, and
  `api/account/route.ts` says so beside its log call. Only the class ids are
  also in the message.
- `ReconciliationFailedError.failedClassIds` and
  `GenerationContendedError.templateIds` are dropped from the tick-level line,
  but each id is also logged on its own per-item line. Every other custom
  error's properties are restated in its message or on its log line.
- No doc or runbook tells an operator to read any `err.*` property.
  `classifyApiError` already lifts `meta.target` to a top-level `target`, and
  the `rawTarget` sites copy it out explicitly.
- `P2024`'s `meta.connection_limit` and `meta.timeout` (numbers) were used
  for pool diagnosis (`2026-09-23-transient-kind-design.md`).
- A `PrismaClientInitializationError` is the database-down line. Its message
  names what failed to connect (`Can't reach database server at
  \`host:port\``, an authentication failure, TLS), and measured against an
  unreachable database its `errorCode` was `undefined`, so withholding its
  message would leave the most important outage line saying nothing.
- `type` is `constructor.name`. The production build runs Next 16 with
  `serverMinification` on by default, and some app errors set no `name`
  (`ClassFullError` and its siblings in `api/registrations/route.ts`), so a
  mangled `type` is possible there. That is true of pino's serializer today
  too; keeping an explicitly set `name` is what does not depend on it.

## Options weighed

1. **pino `redact` on known paths.** Rejected: redact works on paths of the
   logged object, and the leak is free text inside `message` and `stack`. No
   path names it.
2. **The issue's allowlist** (`type`, `message`, `stack`, `code`,
   `meta.target`). Rejected as measured above: it keeps the text that leaks.
3. **Allowlist the structure, and withhold the message text of the family
   measured to carry row values.** Chosen. Prisma's query errors render the
   call's arguments and Postgres's `DETAIL` into their message by design. The
   app's own messages are written from ids and counts: a grep of
   `new …Error(\`…${…}\`)` for interpolated identifiers containing `email`,
   `name`, `address` or `phone` found none in `src/` outside the worktree
   tooling. That is a name heuristic, not proof, which is why the shape is
   allowlisted whatever the message says.
4. **Withhold every message.** Rejected: an error's message is the one
   human-readable account of what failed. Without it every non-Prisma line
   reads as a class name and a stack.
5. **Redact only outside development.** Rejected: one behaviour, one set of
   tests, and the tests exercise the code production runs. The cost (a
   developer sees ``Invalid `prisma.student.create()` invocation`` without the
   argument tree) is the trade the issue already accepts.

## Design

### The serialized shape

`serializeErr(value)` returns a plain object built only from:

| Key | Source | Kept when |
|---|---|---|
| `type` | `constructor.name`, else `name` | always |
| `name` | own `name` | a string |
| `message` | `message`, or the withheld form below | always |
| `stack` | `stack`, or the withheld form below | a string |
| `code` | `code` (or a Prisma `InitializationError`'s `errorCode`) | a string or a finite number |
| `meta` | Prisma `meta.target`, `meta.constraint`, `meta.modelName` (a string or an array of strings); `meta.connection_limit`, `meta.timeout` (finite numbers) | per key, as stated |
| `sqlState`, `constraint` | lifted from a withheld Prisma message, below | the pattern matches |
| `cause` | `serializeErr(cause)` | error-like |
| `aggregateErrors` | `errors.map(serializeErr)` | an array |

Everything else is dropped, so a new property on any error is withheld until
someone adds it here. `cause` and `aggregateErrors` share one depth budget and
one cycle guard. A value that is not error-like (no string `message`) is
returned unchanged, as pino's own serializer does.

The output is marked with a module-private `WeakSet`, and a marked value is
returned unchanged. That is what makes the function idempotent, which it must
be: pino runs `serializers.err` on the object the hook already produced, and
a second pass over a plain object would rewrite `type` to `Object` and drop
`aggregateErrors`.

### Prisma errors

An error is treated as Prisma's when it is an instance of one of the
`Prisma.PrismaClient…Error` classes, **or** when its `name` or its
constructor's name matches `/^PrismaClient\w+Error$/`. The second test is
what fails closed: a duplicated package instance, a re-wrapping library or a
future error class would otherwise log its message verbatim.

For every Prisma error except `PrismaClientInitializationError`:

- `message` is the invocation header and a fixed note, e.g.
  ``Invalid `prisma.student.create()` invocation (detail withheld from the log)``,
  or the note alone when no header parses. The header is matched as
  ``Invalid `<receiver>.<path>()` invocation``, where receiver and path are
  JavaScript identifier characters including `$` (`$queryRaw`). The receiver
  is any identifier, because outside `NODE_ENV=production` Prisma rebuilds it
  from the caller's source text (`tx.student.create()`) and appends
  `in <file>:<line>:<col>` and a source excerpt, none of which the match
  takes.
- `stack` is `${type}: ${message}` followed by the original stack's frames,
  where the frames are **what follows the exact prefix
  `${name}: ${originalMessage}`**. If the stack does not start with that
  prefix, no frame is kept. Filtering lines that look like `    at …` is not
  safe: Postgres does not escape a newline in a raw-query value, so a P2010
  can carry a line of row data shaped exactly like a frame.
- `sqlState` is lifted only from a `PrismaClientUnknownRequestError`
  (`PostgresError { code: "XXXXX"`) or a P2010 (its structural `meta.code`),
  as five characters of `[0-9A-Z]`.
- `constraint` is lifted only when that `sqlState` is in class `23`
  (integrity constraint violation), from the first
  `violates (check|exclusion|foreign key|unique) constraint "<name>"` (quotes
  optionally backslash-escaped, as they arrive on the Unknown path), as
  `[A-Za-z0-9_]+`. Postgres writes that sentence before its `DETAIL`, and a
  class-23 message is Postgres's own template. A `22P02` that quotes a value
  shaped like the sentence never reaches the pattern.

`PrismaClientInitializationError` keeps its message and stack. It is raised
before a query reaches the database, and its text is about the connection.

### Every pino channel, one hook

`log.ts` configures pino with:

- `hooks.logMethod`: before pino sees the call, a shallow copy of the first
  argument replaces every top-level value that is an `Error` with
  `serializeErr(value)`, and an `Error` passed as the first argument becomes
  `{ err: serializeErr(e) }`. A copy, because callers pass objects they keep
  using. This runs before pino's `msg` fallback, so that fallback reads the
  redacted message, and it covers `probeErr` and any future top-level key.
- `serializers.err`: the same function. Idempotent, so a value the hook
  produced passes through, and an error-like object under `err` that is not
  an `Error` instance is still allowlisted.

The logger is built by `createLogger(destination?)`. With a destination it
writes there and uses no transport (pino refuses both); without one it is
today's configuration. `log` is `createLogger()`. Tests assert on the real
configuration's output, not a copy of it.

### Two call sites

- `api/account/route.ts` logs `strays: err.strays` beside `err` for an
  `ErasureLockSetError`. The strays are class ids, statuses and timestamps.
- `degradation-digest.ts` copies its send failure's message into
  `DegradationDigestError`'s message, and that failure can be a Prisma error
  from the claim write. It takes the message from `serializeErr(failure)`
  instead, so the copy is redacted the same way.

## Testing

- **Unit (`src/lib/log-serializers.test.ts`):** Prisma error instances built
  with the measured production messages. No fake-PII token survives anywhere
  in `JSON.stringify(serializeErr(e))`; the header, `code`, `meta`
  identifiers, `sqlState`, `constraint` and stack frames do. A P2010 whose
  value contains `\n    at evil (x)` keeps no such line. A `22P02` quoting a
  value shaped like the constraint sentence lifts no constraint. A Prisma
  error recognised by `name` alone is withheld. A cause chain holding a
  Prisma error is redacted at depth; a cycle terminates;
  `serializeErr(serializeErr(e))` deep-equals `serializeErr(e)` with a cause
  and an `AggregateError`. A plain `Error` keeps `message` and `stack`; a
  `TypeError` with `input` loses `input`; an `InitializationError` keeps its
  message.
- **Logger (`src/lib/log.test.ts`):** through `createLogger(dest)`: `{ err }`
  with no message string, an `Error` as the first argument, and a `probeErr`
  key each produce a line free of the PII tokens; the caller's object is not
  mutated.
- **Integration (`tests/integration/log-redaction.test.ts`):** real errors
  thrown by Prisma against the test database (a validation error, a CHECK
  violation, a P2010), logged through `createLogger(dest)`. These run outside
  `NODE_ENV=production`, so they exercise the header form the unit tests'
  production strings do not.
- **Mutation proof, per guard:** remove the hook; remove the Prisma branch;
  remove the name-based detection; filter frames by pattern instead of by
  prefix; keep `meta` whole; drop the `cause` recursion; drop the
  idempotence mark; drop the class-23 gate. Each must redden a named test.

## Not in scope, and what log shipping still needs

This closes pino's channels. It does not make every line on stdout safe to
ship, and `docs/technical-architecture.md` (What's Intentionally Left Out),
which names #739 as the prerequisite, is updated to list what remains:

- **Next's own `console.error`.** An error a server component or route throws
  without `withErrorHandler` is printed by Next with its full message. Pages
  query the database directly, and `src/instrumentation.ts` registers no
  `onRequestError`.
- **Strings, not errors.** `reason: error.message` (`email-fallback.ts`,
  `class-reminders.ts`), the push service's response body under `reason`
  (`push-dispatch.ts`), and Resend's message copied into the app's own errors
  (`lib/email.ts`). No serializer sees a string. What Resend puts in that text
  was not measured.
- **Errors nested below the top level, in the message position, or as a
  format argument.** pino stringifies them. No call site does any of these
  today.
- `api/cron/daily-cleanup/route.ts` returns `err.message` in its response to
  the operator's own cron `curl`. That is not a log line, and it stays on the
  box.

## Review outcomes

The adversarial pass on the first draft found the frame filter unsafe (P2010
values can forge a frame line), the idempotence unspecified, the constraint
pattern unable to match the escaped quotes it would meet and able to lift a
value, the `InitializationError` handling contradicted by measurement, the
header measured for production only, the Prisma test failing open, and the
digest's copied message misdescribed as third-party text. Each is addressed
above. It also confirmed the pino write path, the hook's inheritance and
signature, the Prisma exports, and that no test or runbook depends on the
old serialized shape.
