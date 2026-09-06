# Probe placement: what the compiler already holds, and what nothing does

Issue #467. Spun out of #464 (PR #465), which built the census pattern this
reuses. Measured on `main` at `db443df3`.

## What the issue asked for, and what is actually there

#467 asks for one test: a `ruleSlotHolder` call must not sit lexically inside a
`db.$transaction(…)` callback, modelled on `src/lib/db-locks-verdict-census.test.ts`.

The premise sweep changed four things about that. Two of them narrow the claim,
two of them widen the work.

### 1. The shipped census reproduces exactly — the issue's own numbers hold

```
$ grep -rn "ruleSlotHolder(db\|ruleSlotHolder(prisma" src/services/ src/app/api/
src/services/rule-lifecycle.ts:839
src/services/rule-lifecycle.ts:1635
src/services/studio-class-template-lifecycle.ts:769
src/services/class-template-lifecycle.ts:1053
```

Four, all correctly placed: two reached from a `catch` after `db.$transaction(…)`
threw, two on the normal return path after a zero-row `ON CONFLICT DO NOTHING`.
Both shapes the docblock names, one pair each. 15 mentions of the bare name
across non-test `src/`, so the `(db|prisma` anchor is doing real work. Nothing
here is wrong.

### 2. The stated mechanism — `25P02` — is not reachable through these probes

#467's account of the defect:

> a fifth caller placing the probe *inside* its transaction gets `25P02` where a
> `RuleSlotHolder` was expected

That requires passing `tx`. It does not compile. `Prisma.TransactionClient` is
`Omit<PrismaClient, ITXClientDenyList>`, so it lacks `$transaction` and is not
assignable to the `db: PrismaClient` parameter. Measured, by compiling a probe
file against both helpers and deleting it again:

```
src/lib/__premise_probe.ts(6,24): error TS2345: Argument of type 'TransactionClient'
  is not assignable to parameter of type 'PrismaClient<PrismaClientOptions, never, DefaultArgs>'.
  Type 'TransactionClient' is missing the following properties from type
  'PrismaClient<…>': $on, $connect, $disconnect, $transaction, $extends
```

So the docblock's *reason* (`25P02` on an aborted `tx`) is held by the type
signature, not by prose. What is NOT held is the placement itself: a call sitting
inside the callback and passing the **outer** `db` compiles, and runs on a second
pooled connection while the first transaction is still open. That is a different
failure with a different name:

- **Pool re-entrancy.** The request holds its transaction's connection and asks
  for another. The docblock already argues that contention is exactly when slot
  conflicts occur; at pool size N, N concurrent requests each holding a
  transaction and each wanting a second connection cannot all proceed, and the
  409 the caller had already decided on becomes a pool timeout instead.
- **A snapshot that cannot see its own transaction.** The probe reads a
  committed snapshot, so it is blind to the uncommitted rows of the transaction
  it is being asked about.

No `25P02`. Latent either way — all eight call sites are correct — but the
mechanism in the issue is not the mechanism a fifth caller would hit, and a spec
that repeated it would send the reader looking for an error code that cannot
appear.

### 3. There are two helpers carrying this rule, not one

`probeConflictingEntry` (`src/lib/entry-conflict.ts:195–208`) states the same
rule, in nearly the same words, with the same two shapes and the same
enforcement — a shipped grep and nothing else:

> Called on the failure path once the refused statement's transaction has closed,
> always against `db`, never `tx` … Every call site must therefore sit after its
> own transaction's closing `)`. The current set of them is whatever this returns:
>
>     grep -rn "probeConflictingEntry(" src/services/ src/app/api/

`ruleSlotHolder`'s own docblock names it — "the same contract
`probeConflictingEntry` (`./entry-conflict`) carries one layer down, arrived at
for the same reason". Amending one paragraph to say "this is enforced now" while
the paragraph it points at keeps the identical unenforced claim is the failure
`solve-issue` §4 is about, and here the twin is named in the sentence being
edited. Both helpers are in scope.

Its four call sites, all correctly placed:

```
$ grep -rn "probeConflictingEntry(" src/services/ src/app/api/
src/app/api/classes/route.ts:198
src/app/api/classes/[id]/route.ts:172
src/app/api/studio-classes/route.ts:116
src/app/api/studio-classes/[id]/route.ts:278
```

Eight call sites across the two helpers, all correct. That is the tree the census
has to pass on.

### 4. The receiver is not `db`, and a stronger rule is falsified by a shipping call site

**The receiver.** #467 names `db.$transaction`. Two measurements, because an
earlier draft of this section printed the first under the label of the second —
the eleven-name figure below is over all of `src/`, test files included, and the
census's actual scope is the smaller set. The conclusion is unchanged; the
arithmetic was measured over the wrong set, so both sets are shown with the
command that produces each.

Across **all of `src/`**, test files included — eleven receiver names:

