# Scoping the handoff attempt budget to the browser, not the token (#423)

`claimWithCode` (`src/lib/auth/handoff.ts`) charges a wrong guess against a
single token row, chosen by a fallback that a caller holding the browser's
nonce can steer. This spec replaces the fallback with one rule and states what
that rule costs.

## 1. The premise, verified

#423's mechanical claims were checked against the code, not taken from the
issue. All of them hold:

| Claim | Where |
|---|---|
| The miss fallback is always the newest candidate | `handoff.ts:116` (`orderBy: createdAt desc`), `handoff.ts:120` (`?? candidates[0]!`) |
| The budget docblock asserts independence from nonce secrecy | `handoff.ts:83-84` |
| The 2026-09-03 spec asserts the same, as "per-token" | `2026-09-03-magic-link-device-handoff-design.md:382-386` |
| Claim endpoint: 30 per IP per 15 minutes | `api/auth/magic-link/claim/route.ts:23-24` |
| Token TTL: 15 minutes | `lib/auth/magic-link.ts:6` |

Two facts the issue asserts without demonstrating were checked as well, because
the attack collapses if either fails.

**The nonce is stable across link requests.** `ensureOriginNonce`
(`origin-nonce.ts:42-51`) returns an existing cookie and mints only when there
is none, so tokens requested from one browser over time share one
`originBrowserHash`. A decoy minted later genuinely lands in the target's
candidate set.

**A decoy can be stamped without any manual step.** A candidate needs
`handoffCode != null`, which only the foreign-browser branch of
`verifyWithHandoff` produces — but that is two scriptable requests: `POST
/api/auth/magic-link/send` carrying the nonce cookie, then a `GET` of the
emailed link *without* it (`nonce === null` → `sameBrowser` false →
`handoff.ts:60-80` stamps). A catch-all recipient domain makes the per-email
send limit irrelevant.

### The arithmetic of the decoy supply

Re-derive the inputs with:

```
grep -n "PER_IP_LIMIT\|PER_EMAIL_LIMIT" src/app/api/auth/magic-link/send/route.ts \
                                        src/app/api/auth/magic-link/claim/route.ts
grep -n "HANDOFF_MAX_ATTEMPTS =" src/lib/auth/handoff.ts
```

A decoy absorbs `HANDOFF_MAX_ATTEMPTS` = 5 wrong guesses and is then deleted
(`handoff.ts:144-146`), so the attacker must keep minting. Per IP per
15-minute window: 10 sends × 5 guesses absorbed = 50 guess-slots supplied,
against a claim ceiling of 30. Supply exceeds demand (50 > 30), so decoy
production is *not* the binding constraint — one IP reaches its full 30 wrong
guesses. Reaching 30 needs ⌈30 ÷ 5⌉ = 6 decoys, and the per-email send limit
of 3 means 6 decoys need ⌈6 ÷ 3⌉ = 2 attacker-controlled addresses.

## 2. Why "accept it" is refused

#423's first option argues the exploited bound — 30 guesses against a 10⁶
space — is negligible. That reasoning treats a per-IP rate limit as though it
were absolute. It is not, and the difference is the whole point of the guard:

- **Without the exploit**, guesses against one target token total 5, and stop
  because the target's own counter is what dies. Adding IPs buys nothing.
- **With the exploit**, the target's counter never moves. Guesses become
  30 × N IPs per 15-minute window, and the token's 15-minute TTL means one
  window is its entire life.

So 30 ÷ 10⁶ is the *single-IP* figure. N = ⌈10⁴ ÷ 30⌉ = 334 IPs buys ≈1%;
N = ⌈10⁵ ÷ 30⌉ = 3,334 buys ≈10%. Rented residential proxy pools price both
within reach of a targeted attacker.

The defect is therefore not "the bound shrank from 5 to 30". It is that a
**hard bound became a purchasable one** — which is exactly the property
`handoff.ts:83-84` claims for this budget and the 2026-09-03 spec calls
defence in depth.

## 3. The decision

**A submitted code that matches no live candidate is a wrong guess against
every live candidate, and is charged to all of them.**

### This is accounting, not a behaviour change

`handoff.ts:120` compares the submitted code against every candidate at once:

