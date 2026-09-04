# A signed-in browser and the signup it cannot start

**Issue:** #431 (both halves — the dead end, and the `/verify` copy mismatch
that issue calls "secondary, smaller").

**Measured against `c7beef7e`.** Every file:line below refers to that commit.

## The property

Three of the four places below share one cause: **a route that refuses
something states the refusal by moving the browser, and a redirect carries no
words.** `/signup` refuses a second signup by bouncing. `/signup/profile`
refuses a teacher by bouncing. `magic-link/verify` refuses nothing and so
sends the browser somewhere it will immediately be bounced from again.

Each bounce is individually correct — the reasoning in `/signup`'s docblock is
sound and is preserved here in full. What none of them does is *say* anything,
and the thing left unsaid is the same sentence every time: **you are signed in
as this address, and that is why you cannot use a different one.**

This spec does not change what any of these routes permit. A teacher still
cannot start a second signup; a signed-in student still cannot type a
different address. It changes only whether the refusal is legible, and whether
the one escape hatch that exists — signing out — is reachable from the flow
that needs it.

## Premise verification

Issue #431 is itself a re-scope of a note in #430, and its own premise needed
checking. Four of its five claims hold; one does not.

| Claim | Verdict |
|---|---|
| `/signup` turns away every signed-in visitor with no message | **Holds.** `signup/page.tsx:23-24`, both redirects, evaluated on GET |
| Teacher → `/schedule`, silent; `/signup/profile` would bounce them the same way | **Holds.** `signup/profile/page.tsx:38` is the identical line |
| Student-only → `/signup/profile`, session mode, no field to change the address | **Holds.** `ProfileSetupForm` has no email input in either mode |
| "…no explanation of why **the address they typed** is gone" | **Does not hold.** Both `/signup` redirects fire on GET, before any form renders — the visitor never types an address. Session mode also *names* the address it is using: `profile-setup-form.tsx:341`, "Adding a teacher page to `<email>`". What is absent is not the address but the *reason* it is fixed, and any exit |
| The sign-out escape hatch is not signposted in this flow | **Holds.** `SignOutButton` is mounted at `(teacher)/settings/page.tsx:44` and `(student)/account/page.tsx:80`, nowhere else |
| Secondary: an existing teacher gets "Taking you to set up your page now." and one extra hop | **Holds.** `teacher-signup/route.ts:47` sends the destination unconditionally; `verify/route.ts:87-88` accepts any safe relative path over the `fallback` it computed at line 86 |

The corrected wording matters for the fix. Because the redirect precedes the
form, no version of this can "restore what they typed" — there is nothing to
restore. The whole remedy is a sentence and a link.

**Reachability.** `/signup` is linked from `(public)/page.tsx:33` (the landing
page) and `login/page.tsx:85`. Neither hides the link for a signed-in visitor,
so both dead ends are one tap from a page a signed-in person can be on.

**Scope.** There is no student *signup page* — student signup happens inline
on `(public)/[slug]/book/[classId]/page.tsx`. The parallel-families divergence
that generated #428 does not apply here: this shape exists on the teacher side
only, because only the teacher side has a standalone signup page to be turned
away from.

## Use cases this must satisfy

1. **A teacher sets up a second page for a studio address.** They are signed
   in as their personal address. They must be told that is why `/signup` will
   not take a new one, and be able to sign out from that page.
2. **Someone helps a colleague on a shared laptop.** Same shape; the helper is
   signed in, the colleague's address is the one wanted.
3. **A signed-in student becomes a teacher for their own address.** Must keep
   working exactly as today — straight to `/signup/profile`, session mode, no
   email round trip. This is the reason `/signup`'s student redirect exists and
   nothing here weakens it.
4. **An existing teacher uses the signup form as a login.** They get an
   ordinary sign-in link (`teacher-signup/route.ts:35`, `purpose: 'sign_in'`).
   They must land on their schedule, and the `/verify` copy must say so.
5. **An existing *student* uses the teacher signup form.** They get a sign-in
   link too, and must still land on `/signup/profile` — that is use case 3
   arriving by email instead of by redirect.

Use cases 4 and 5 are the two directions of the same branch and are the reason
the fix keys on `resolved.teacherId` rather than on the purpose or the path
alone.

## Change 1 — `/signup` says no instead of bouncing

`src/app/(public)/signup/page.tsx`

