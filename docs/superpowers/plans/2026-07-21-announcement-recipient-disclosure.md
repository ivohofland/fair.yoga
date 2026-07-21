# Announcement Recipient Disclosure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Who receives this?" disclosure in the announcement composer explaining recipients and email fallback, plus an honest Students-page label.

**Architecture:** Pure presentation change in one client component (`SendAnnouncement`) — a `useState` toggle and copy branched on the existing `classId` prop — plus a one-string label fix at the Students-page call site. No API, schema, or service changes.

**Tech Stack:** React client component, Tailwind v4 tokens (`type-caption`, `text-teal`), Playwright drive for verification.

**Spec:** `docs/superpowers/specs/2026-07-21-announcement-recipient-disclosure-design.md`

## Global Constraints

- Trigger text is exactly `Who receives this?`; classes `type-caption text-teal`; `aria-expanded` required.
- Expanded copy verbatim from the spec (two variants, branched on `classId`).
- Students-page hint is exactly `your booked students`; class-detail hint unchanged.
- No motion — instant show/hide.
- No new props, no new API surface.
- TypeScript strict; `npx tsc --noEmit`, `npm run lint`, `npx vitest run` stay green.
- Branch: `feat/announcement-recipient-disclosure` (created; spec committed).

---

### Task 1: Disclosure toggle in SendAnnouncement

**Files:**
- Modify: `src/components/class/send-announcement.tsx:17` (state) and `:75-93` (composer JSX)

**Interfaces:**
- Consumes: existing `classId?: string` prop.
- Produces: a `button` labeled `Who receives this?` with `aria-expanded`, followed (when expanded) by a `<p>` containing the variant copy. Task 3's drive asserts on exactly these.

- [ ] **Step 1: Add the toggle state and copy**

After `const [error, setError] = useState('');` (line 21) add:

```tsx
  const [showRecipients, setShowRecipients] = useState(false);

  const recipientExplanation = classId
    ? "Everyone registered for this class. It lands in their inbox here; anyone who hasn't read it after 30 minutes also gets it by email, unless they've opted out."
    : "Everyone with a booking in one of your classes — contacts who've never booked won't receive it. It lands in their inbox here; anyone who hasn't read it after 30 minutes also gets it by email, unless they've opted out.";
```

- [ ] **Step 2: Render the disclosure between the textarea and the buttons**

In the open-composer return, insert between the `<Textarea …/>` block and `<div className="flex gap-3">`:

```tsx
      <div className="flex flex-col items-start gap-1">
        <button
          type="button"
          onClick={() => setShowRecipients((v) => !v)}
          aria-expanded={showRecipients}
          className="type-caption text-teal"
        >
          Who receives this?
        </button>
        {showRecipients && (
          <p className="type-caption max-w-[420px]">{recipientExplanation}</p>
        )}
      </div>
```

- [ ] **Step 3: Typecheck and commit**

Run: `npx tsc --noEmit` — expected exit 0.

```bash
git add src/components/class/send-announcement.tsx
git commit -m "feat: announcement composer discloses who receives the message"
```

---

### Task 2: Honest Students-page label

**Files:**
- Modify: `src/app/(teacher)/students/page.tsx:16`
- Modify: `src/components/class/send-announcement.tsx:10` (doc comment example)

**Interfaces:**
- Consumes: `SendAnnouncement`'s `recipientHint` prop (renders into the textarea label `Announcement to ${recipientHint}`).
- Produces: Students-page composer label reads `Announcement to your booked students`.

- [ ] **Step 1: Change the hint**

In `src/app/(teacher)/students/page.tsx` replace:

```tsx
        <SendAnnouncement recipientHint="all your students" />
```

with:

```tsx
        <SendAnnouncement recipientHint="your booked students" />
```

- [ ] **Step 2: Keep the prop's doc example truthful**

In `src/components/class/send-announcement.tsx` replace:

```tsx
  /** e.g. "everyone registered for this class" / "all your students". */
```

with:

```tsx
  /** e.g. "everyone in this class" / "your booked students". */
```

- [ ] **Step 3: Typecheck and commit**

Run: `npx tsc --noEmit` — expected exit 0.

```bash
git add "src/app/(teacher)/students/page.tsx" src/components/class/send-announcement.tsx
git commit -m "fix: students-page announcement label no longer overpromises"
```

---

### Task 3: Drive verification and PR

**Files:**
- Create (scratchpad, not repo): `<scratchpad>/verify-disclosure.ts`

**Interfaces:**
- Consumes: Task 1's button/copy, Task 2's label; dev server on :3000; seeded DB with teacher `ivo@fairyoga.dev` and at least one class.

- [ ] **Step 1: Write and run the drive script**

Script behavior (Playwright chromium, session minted via `Session.accountId` for `ivo@fairyoga.dev`, cookie `fair_yoga_session=<raw token>`; `waitUntil: 'load'`, never `networkidle`):

1. `/students`: click `Send announcement`, assert label `Announcement to your booked students`, click `Who receives this?`, assert `aria-expanded="true"` and visible text starting `Everyone with a booking in one of your classes`; screenshot.
2. Query any class id for Ivo via Prisma; `/class/<id>`: click `Send announcement`, click `Who receives this?`, assert visible text starting `Everyone registered for this class`; screenshot.
3. Delete the minted session row.

Expected: both assertions pass, two screenshots inspected.

- [ ] **Step 2: Full check pass**

Run: `npx vitest run` — expected all pass.
Run: `npm run lint` — expected exit 0.

- [ ] **Step 3: Push and open PR**

```bash
git push -u origin feat/announcement-recipient-disclosure
gh pr create --title "feat: announcement composer explains who receives the message" --body "<summary + test plan>"
```

Expected: PR against `main`, CI `checks` + `test` green.
