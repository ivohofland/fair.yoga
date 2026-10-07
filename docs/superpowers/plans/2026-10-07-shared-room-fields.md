# Shared Room Fields (#768) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A room's `notes`, `createdById` and timestamps never reach a teacher who did not create it, through any API response or page.

**Architecture:** One shared projection of a room — its public identity plus `equipment` — becomes the only shape API reads return for a room, tethered to a type by `satisfies`. The room settings page shows `Room.notes` only to the room's creator.

**Tech Stack:** Next.js 16 route handlers and server components, Prisma `select`, Vitest integration tests.

**Spec:** none. This is a one-approach fix, and the premise and the decisions are recorded below.

## Premise (measured 2026-10-07; carry this into the PR body)

- **The issue names two routes. A read-only sweep found six API responses and one page.** Non-creators see a public room's full row in all of these:
  - `GET /api/rooms`, the default branch (`src/app/api/rooms/route.ts`);
  - `GET /api/rooms/[id]`;
  - `GET /api/teacher-rooms` (`include: { room: true }`);
  - `GET /api/teacher-rooms/[id]` (the same include);
  - `GET /api/class-templates` (`teacherRoom: { include: { room: true } }`);
  - `GET /api/class-templates/[id]` (the same include).
- **The page is the strongest case:** `src/app/(teacher)/settings/rooms/[id]/page.tsx`'s read-only block prints `room.notes` for any public room. A teacher who adds another teacher's shared room reads the creator's notes on their own settings page, with no API call needed.
- **The UI promises the opposite.** The share notice (`src/components/settings/public-room-notice.tsx`) says "your notes stay private to you". The room-create form's "Notes" field writes `Room.notes`, and that column freezes once the room is shared.
- **What non-creators legitimately need:**
  - every UI caller of those APIs reads only `roomName` and `venueName`;
  - the read-only page shows `equipment` as "Available props";
  - the share notice already treats props as part of the shared room.

  So `equipment` is public; `notes`, `createdById` and the timestamps are not.
- **Clean but fragile, and left unchanged:** server-component pages load full room rows but render only names. No page passes a room to a `'use client'` component.

## Decisions

- **One projection for every API read**, whoever the caller is. No UI caller needs `notes` from an API. The creator reads and edits their notes on the settings page, which queries Prisma directly. Creator-aware branching in six handlers would buy nothing and add six places to get wrong.
- **No clearing or new warning on publish.** Once nothing serves `notes` to another teacher, the share notice's promise is true as written.
- `POST /api/rooms` and `POST /api/rooms/[id]/publish` keep returning the full row. Both answer only the creator (create: the caller just made it; publish: after the `createdById` check).

## Global Constraints

- TypeScript `strict`, no `any`.
- Comment Discipline (CLAUDE.md): no prose counts or rosters, no history, and no claims about other modules in comments. Wider prose goes in `docs/`.
- Membership is tethered to the compiler: the projection is declared with `satisfies Record<keyof SharedRoom, true>`, as `ROOM_SEARCH_SELECT` is.
- Stage exact paths; quote bracketed paths. Commit messages reference `(#768)` and end with a blank line then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Node 24: prefix commands with `export PATH="$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node | grep '^v24' | tail -1)/bin:$PATH:/usr/sbin";`. Integration tests run against this worktree's server (`INTEGRATION_BASE_URL` in `.env`, port 3120). Never touch `:3000`.
- Every guard gets a mutation step: break it, record the exact failure text, restore with `git checkout -- <file>`, and end with a clean `git status`. Curl the route before judging, so `next dev` has compiled it.

## Review Focus

1. Teacher B, who linked teacher A's shared room, must not receive A's `notes` or `createdById` from any of the six API reads. Each has its own assertion.
2. The creator of a shared room still sees their own `Room.notes` on the settings page.
3. The non-creator's settings page for a shared room still shows "Available props", and still shows their own `equipmentNotes` in the editable form.
4. The `GET /api/rooms` postcode+street search response is unchanged.
5. The class-template and teacher-room UI flows (`new-class-form.tsx`, `template-form.tsx`) still get `roomName` and `venueName`.

---

### Task 1: One shared projection for every API read of a room