`if (session?.teacherId) redirect('/schedule')` is replaced by rendering an
explanatory panel. `if (session) redirect('/signup/profile')` is unchanged.

The teacher redirect's *purpose* is preserved: a teacher is still not offered a
second signup form. What changes is that the refusal happens on the page they
asked for, in words, with both exits — their schedule, and signing out.

The panel needs the account's email. `SessionUser` (`src/lib/types.ts:32`)
carries `sessionId`, `accountId`, `teacherId` and `studentId` and no address,
so the page reads it the way its sibling already does at
`signup/profile/page.tsx:42` — `account.findUniqueOrThrow({ select: { email:
true } })`. Two call sites of a four-line query; no helper is extracted for
that, and one would only add a name to look up.

New component: `src/components/signup/already-teaching-panel.tsx`. Server
component holding the copy, with `SignOutButton` (a client component) as its
only interactive child. Visually it follows `AlreadySignedInState`
(`verify/page.tsx:245`) — `type-label` / `type-display` / `type-body`, a teal
pill link, fineprint — because that state is the same message in a different
flow, and the two should not look like different products.

Copy:

```
Already teaching                                  (type-label, teal)
You already have a page.                          (type-display)
You're signed in as ivo@example.com, and that      (type-body)
address already has a teacher page.
[ Go to your schedule ]                           (pill link → /schedule)
Setting up a page for a different address?         (fineprint + sign-out)
Sign out first.
```

