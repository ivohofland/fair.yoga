# Recording the #171 decision (TeacherBlock survives student erasure) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every "open, undecided" statement about what student erasure does to `TeacherBlock` with the decision taken on #171 (retain the row as a suppression entry), and tell an erasing student, before they commit, that the address behind a refusal is kept.

**Architecture:** No behaviour changes. `deleteStudentAccount` already leaves `TeacherBlock` untouched, and `src/services/invitations.decline.test.ts` already pins that a block survives erasure (commit `2a4da3c1`, #522). What changes is the record — `docs/data-model.md` § TeacherBlock and three comments in `src/services/gdpr.ts` — and one sentence of student-facing copy in the delete confirmation, which is test-first.

**Tech Stack:** Next.js 16 client component, Vitest `components` tier (jsdom, `@testing-library/react`), Markdown docs.

**Spec:** None — a single design, chosen on issue #171 with the user on 2026-09-15. The decision's reasoning lands in `docs/data-model.md` itself (Step 8), which is its permanent home.

## Global Constraints

- Work only in the worktree `/private/tmp/fix-171` (branch `docs/171-teacherblock-erasure-decision`). Never `git add -A` / `git add .`; stage exact paths.
- CLAUDE.md *Comment Discipline*: a comment annotates the code it sits on; anything reaching past its file goes in `docs/` and the comment links there. No counts or member lists in comments. Comments state what is true now — never "this previously said X".
- The new copy sentence, verbatim: `If you've said no to a teacher, we keep your email address only so they can't invite you again.`
- It appears on the **student** confirmation only (user's call on #171). Do not add it to the teacher branch.
- Do not alter the sentence `This permanently removes your personal data and signs you out.` — `tests/e2e/account.spec.ts:122` matches `/permanently removes your personal data/`.
- Do not change `deleteStudentAccount`'s behaviour or its statements — only comments.
- Leave `CLAUDE.md`'s Open Questions line `GDPR/legal review — parked for proper legal consultation` unchanged: the wider review stays parked, and #171 is one decision the new docs paragraph says that review can reopen.
- Files under `docs/superpowers/specs/` and `docs/superpowers/plans/` are records; do not edit them (the 2026-09-09 spec's "remains parked" wording stays as history).
- The decision is recorded as **decided, reopenable by the wider legal review** — not as provisional.

---

### Task 1: Record the #171 decision in copy, docs and comments

One task on purpose: the copy, the docs paragraph and the three comments all state the same decision, and the likeliest defect is disagreement between them. A single reviewer seeing all of it is the check for that.

**Files:**
- Create: `src/components/account/data-and-deletion.test.tsx`
- Modify: `src/components/account/data-and-deletion.tsx:97-101`
- Modify: `docs/data-model.md` — line 219 (cross-reference), lines 223-231 (the open paragraph and its two bullets), line 235, line 253
- Modify: `src/services/gdpr.ts` — lines 325-327 (docblock), 635-651 (site comment), 1380-1382 (`deleteTeacherAccount` comment)

**Interfaces:**
- Consumes: `DataAndDeletion({ role }: { role: 'student' | 'teacher' })` from `src/components/account/data-and-deletion.tsx` (unchanged signature). `tests/setup/components.ts` already mocks `next/navigation`, so `useRouter` works under render.
- Produces: nothing consumed by other code.

- [ ] **Step 1: Install dependencies in the worktree**

A fresh worktree has no `node_modules`, and `verifyDepsBeforeRun: error` makes every `pnpm exec`/`pnpm run` fail until this runs.

Run: `pnpm install --frozen-lockfile`
Expected: completes without `ERR_PNPM_*`.

- [ ] **Step 2: Write the failing component test**

Create `src/components/account/data-and-deletion.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DataAndDeletion } from './data-and-deletion';

/**
 * #171. Erasing a student keeps each refusal they made (`TeacherBlock`) with
 * the address it is matched on, so the student confirmation says so before
 * they commit. Why the row is kept: `docs/data-model.md` (TeacherBlock).
 */
describe('DataAndDeletion', () => {
  it('tells a student that the email address behind a refusal is kept', () => {
    render(<DataAndDeletion role="student" />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete account' }));

    expect(
      screen.getByText(/we keep your email address only so they can't invite you again/),
    ).toBeInTheDocument();
  });

  it('does not tell a teacher-only confirmation about refusals', () => {
    render(<DataAndDeletion role="teacher" />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete account' }));

    // Positive first: without it, the negative below would also pass on a
    // confirmation that never opened.
    expect(screen.getByText(/permanently removes your personal data/)).toBeInTheDocument();
    expect(screen.queryByText(/can't invite you again/)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run it and watch the student case fail**

Run: `pnpm exec vitest run --project components src/components/account/data-and-deletion.test.tsx`
Expected: 1 failed, 1 passed. The student test fails with `Unable to find an element with the text: /we keep your email address only so they can't invite you again/`. The teacher test passes (it is the negative guard; Step 6 proves it can fail).

- [ ] **Step 4: Add the sentence to the student copy**

In `src/components/account/data-and-deletion.tsx`, replace:

```tsx
              {role === 'student'
                ? ' Past class and payment records stay with your teachers, without your name attached. Upcoming bookings are cancelled.'
                : ' Your upcoming classes are cancelled and registered students notified. Completed classes and payment records stay with your students, without your details attached.'}
```

with:

```tsx
              {role === 'student'
                ? " Past class and payment records stay with your teachers, without your name attached. Upcoming bookings are cancelled. If you've said no to a teacher, we keep your email address only so they can't invite you again."
                : ' Your upcoming classes are cancelled and registered students notified. Completed classes and payment records stay with your students, without your details attached.'}
```

(Double quotes because the string now contains apostrophes.)

- [ ] **Step 5: Run the test and see both pass**

Run: `pnpm exec vitest run --project components src/components/account/data-and-deletion.test.tsx`
Expected: 2 passed.

- [ ] **Step 6: Prove the teacher-side guard bites**

Mutation — the realistic regression is the sentence moving out of the role branch into the shared text. Temporarily change the shared sentence on the line above the ternary to:

```tsx
              This permanently removes your personal data and signs you out. If you&apos;ve said no to a teacher, we keep your email address only so they can&apos;t invite you again.
```

Run: `pnpm exec vitest run --project components src/components/account/data-and-deletion.test.tsx`
Expected: the teacher test FAILS on `expect(...).not.toBeInTheDocument()` (the student test may also fail with `Found multiple elements` — record whatever actually prints). Record the exact failure text for the report.

Restore the file (`git diff src/components/account/data-and-deletion.tsx` must show only the Step 4 change), re-run the same command, expect 2 passed.

- [ ] **Step 7: Commit the copy and its test**

```bash
git add src/components/account/data-and-deletion.test.tsx src/components/account/data-and-deletion.tsx
git commit -m "feat(gdpr): tell an erasing student the address behind a refusal is kept (#171)"
```

(End the message with the session's `Co-Authored-By` trailer.)

- [ ] **Step 8: Replace the open paragraph in `docs/data-model.md` § TeacherBlock**

Replace the whole block from `**Open, and deliberately unresolved: what erasing a student should do to this row.**` through the closing fence of the two-line `sh` block that follows the *Scrub or hash the address* bullet (currently lines 223-231) with exactly:

````markdown
**Decided (#171): erasing a student leaves this row exactly as it stands.** `deleteStudentAccount` (`src/services/gdpr.ts`) keeps the row — the erased person's plaintext address included — as a suppression entry: the least that has to be kept to go on honouring a refusal that person made. It is **one** decision: both routes above write this row, so it covers every refusal whichever way the student said no. It was made as a product call, not on legal advice, and the GDPR/legal review `CLAUDE.md` parks can reopen it; if it does, this paragraph is where the new answer lands.

- **The same person stands on both sides.** Every option trades one of the subject's interests against another — the erasure they asked for, and the refusal they made. The refusal is the more specific instruction, about one teacher, and asking to be forgotten does not withdraw it. The erased person's real mailbox still exists in the world: if the teacher re-types that address, this row is what makes `inviteContact` compute `delivered: false`, so no invitation email is sent.
- **The row is already the minimum, and the teacher never sees it.** It holds the teacher, the address a refusal has to be matched on, and when it was written. The retained address is never surfaced to the teacher (see the #520 paragraph below), so nobody the subject refused can read it back.
- **The subject is told before they commit.** The student delete confirmation (`src/components/account/data-and-deletion.tsx`) says the address behind a refusal is kept, and why. A dual-role account deleting from teacher settings is shown the teacher copy, which does not say it — the same gap the student copy's other sentences already have there, since `DELETE /api/account` erases every profile the account holds.

The accepted cost is a retained plaintext address belonging to someone who asked to be forgotten. Declined:

- **Scrub the address**, the way `Invitation.email` is scrubbed. Honours the erasure literally, but lookups are `teacher_id` + exact `email` (`unique (teacher_id, email)`), so a scrubbed row matches nothing and the block silently stops blocking — an intact-looking row that no longer does its job, with nothing reporting that it lapsed.
- **Hash the address.** Only equality is ever needed, so a hash would keep every lookup working without plaintext. But a plain hash of an email is reversible by dictionary — the teacher's own contact list is the dictionary — so it would need a keyed hash with a secret pepper, and a keyed hash of an address is still pseudonymised personal data: it changes the security posture, not the legal answer. It also swaps one silent failure for another, since a lost or rotated pepper un-refuses every student at once. `docs/superpowers/specs/2026-09-09-decline-suppression-entry-design.md` costs it for this deployment. If it is ever reopened, the sites that would have to hash first take two commands, not one — a Prisma relation filter names the relation field rather than the model accessor, so `listPendingInvitations`'s `teacherBlocks: { none: { email } }` is invisible to the obvious grep:

  ```sh
  grep -rn "teacherBlock\." src/ | grep -v '\.test\.'
  grep -rn "teacherBlocks" src/ | grep -v '\.test\.'
  ```
- **Expire the row after some period.** The refusal's purpose lasts as long as the teacher can type the address, so an expiry is the scrub's silent lapse on a timer.
````

- [ ] **Step 9: Repoint the three other `docs/data-model.md` sites that call the question open**

1. Line 219 — replace `the same grep-reads-syntax hazard the *Scrub or hash* bullet below hits with the \`teacherBlocks\` relation filter.` with `the same grep-reads-syntax hazard the *Hash the address* bullet below hits with the \`teacherBlocks\` relation filter.`
2. Line 235 — replace `which is why the retain-vs-scrub question above is about a retained plaintext address and not about a standing no going quiet.` with `which is why the #171 decision above weighed a retained plaintext address, not a standing no going quiet.`
3. Line 253 — replace the whole paragraph beginning `Why this resolves while \`TeacherBlock\`'s retain-vs-scrub question above stays parked` with:

```markdown
Why the two resolve in opposite directions, given #520 filed them as the same shape: the retained `TeacherBlock` address is never surfaced to the teacher — that invisibility is the whole reason it lives in its own table — while the `Invitation` row option A would have spared is read by `GET /api/invitations` and the contacts page. Retained-and-invisible is a different bargain from retained-and-readable: this section refuses the second, and #171 above accepts the first.
```

- [ ] **Step 10: Replace the three `src/services/gdpr.ts` comments**

1. `deleteStudentAccount` docblock (lines 325-327) — replace:

```ts
 * - `TeacherBlock` rows left standing on purpose — they are what carries the
 *   subject's refusal past that anonymization; the tension is written down at
 *   the site and in `docs/data-model.md`
```

with:

```ts
 * - `TeacherBlock` rows left standing on purpose — they are what carries the
 *   subject's refusal past that anonymization (#171, `docs/data-model.md`)
```

2. Site comment (lines 635-651, the block starting `// \`TeacherBlock\` is DELIBERATELY not touched here, and the omission is` and ending `// this is exactly that call. Do not resolve it from in here.`) — replace the whole comment with:

```ts
    // `TeacherBlock` is deliberately not touched: each row is the subject's
    // refusal of one teacher, kept as a suppression entry (#171). The scrub
    // above frees `(teacherId, email)`, so this row is then all that stands
    // between the subject's real mailbox and mail from a teacher they refused
    // — and every lookup is `teacherId` + exact `email`, so scrubbing it
    // would silently disarm it. Why retention was chosen over scrubbing or
    // hashing: `docs/data-model.md` (TeacherBlock).
```

3. `deleteTeacherAccount` (lines 1380-1382) — replace:

```ts
      // the only direction that cannot hurt the person the block protects. The
      // student-erasure side of the same question is genuinely open — see
      // `deleteStudentAccount` above.
```

with:

```ts
      // the only direction that cannot hurt the person the block protects.
      // Student erasure keeps them too — see `deleteStudentAccount` above.
```

- [ ] **Step 11: Sweep for what this invalidated, and give every hit a verdict**

Run:

```bash
grep -rno -i "undecided\|deliberately unresolved\|stays parked\|retain-vs-scrub\|retention-vs-erasure\|scrub or hash\|legal review\|legal one\|proper consultation\|genuinely open\|do not resolve it" CLAUDE.md docs/*.md src/ .claude/skills/
```

Expected survivors, each with a verdict in the report:
- `CLAUDE.md` Open Questions `legal review` — correct: the wider review stays parked (its line reads "proper *legal* consultation", so `proper consultation` does not match there).
- `docs/data-model.md` new #171 paragraph `legal review` — correct: names the review that can reopen it.

Any other hit is a stale claim this task missed: fix it, then re-run. Hits under `docs/superpowers/` are records and are not in the command's scope.

Then read the whole `docs/data-model.md` § TeacherBlock (from `### TeacherBlock` to the next `---`) top to bottom: a grep finds stale names, not stale descriptions. Every "above"/"below" cross-reference must land on the paragraph it names.

- [ ] **Step 12: Typecheck, lint, and the components tier**

Run: `pnpm run typecheck && pnpm run lint && pnpm exec vitest run --project components`
Expected: all green. Record the components tier's passed-file and passed-test counts from the output.

- [ ] **Step 13: Commit the decision record**

```bash
git add docs/data-model.md src/services/gdpr.ts
git commit -m "docs(gdpr): decide #171 — student erasure keeps TeacherBlock as a suppression entry"
```

(End the message with the session's `Co-Authored-By` trailer.)