```ts
candidates.find((candidate) => candidate.handoffCode === code)
```

One `POST` is therefore one failed guess against *all* of them. Charging
exactly one row undercounts by construction, and no choice of *which* row
repairs that — which is why #423's options 2 and 4 cannot work. They are
different answers to "which single row absorbs the miss," when the honest
answer is that every candidate was guessed against and missed.

The consequence #423 lists as option 3's cost — a browser with two pending
codes sharing one budget — is not a cost but the correct reading. The typo
really did miss both codes.

### Why the other options are refused

- **Option 2 (charge the oldest)** relocates the exploit rather than closing
  it: a decoy pre-minted before the target is older than it, and camping is
  cheap. It also adds harm the current code lacks — a legitimate typo lands on
  a stale decoy, so misses stop depleting anything real.
- **Option 4 (a miss with no match is free)** is strictly worse than today.
  It hands a nonce-holder 30 × N guesses per window with no decoy machinery at
  all.

### A fifth option, considered and rejected

Keeping the candidate set to at most one row — stamping a code invalidates any
other stamped token for that nonce — makes the fallback unambiguous by
construction. It is refused because it hands anyone holding the *link* the
power to destroy a code the legitimate user is part-way through typing, which
`2026-09-03-magic-link-device-handoff-design.md:387-389` forbids by name.

### The invariant this establishes

The attempt budget is **per browser-nonce, not per token**:
`HANDOFF_MAX_ATTEMPTS` wrong codes submitted from one browser destroy every
live stamped token that browser could have been claiming. This is what makes
the guess bound independent of the caller's IP count, and it is what
`HANDOFF_MAX_ATTEMPTS`'s own docblock has claimed all along.

## 4. The algorithm

```ts
const candidates = await db.magicLinkToken.findMany({ /* where clause unchanged */ });
if (candidates.length === 0) return { kind: 'invalid' };

const spent = candidates.filter((c) => c.handoffAttempts >= HANDOFF_MAX_ATTEMPTS);
if (spent.length > 0) {
  await db.magicLinkToken.deleteMany({ where: { id: { in: spent.map((c) => c.id) } } });
}

const live = candidates.filter((c) => c.handoffAttempts < HANDOFF_MAX_ATTEMPTS);
if (live.length === 0) return { kind: 'invalid' };

const match = live.find((c) => c.handoffCode === code);
if (!match) {
  await db.magicLinkToken.updateMany({
    where: { id: { in: live.map((c) => c.id) } },
    data: { handoffAttempts: { increment: 1 } },
  });
  await db.magicLinkToken.deleteMany({
    where: { id: { in: live.map((c) => c.id) }, handoffAttempts: { gte: HANDOFF_MAX_ATTEMPTS } },
  });
  return { kind: 'invalid' };
}

if (!(await consumeTokenRow(db, match))) return { kind: 'invalid' };
return { kind: 'verified', email: match.email, redirectTo: match.redirectTo, purpose: match.purpose };
```

### Concurrency

- `updateMany` with `{ increment: 1 }` is atomic per row, the same guarantee
  the current single-row `update` relies on. Two concurrent misses still count
  as two.
- **The `try`/`catch` at `handoff.ts:138-143` becomes dead and is removed.**
  `updateMany` does not raise P2025 when a row vanished under it — it updates
  zero rows. The existing "a correct claim concurrent with wrong guesses never
  throws" case then passes structurally rather than by catching. The
  `isRecordNotFound` import goes with it; three other modules still use the
  helper, so `api-errors.ts` is untouched.
- **`deleteMany … { gte: HANDOFF_MAX_ATTEMPTS }` is safer than the read-back
  it replaces.** It re-evaluates the counter inside one statement, so whichever
  concurrent guess pushed a row over the line, the row dies. The current
  read-then-delete has an interleaving where two callers each read 4 and
  neither deletes.

### Why the exhausted rows are reaped before matching

An exhausted row is dead to a match as well as to a miss, so it is deleted and
dropped from the working set first. A code matching only an exhausted row is
therefore treated as a plain miss and charges the live candidates.