**The docblock.** `signup/page.tsx`'s header currently explains why *both*
redirects exist, as a pair. Half of that pair is going away. Per CLAUDE.md's
Comment Discipline the paragraph is **replaced with what is true after this
change** — not annotated with what it used to say. The before-and-after belongs
in the PR body. The student-redirect reasoning (submitting the form as a
signed-in student mails an ordinary sign-in link that "lands back where they
started and never creates a teacher") is unchanged and survives verbatim; only
the teacher sentence is rewritten.

## Change 2 — `/signup/profile` session mode explains the address

`src/components/signup/profile-setup-form.tsx`

Session mode's intro at line 341 already names the address. One line is added
beneath it, session mode only:

> That's the address you're signed in with. Setting up a page for a different
> one? **Sign out** and start again.

with the sign-out control inline. Ticket mode gains nothing — there the address
came from the link the reader themselves requested, and there is no session to
sign out of.

**`/signup/profile:38`'s teacher redirect is left silent, deliberately.** It is
a step-two page nobody reaches by intent: `/signup` is the entry point, and
after Change 4 no email link routes a teacher there either. Adding a second
copy of the panel to a page reached only by direct navigation or a stale
bookmark buys a rare case a paragraph that then has to be kept in sync with
Change 1's. If it turns out to be reachable in practice, the panel component
already exists to mount there.

## Change 3 — `SignOutButton` learns where to land

`src/components/account/sign-out-button.tsx`

An optional prop, `redirectTo = '/login'`. Both existing call sites are
unchanged by the default; the two signup-flow mounts pass `/signup`, because a
person signing out *in order to sign up* wants the signup page, not the login
page.

The mechanics are untouched. #40's comment explains why the component pushes
and refreshes rather than blocking on either: neither commit is guaranteed on a
starved device, and resetting `busy` regardless is what keeps the button
tappable instead of stranding someone in an authenticated shell. That reasoning
is independent of the destination. `router.refresh()` is also what makes the
new destination correct — it re-renders the destination's server components
against the now-cleared cookie, which is exactly what `/settings` already
depends on to stop rendering as signed-in.

**One subtlety, named so it is handled rather than discovered.** Change 1's
mount is *on* `/signup` and passes `/signup`, so the push is to the route the
browser is already on. The push alone would be entitled to serve the cached
RSC payload — the one rendered while signed in, which is the panel. It is
`router.refresh()` that makes this case work, by invalidating that cache and
refetching the route against the cleared cookie. Not a new mechanism, only the
same one carrying more weight than it does at `/settings`, where the
destination differs from the origin. The `/signup` page test cannot observe
this (it renders a server component directly, with no router), so the plan
verifies it in the running app instead.

## Change 4 — the verify destination stops naming a page that will bounce

`src/app/api/auth/magic-link/verify/route.ts:86-88`

Today:

```ts
const fallback = resolved.teacherId ? '/schedule' : '/bookings';
const redirectTo =
  tokenRedirect && isSafeRelativePath(tokenRedirect) ? tokenRedirect : fallback;
```

The route computes, at line 86, the exact fact needed to reject
`/signup/profile` for an account that already teaches — and then discards it
for any safe relative path. The policy is not missing from the codebase; it is
expressed one hop too late, in `/signup/profile`'s own first line
(`signup/profile/page.tsx:38`), after the browser has already been sent there
and the `/verify` copy has already promised something false.

The fix: a `tokenRedirect` of `TEACHER_PROFILE_PATH` is not honoured when
`resolved.teacherId` is non-null, and falls through to `fallback`.

Scoped to that one path, not to redirects in general. Every other destination a
token can carry is a page the sender chose and the recipient can use; this is
the only one whose usability depends on a profile the route can see and the
minting endpoint could not. `teacher-signup/route.ts:47` is *right* to send it
unconditionally — its own comment says why, and that reasoning is not disturbed
here: `purpose` decides whether an account may be created, `redirectTo` decides
where the person lands, and conditioning the destination on account existence
is what #430 fixed. This change conditions on something else entirely
(teacher-profile existence, at verification time, which is the only moment it
is knowable), and it does so in the one place that knows it.

**What this fixes downstream, without touching it.** `destinationCopy`
(`verify/page.tsx:117`) keys on the path alone and cannot see the reader's
profile — issue #431 notes this as the mechanism. It stays exactly as it is.
The path it is handed becomes true, so `'/schedule'` → "Taking you to your
schedule now." falls out. Fixing the copy instead of the path would leave the
pointless hop; fixing the path fixes both, and leaves one fewer branch in the
copy function.

**Use case 5 is the direction that must not regress.** An existing account with
`teacherId === null` that used the teacher signup form still receives
`/signup/profile`, still lands in session mode, still adds the second hat. The
condition is `resolved.teacherId`, not `purpose`, not "the token carried a
destination" — and the test for this change asserts both directions, because a
guard written as `tokenRedirect === TEACHER_PROFILE_PATH ? fallback :
tokenRedirect` would pass a one-directional test and break use case 5.

## Testing

Every guard below is proven by breaking it, recording the failure text,
restoring, and re-verifying — the plan carries this as an explicit step per
guard, not as a closing sweep.

**`src/app/(public)/signup/page.test.tsx`** (new; `components` project, jsdom).
Mirrors `signup/profile/page.test.tsx`'s pattern exactly: `next/navigation`'s
`redirect` mocked to throw `REDIRECT:<path>`, `@/lib/session` and `@/lib/db`
mocked, the server component awaited and its tree stringified.

- A teacher session renders the panel — the tree contains the account's email
  and a sign-out control — **and throws no redirect.** The negative half is the
  assertion that would have failed before this change.
- A student-only session still throws `REDIRECT:/signup/profile`. Use case 3.
- No session renders the email form.

**`src/components/signup/profile-setup-form.test.tsx`.** Session mode renders
the sign-out escape hatch; ticket mode does not. The second assertion is the
one with teeth — an unconditional line would pass the first.

**`src/components/account/sign-out-button.test.tsx`.** The default destination
is still `/login` (the two existing call sites depend on it); an explicit
destination is honoured.

**Integration, `tests/integration/teacher-signup-api.test.ts`.** Both
directions of Change 4, against the live app:

- an existing **teacher** verifying a link minted by `teacher-signup` receives
  `redirectTo: '/schedule'` — use case 4;
- an existing **student** verifying the same kind of link still receives
  `redirectTo: '/signup/profile'` — use case 5.

Existing coverage that must stay green rather than be rewritten:
`tests/integration/signup-api.test.ts`, `tests/integration/auth.test.ts`,
`src/app/(public)/verify/page.test.tsx`,
`src/app/(public)/signup/profile/page.test.tsx`. Any of them turning red is a
finding about this change, not a test to adjust.

## What this does not do

- **#430 is unaffected** — its precedence flip and the session/ticket
  coexistence it closed are untouched. This spec adds no ticket reads and no
  session writes.
- No change to what `/signup`, `/signup/profile` or `magic-link/verify`
  *permit*. No new way to create a teacher, no new authorization.
- `destinationCopy` and `newSignupHeadline` (`verify/page.tsx:113`, `:125`) are
  not modified.
- `teacher-signup/route.ts`'s unconditional `redirectTo` is not modified.
- No student-side equivalent, because there is no student signup page.
- `/signup/profile`'s own teacher redirect stays a silent bounce, for the
  reason given under Change 2.
