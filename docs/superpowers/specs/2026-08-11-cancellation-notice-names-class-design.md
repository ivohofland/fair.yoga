# Every cancellation notice names the class (#200)

## Summary

#112 established the rule and PR #195 applied it to three of five
`class_cancelled` bodies. Two were left behind. This finishes the set.

**This changes copy and nothing else.** No behaviour, no recipients, no schema,
no query — both bodies interpolate fields the surrounding code already has.

## What the issue said, and what measurement showed

I filed #200 myself after #195's review. Two of its claims do not survive
checking, and one of them is why this is workable at all.

| #200 claim | Verdict |
|---|---|
| `transition/route.ts:63` writes `${cls.classType} has been cancelled by your teacher.` with no day or time | **Holds**, verbatim. |
| The other paths name the class in full | **Holds** for all three student-facing bodies, verified verbatim. |
| No test asserts this body | **Holds** — `grep "cancelled by your teacher"` across `src/` and `tests/` returns the source line and nothing else. |
| *"three of the four cancellation paths name the class and the fourth does not"* | **Incomplete.** There are **five** production `class_cancelled` sites, not four, and **two** are unnamed — the second is auto-cancel's *teacher* notice. |
| *"the integration project drives the app on :3000 — which serves the main checkout, not the PR's worktree"* — the stated reason for filing rather than folding | **No longer true.** The #112 worktree was removed after that PR merged; `lsof` on :3000 now resolves to `/Users/ivohofland/Projects/fair.yoga`, this checkout. Working on a branch here means the integration suite exercises this code. The blocker expired with the worktree. |

### The census

`grep -rn "type: 'class_cancelled'" src --include="*.ts"`, minus `*.test.ts`,
returns five production sites. Named rather than counted, with the body each
carries today:

| Site | Audience | Names the class? |
|---|---|---|
| `app/api/classes/[id]/transition/route.ts:63` | student | **no** — `${classType} has been cancelled by your teacher.` |
| `services/class-transitions.ts:352` | student | yes (#195) |
| `services/class-transitions.ts:360` | **teacher** | **no** — `${classType} was cancelled — only N of M minimum students registered.` |
| `services/gdpr.ts:798` | student | yes (#195) |
| `services/class-template-lifecycle.ts:783` | student | yes (#195) |

Five sites, four paths: auto-cancel is the one path that notifies two
audiences, which is exactly how its teacher body escaped #195 — that PR
widened the *student* recipient list on three paths and never looked at the
`notifications.push` two lines below.

## Why the teacher case may be the worse of the two

A student's inbox row *can* link; `studentNotificationHref`
(`lib/notification-links.ts`) merely declines to produce one for a cancelled
class, deliberately, because the destination is a booking page that can no
longer do anything for them.

A teacher's row can never link, for any notification type.
`app/(teacher)/inbox/page.tsx:9-18` selects no `relatedClass` and passes
`notifications` bare to `NotificationList`, so its `hrefById` prop is
`undefined` and every row renders inert.

So for the teacher, the body is not merely the best channel — it is the only
one. A teacher running two weekly Hatha classes reads `Hatha was cancelled —
only 1 of 4 minimum students registered.` and has no route, from that row, to
which class it was.

**That gap is filed separately as #201**, with the measurement that the
`NotificationList` component already accepts `hrefById` and already honours it,
so the missing piece is the page and a helper rather than the component.

**#201 does not remove the need for this change**, in either direction:

- The student half is untouched by it — `studentNotificationHref` returns null
  for a cancelled class by design, so no link work reaches this path.
- The teacher half is only partly addressed by it — three cancelled Hatha
  classes still render as three identical rows, disambiguated only by opening
  each one.

## The rule

> A cancellation notice names the class it is about — type, day, time —
> whatever the audience and whatever path sent it.

## Changes

Both use `formatDayHeader` (`lib/format.ts`), the renderer every other
student-facing surface uses (`(student)/bookings`, `(public)/[slug]`,
`(public)/[slug]/book/[classId]`, `components/schedule/class-list`) and the one
#195 standardised these bodies on. Not `formatDateShort`: #96 existed to
collapse three divergent date renderings into one after a teacher saw two of
them one tap apart, and the weekday is the most useful discriminator for
someone with a weekly class.

### `app/api/classes/[id]/transition/route.ts:63`

```
${cls.classType} class on ${formatDayHeader(cls.date)} at ${cls.startTime} has been cancelled by your teacher.
```

`cls` is a full `prisma.class.findUnique` row (`:24`), so `date` and
`startTime` are already in hand. No query change. One new import.

### `services/class-transitions.ts:360`

```
${fresh.classType} class on ${formatDayHeader(fresh.date)} at ${fresh.startTime} was cancelled — only ${activeCount} of ${fresh.minStudents} minimum students registered.
```

`fresh` already selects `date` and `startTime` (its `findUnique` opens at
`:262`); the file already imports `formatDayHeader` at `:14`, added by #195 for
the student body twelve lines above this one — which is the clearest evidence
that this site was simply not looked at rather than deliberately left. The
"only N of M" clause stays — it is the one piece
of context this body carries that the others do not, and it is what tells a
teacher *why*.

Bodies are built from `fresh`, not `cls`, on this path. That is pre-existing
and load-bearing: a notice naming the pre-lock snapshot describes a class that
no longer exists in that shape. The two new interpolations follow the same
rule.

## Testing

The same one-line defect needs two different test levels, because the two
sites sit at different layers.

### Integration — `tests/integration/classes-api.test.ts`

The manual-cancel body is reachable only over HTTP: the transaction, the
recipient fan-out and the body string all live inline in the route handler,
not in a service.

`classes-api.test.ts:100-104` says its cancel fixture has no registrations or
waitlist entries, deliberately, so "the cancel transaction's notification
fan-out has nothing to notify". That fixture therefore cannot carry this
assertion, and a new one is needed: an `open` class with a student registered
**over HTTP** — the pattern the file already uses for its economic-lock
fixture, so the registration comes from the app's own behaviour rather than a
direct write.

Assert the notification body contains the class type, `formatDayHeader(date)`
and `startTime`, derived from the fixture rather than hard-coded.

### Unit — `services/class-transitions.test.ts`

The existing auto-cancel test asserts only that a teacher note exists. Extend
it to assert the body, with the same three components.

### Mutations

| Guard | Mutation | Test that must fail |
|---|---|---|
| Manual-cancel body | revert to `${cls.classType} has been cancelled by your teacher.` | the new integration assertion |
| Teacher body | revert to `${fresh.classType} was cancelled — only …` | the extended auto-cancel test |

Each broken, the exact error recorded, restored, re-verified.

Note what these mutations can and cannot show. Both bodies are pure string
interpolation with no branching, so the realistic regression is not a logic
error — it is someone reverting the copy, or a future edit dropping a field.
Asserting all three components separately is what catches the second case; a
single whole-string assertion would go red on any rewording and teach the next
person to loosen it.

## Out of scope

- **The teacher inbox's missing link** — #201. Larger, and orthogonal: see
  above for why neither substitutes for the other.
- **The teacher body's "only N of M" clause.** Kept as-is.
- **Titles.** `'Class cancelled'` / `'Class auto-cancelled'` are unchanged;
  the identity belongs in the body, where there is room for it.
- **The other three bodies**, already correct as of #195.
- **`studentNotificationHref`'s refusal to link a cancelled class.** That is a
  deliberate product decision with its reasoning recorded beside it, and this
  change is what makes it survivable rather than a reason to revisit it.

## Risks

- **Body length.** The teacher's notice grows from one clause to two before the
  "only N of M". Read once at the terminal it is long; read in an inbox list
  beside two other cancelled classes it is the difference between actionable
  and not.
- **Assertion brittleness.** Three `toContain` checks per body will fail on a
  deliberate rewording. That is the intended cost — the alternative is an
  assertion that cannot detect the field being dropped.