```
$ grep -rhoE "[A-Za-z_$][A-Za-z0-9_$]*\.\$transaction" src/ --include="*.ts" --include="*.tsx" | sort | uniq -c | sort -rn
  98 prisma.$transaction     12 holder.$transaction      3 holderDb.$transaction    1 prober.$transaction
  33 db.$transaction          6 holderClient.$transaction 2 other.$transaction      1 hookedPrisma.$transaction
                              4 target.$transaction                                 1 cancelDb.$transaction
                                                                                    1 a.$transaction
```

Per-name tallies as at `db443df3`; this branch's own fixture sources move
several of them, and the number of distinct names does not change.

Across **non-test `src/`**, which is the scope the census walks — two:

```
$ grep -rhoE "[A-Za-z_$][A-Za-z0-9_$]*\.\$transaction" src/ --include="*.ts" --include="*.tsx" --exclude="*.test.ts" --exclude="*.test.tsx" | sort | uniq -c | sort -rn
  30 db.$transaction
   7 prisma.$transaction
```

The design's argument rests on this second figure, and survives it. Every
`$transaction` a `probeConflictingEntry` call site sits beside is opened on
`prisma` — `classes/route.ts:101`, `studio-classes/route.ts:73`,
`studio-classes/[id]/route.ts:239`, with the fourth call site's file holding no
`$transaction` at all (below) — so a detector anchored on `db` would recognise
none of them, while still ignoring all seven `prisma` openings in the scope it
does search. The detector anchors on the **member name** `$transaction`,
whatever it is read off.

**The stronger rule that does not hold.** The docblock says "every call site must
sit after **its own** transaction's closing `)`", which reads as a checkable
pair: the enclosing function contains a `$transaction`, and the call comes after
it. That is falsified by a correct, shipping call site.
`src/app/api/classes/[id]/route.ts` contains **no `$transaction` at all** — its
transaction is inside `updateClass`, and its own comment says exactly that:

> On `prisma`, and off any aborted transaction **by construction**: `result` is a
> returned value, so every transaction `updateClass` opened has already closed

So the census asserts only the negative — **not inside** — and never "has one of
its own". A caller whose transaction lives one layer down is right, and demanding
a lexical transaction beside every probe would flag it.

### 5. The gap #467 does not mention, and it is the cheaper half

`entry-conflict.test.ts` already pins `probeConflictingEntry`'s parameter with a
never-called function carrying a `@ts-expect-error`, and states why the pin is
needed rather than redundant:

> It is true today only by the shape of `Omit` … Nothing keeps that true — a
> signature widened to `PrismaClient | Prisma.TransactionClient` (which
> `probeOverlappingCandidates` beside it deliberately IS) would compile every call
> site unchanged and break only in production, under contention.

`rule-slot-holder.test.ts` has **no** such device — measured, zero
`@ts-expect-error` directives in the file, against nine in `db-locks.test.ts`
and one in `entry-conflict.test.ts`. Counted on the directive rather than on the
string: `db-locks.test.ts` also names `@ts-expect-error` in prose inside a
docblock, so a bare `grep -c` answers ten and overstates the device by one.

```
$ grep -cE '^\s*//\s*@ts-expect-error' src/lib/db-locks.test.ts
9
$ grep -cE '^\s*//\s*@ts-expect-error' src/lib/entry-conflict.test.ts
1
```

So `ruleSlotHolder`'s argument rule rests on an accident of `Omit`'s shape that
nothing pins, one file over from the paragraph explaining why that is not
enough.

## The design: two rules, two mechanisms

The premise sweep splits one prose paragraph into two independently checkable
claims. Keeping them apart is the whole design.

| Claim | Held by | Gap |
|---|---|---|
| **The argument.** "always against `db`, never `tx`" | The type signature, `PrismaClient` vs `Omit<PrismaClient, ITXClientDenyList>` | Unpinned for `ruleSlotHolder`; pinned for `probeConflictingEntry` |
| **The placement.** "must sit after its own transaction's closing `)`" | Nothing | Both helpers |

### Task 1 — pin the argument rule

A never-called function in `rule-slot-holder.test.ts` whose `@ts-expect-error`
fails to fire if the parameter is ever widened, modelled on the one in
`entry-conflict.test.ts`. `tsconfig.json` includes every `.ts` in the repo, so an
unused `@ts-expect-error` fails `tsc --noEmit` rather than leaving a green suite.
Zero runtime cost.

This is what makes the reachable defect exactly one shape — a call inside the
callback passing the outer client — which is what Task 2 then censuses.

### Task 2 — census the placement rule

`src/lib/probe-placement-census.test.ts`, over both helpers.

**The rule.** No call to either probe may sit lexically inside the callback
argument of a `$transaction(…)` call.

**Two censuses, deliberately unlike each other**, the same shape as the sibling
file: the calls are read from the syntax tree (so a mention in a comment or a
string is not a call, and a call that never says `await` still is one); the
transaction callbacks are read from the syntax tree too, but by a *different*
predicate — a call whose callee is a member named `$transaction`, and whose first
argument is a function. A call is bad iff walking up its ancestors reaches a
function node that is the first argument of such a call.