The kinder alternative — charging nothing when the submitted code matches an
exhausted row — is refused: an attacker watching whether their own decoy's
counter moved could distinguish "matched a dead token" from "matched nothing",
which is the same observable-steering shape as the bug being fixed. Charging
uniformly keeps the two indistinguishable.

### Why `orderBy: createdAt desc` stays

The ordering is no longer load-bearing for the budget, but it still fixes the
tie-break if two live candidates ever stamp the same code (10⁻⁶ per pair):
`find` then returns the newest deterministically rather than whatever order the
database returned.

## 5. Accepted consequences

**A shared browser's tokens share one budget, across different people.** The
candidate query keys on the nonce with no email filter
(`handoff.ts:111-115`), and the nonce survives an *abandoned* sign-in —
`clearOriginNonceCookie` rotates it only on success (`origin-nonce.ts:53-61`,
`claim/route.ts:83,112`). So where one person requests a link on a shared
browser and walks away, a later person's five typos now destroy that stranded
token too. Today's newest-first fallback shields it by accident.

This is accepted rather than fixed. The stranded token expires within 15
minutes regardless, and the cost of losing it is one re-request.

Keying the budget on `(nonce, email)` to spare the stranded token cannot work,
and the reason is worth stating: **the claim request carries a code and
nothing else.** There is no email on it, so nothing identifies which group a
miss belongs to. Charging every group is this spec's rule under another name;
charging one group is the fallback defect again, and an attacker whose decoys
sit in their own address's group would simply never be charged for the
victim's.

**What is not new here:** a shared browser already lets a later user claim an
earlier user's token if they hold its code — `claimWithCode` returns the
*matched row's* email. That reach is inherent to a browser-scoped nonce, is the
kiosk threat model #423 itself names, and is unchanged by this spec. Only the
budget sharing is new.

## 6. What is deliberately not changed

- `verifyWithHandoff` and the stamping path.
- `HANDOFF_MAX_ATTEMPTS` stays 5.
- Both rate limits stay as they are. This spec's whole argument is that rate
  limits are the wrong instrument for this bound, not that they are mistuned.
- `tests/integration/magic-link-claim.test.ts` needs no change: it exercises
  the route's session, cookie and redirect behaviour and never reaches the
  budget.
- The 2026-09-03 spec's §6 is left standing as the record of what was decided
  then. This spec supersedes its "per-token" wording; editing a closed spec
  turns a historical record into a second thing that can go stale.

## 7. Verification

Every guard is proven by breaking it, recording the exact failure, restoring,
and re-verifying.

| Case | Mutation that must turn it RED |
|---|---|
| Older target + newer decoy: five misses destroy the **target**, not only the decoy | restore `?? candidates[0]!` as the miss target |
| Every live candidate is charged on a miss | narrow the `updateMany` to `live[0].id` alone |
| A spent budget destroys every candidate, not one | drop the `deleteMany … { gte: … }` |
| A correct code still claims its own token, not the newest (`handoff.test.ts:185`) | must stay green throughout — it is the regression this replaces |
| Concurrent misses still count individually (`handoff.test.ts:215`) | must stay green |
| A correct claim racing wrong guesses never throws (`handoff.test.ts:233`) | must stay green |

The first case is the one #423 exists for and did not previously exist in any
form: no test today distinguishes "the decoy absorbed the guess" from "the
target absorbed it".

`handoff.test.ts` reaches the database directly and does not need the dev
server; `npx vitest run src/lib/auth/handoff.test.ts` is the inner loop.
`npm run verify` before pushing.

## 8. Documentation corrections

Per CLAUDE.md's comment discipline, a corrected claim is **replaced**, not
annotated; the before-and-after belongs in the PR body.

- `handoff.ts:96-101` — the paragraph describing "only when no candidate's code
  matches does the newest one absorb the wrong guess" states the defect. It is
  rewritten to the §3 rule.
- `handoff.ts:83-84` — restated as a per-browser budget. The existing sentence
  about not depending on nonce secrecy becomes true rather than aspirational,
  so it stays.
- `handoff.ts:111-115` — a short note that the candidate set is scoped to the
  browser, not to an email address, since §5 turns that into a property a
  reader touching this query needs.
- No other document describes this budget. `docs/lock-order.md:1073`'s
  "150-attempt budget" is lock retry, unrelated.