**Files:**
- Modify: `src/lib/room-search.ts`, or a new `src/lib/room-projection.ts` if `room-search.ts`'s client-import constraint makes a value export there awkward (read its header first). This holds `SharedRoom` and `SHARED_ROOM_SELECT`.
- Modify: `src/app/api/rooms/route.ts` (default GET branch), `src/app/api/rooms/[id]/route.ts` (GET), `src/app/api/teacher-rooms/route.ts` (GET), `src/app/api/teacher-rooms/[id]/route.ts` (GET), `src/app/api/class-templates/route.ts` (GET), `src/app/api/class-templates/[id]/route.ts` (GET)
- Test: the existing integration file for each route (find with `grep -rln "api/rooms\|api/teacher-rooms\|api/class-templates" tests/integration`)

**Interfaces:**
- Produces: `export interface SharedRoom extends RoomResult { equipment: Prisma.JsonValue }`, or whatever type `equipment` has on a selected row, and `export const SHARED_ROOM_SELECT = { …RoomResult's keys…, equipment: true } satisfies Record<keyof SharedRoom, true>`. Write the keys out literally rather than spreading `ROOM_SEARCH_SELECT`; the `satisfies` is the tether.

- [ ] **Step 1: Failing tests.** One fixture: teacher A creates a room with `notes: 'door code 4821'` and publishes it, and teacher B links it with a `TeacherRoom` (and has a class template on it). For each of the six reads, assert that B's response contains no `notes` and no `createdById`, using the serialized body text (`not.toContain('door code 4821')`) as well as the key check. Also assert that B still gets `roomName`, `venueName` and `equipment` where the read returns a room.
- [ ] **Step 2:** Run the tests and expect them to FAIL.
- [ ] **Step 3: Implement.**
  - The rooms default branch uses `select: SHARED_ROOM_SELECT` and `respondTyped<SharedRoom[]>`.
  - `rooms/[id]` GET selects `SHARED_ROOM_SELECT` plus whatever its access check needs (`isPublic`, `createdById`) in a separate query or select. The response must be the projection only, so don't return the row the check read.
  - The includes become `room: { select: SHARED_ROOM_SELECT }`.
  - Keep the postcode+street search on `ROOM_SEARCH_SELECT`.
- [ ] **Step 4:** Run the tests and typecheck, and expect a PASS. Then run the full integration files the change touches.
- [ ] **Step 5: Mutations.** For each of the six reads, restore its full-row read and record which test goes red. At minimum: the rooms default branch, `rooms/[id]`, `teacher-rooms` GET and `class-templates` GET. Also add `notes: true` to `SHARED_ROOM_SELECT` → the type tether must fail `pnpm run typecheck`. Record the error.
- [ ] **Step 6: Commit:** `fix: every API read of a room returns its shared projection, never the creator's notes or id (#768)`.

### Task 2: The room settings page shows `Room.notes` only to the room's creator

**Files:**
- Modify: `src/app/(teacher)/settings/rooms/[id]/page.tsx` (the read-only block)
- Test: an integration test that fetches the page HTML as teacher B and as teacher A. Follow the repo's existing pattern for page-HTML assertions; find it with `grep -rln "await res.text()" tests/integration | head`. Signing in and creating the fixture go the same way as Task 1.

- [ ] **Step 1: Failing test.** B's HTML for B's own `TeacherRoom` on A's shared room does not contain `door code 4821`, but does contain the props line. A's HTML for A's `TeacherRoom` on the same room does contain it.
- [ ] **Step 2:** Run it and expect a FAIL.
- [ ] **Step 3: Implement.** Render the `Notes` block only when `room.createdById === <the signed-in teacher's id>`. Use whatever the page already has for the teacher. Better still, don't load `notes` at all for a non-creator: select it conditionally, or derive a `creatorNotes` value server-side, so the column is absent from the render input. Add a one-line comment saying why: the notes are the creator's own, and a shared room is read by teachers who did not write them.
- [ ] **Step 4:** Run it and expect a PASS. **Mutation:** drop the creator condition → B's assertion must go red. Record it.
- [ ] **Step 5: Commit:** `fix: a shared room's settings page shows its notes only to the teacher who wrote them (#768)`.