**Following the helper into a file** reuses the sibling's approach: the helper's
own name, plus any local name an import specifier binds it to from a module
specifier whose last segment is the defining module's basename, plus a namespace
member read by property access or string key, through `(f)(…)` and `f!(…)`
wrappers.

**Compiler tethers.** Each helper name is
`satisfies keyof typeof import('./<module>')`, so a rename fails the file with
the module's real exports listed rather than quietly censusing zero calls —
*Comment Discipline*'s "where membership matters, tether it to the compiler". The
import is a type position and erases.

**Non-vacuity, which is where a census like this actually dies.** Four guards,
each answering a different way the file could go green while watching nothing:

1. *Both defining modules exist on disk.* Their paths are what alias-following
   matches against, so a moved file silently stops following aliases. Named once
   here rather than inferred from a census that quietly shrank.
2. *The walk reaches every area of `src/`.* Copied from the sibling, and it
   matters more here: all eight call sites live under `src/services` and
   `src/app`, so a filter edit dropping other areas leaves every total non-zero.
   Compared against a walk written separately from the one under test.
3. *Each helper's call census is non-empty.* A file walk that stops matching
   reports no misplaced call, which is indistinguishable from a healthy tree.
4. *The transaction-callback detector fires against the real tree.* This is the
   guard the sibling file has no analogue for, and the one this census would die
   without: if `$transaction` detection breaks, every call reports "not inside a
   transaction" and the suite stays green forever. Asserted as a non-zero count
   of recognised callbacks under `src/`, and pinned arm-by-arm by fixtures.

**Fixtures**, over sources this repository does not contain, because the real
tree holds exactly one shape — a correct call, outside every callback. Without
them the entire detector could be deleted and the suite would stay green. Each
fixture is a shape a future call site could take: a call inside an arrow
callback, inside a `function` callback, under a receiver that is neither `db` nor
`prisma`, nested two blocks deep inside the callback, inside a `catch` *within*
the callback, after the callback's closing `)` (clean), before the transaction
(clean under this rule — see the limits), in the array form of `$transaction`
(which has no callback to be inside), reached through an import alias, and
reached as a namespace member.

**What it does not see, so a call site landing there is nobody's failure here.**
Test files are excluded: a test may place a probe wrongly on purpose to
demonstrate what happens, and this rule is about production call sites. A call
reaching a probe through a local binding (`const f = ruleSlotHolder; f(db, …)`)
is not seen, nor `(0, ruleSlotHolder)(…)` — resolving those needs a full
type-checker program this test does not build. A probe called from a helper
function that is itself invoked from inside a transaction is dynamically inside
and lexically outside; this census reads lexical position only. A callback passed
by name (`db.$transaction(handler)`) puts `handler`'s body out of reach for the
same reason. And the census assumes its files parse: `ts.createSourceFile` does
not throw, so a syntax error censuses zero calls quietly — `npm run typecheck` in
CI's `checks` job is what holds that, making this defence in depth.

The defining modules are **not** excluded, unlike the sibling's `db-locks.ts`.
That exclusion existed because the convention's marker text lived in the defining
module; there is no marker here, and neither module calls its own probe, so
including them costs nothing and catches a self-call added later.

### Task 3 — amend both paragraphs

`rule-slot-holder.ts:40–56` and `entry-conflict.ts:195–208`, in the shape #465
used on `db-locks.ts`: keep NO ROSTER HERE and the re-derivation command, add
what is enforced and by what, add what is not.

Specifically, each paragraph has to stop implying that `25P02` is the live
hazard. It is the reason the signature is what it is, and the signature is what
prevents it; the live hazard for a misplaced call is the second connection. Both
`rule-slot-holder.ts:59` ("the same contract `probeConflictingEntry` … carries
one layer down") and `entry-conflict.ts:156` (`probeOverlappingCandidates`
"deliberately IS" the wider signature) are pointers that must still land after
the edit — §4's "correct a claim in every artifact", and *Comment Discipline*'s
rule that a comment states what is true now rather than what it used to say.

## Acceptance

1. A test fails when a call to either probe is placed lexically inside a
   `$transaction(…)` callback, and passes on the eight correct call sites.
2. A test fails when either probe's parameter is widened to accept a transaction
   client.
3. Both proven by mutation, exact failure text recorded, restored, re-verified —
   including mutations of the census's own guards, since a guard that compiles
   but cannot fail certifies nothing.
4. Both docblock paragraphs say what is enforced and what is not, and every
   cross-pointer in them still lands.

## What this does not do

- It does not decide whether a call site is *semantically* right — whether the
  transaction it probes after is the one it ought to. That is a judgement about a
  whole function, the same limit the sibling census states about verdicts.
- It does not catch a dynamically-nested probe. Lexical only, stated above.
- **#464 is unaffected**; its census stands as merged. This reuses its shape and
  adds the transaction-detector guard it had no need of.
