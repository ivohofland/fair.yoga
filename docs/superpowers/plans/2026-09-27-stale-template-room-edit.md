# Stale template edit tab: send the room only when the teacher changed it (#685)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A recurring-class edit tab opened before a room switch, and saved after it, no longer moves the template back onto the room the switch archived.

**Architecture:** The edit form sends its whole state, so the PUT carries the `teacherRoomId` the tab loaded, and the service treats any id different from the stored one as a move. Fix it on the client: in edit mode, leave `teacherRoomId` out of the PUT body when the form's value equals the `initial.teacherRoomId` **prop**. It has to be the prop, not a snapshot taken at mount, because `router.refresh()` after a save re-renders the page with a fresh `initial`. No schema, service or database change.

**Tech Stack:** Next.js 16 client component, React Testing Library (vitest `components` project), vitest `integration` project against the worktree's app.

**Spec:** none. The issue was bounded, and direction A was agreed in chat on 2026-09-27: omit the room on the client rather than add an expected-current-room check on the server. Issue #685 is the design record.

## Global Constraints

- TypeScript `strict`, no `any`, no `as` widening to satisfy the compiler.
- `@typescript-eslint/no-unused-vars` has `argsIgnorePattern: '^_'` only, with no `varsIgnorePattern`. A destructured `_unused` variable is a lint error, so every destructured name must be read.
- Comments annotate the code they sit on. Don't write prose counts of fields in any new or edited comment (CLAUDE.md, *Comment Discipline*). The existing "thirteen" in `template-form.tsx:66` describes the schemas' key sets, not the body, and stays.
- Create mode is unaffected: `POST /api/class-templates` still receives every field, `teacherRoomId` included.

## Review Focus

1. **A stale tab where the archived room is still selected and another field was edited.** The teacher expects the room to stay where the switch put it. Pinned by the component test in Step 1 and by the integration test in Step 6.
2. **An intentional room change in edit mode.** The teacher expects the new room to be saved. Pinned by the Step 1 "changed room" test.
3. **Changing the room and then changing it back** before saving. The net intent is no change, so the room is omitted. Pinned by the Step 1 "changed back" test.
4. **A second save in the same tab after a room-changing save.** `router.refresh()` has updated `initial`, so the now-current room counts as unchanged. A snapshot taken at mount would resend it and could reverse a later switch. Pinned by the Step 1 "rerender" test.
5. **Create mode.** Every field is still sent. Pinned by the existing `'sends the same thirteen fields when creating'` test, which is left unedited.

---

### Task 1: Omit an unchanged room from the edit PUT

**Files:**
- Modify: `src/components/settings/template-form.tsx`: the payload construction in `handleSubmit` (currently `:285-295`, the `const payload: CreateTemplateWire & UpdateTemplateWire = { ...form, … }` block and its comment).
- Modify: `src/components/settings/template-form.test.tsx`: rewrite `'sends all thirteen fields when editing'` (`:77-98`) and add three tests next to it.
- Modify: `tests/integration/teacher-rooms-switch-api.test.ts`: add one test inside the existing `describe`.

**Interfaces:**
- Consumes: `TemplateFormProps.initial?: TemplateFormValues` (existing), and the `CreateTemplateWire` / `UpdateTemplateWire` types (existing, `template-form.tsx:57-58`).
- Produces: nothing exported. The PUT body shape changes: `teacherRoomId` is present only when it differs from `initial.teacherRoomId`.

- [ ] **Step 1: Write the failing component tests**

In `template-form.test.tsx`, add a second stub next to `stubFetch` that offers two rooms, so a test can change the selection:

```tsx
  const ROOM_A = '11111111-1111-4111-8111-111111111111';
  const ROOM_B = '22222222-2222-4222-8222-222222222222';

  function stubFetchTwoRooms() {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: ROOM_A, isArchived: false, capacityOverride: 30, rentalRate: 20, room: { roomName: 'Studio A', venueName: 'Main Venue' } },
          { id: ROOM_B, isArchived: false, capacityOverride: 30, rentalRate: 20, room: { roomName: 'Studio B', venueName: 'Main Venue' } },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
  }
```

`rentalRate: 20` equals `initial.roomCost`, so `handleRoomChange` leaves `roomCost` unchanged and the body assertions stay about the room alone.

Replace `'sends all thirteen fields when editing'` with the test below. Keep the full `toEqual`: it is still the whole-body pin #85 wants, minus the one key. Its docblock states the rule: the edit body carries the room only when the teacher changed it, because a switch in another tab can move the template after this form loaded (#685).

```tsx
  it('leaves the room out of an edit whose room field was not changed', async () => {
    stubFetch();
    render(<TemplateForm mode="edit" templateId="tpl-1" initial={{ ...initial }} />);
    const { url, method, body } = await submit();
    expect(url).toBe('/api/class-templates/tpl-1');
    expect(method).toBe('PUT');
    expect(body).toEqual({
      classType: 'Vinyasa',
      description: 'Bring a mat.',
      dayOfWeek: 2,
      startTime: '09:30',
      durationMinutes: 60,
      roomCost: 20,
      minRate: 15,
      targetRate: 25,
      minStudents: 4,
      maxStudents: 12,
      cancelDeadline: 'HOURS_24',
      autoCancelCheck: 'HOURS_2',
    });
  });
```

Add:

```tsx
  it('sends the room when the teacher changed it', async () => {
    stubFetchTwoRooms();
    render(<TemplateForm mode="edit" templateId="tpl-1" initial={{ ...initial }} />);
    await screen.findByRole('option', { name: /Studio B/ });
    fireEvent.change(screen.getByLabelText('Room'), { target: { value: ROOM_B } });
    const { body } = await submit();
    expect(body.teacherRoomId).toBe(ROOM_B);
  });

  it('leaves the room out when the teacher changed it and changed it back', async () => {
    stubFetchTwoRooms();
    render(<TemplateForm mode="edit" templateId="tpl-1" initial={{ ...initial }} />);
    await screen.findByRole('option', { name: /Studio B/ });
    const select = screen.getByLabelText('Room');
    fireEvent.change(select, { target: { value: ROOM_B } });
    fireEvent.change(select, { target: { value: ROOM_A } });
    const { body } = await submit();
    expect(body).not.toHaveProperty('teacherRoomId');
  });

  // `router.refresh()` after a room-changing save re-renders the server parent
  // with a fresh `initial`, while `form` keeps its state. The comparison must
  // read the prop, or the second save resends a room the server already holds.
  it('compares against the current initial prop, not the one it mounted with', async () => {
    stubFetchTwoRooms();
    const { rerender } = render(<TemplateForm mode="edit" templateId="tpl-1" initial={{ ...initial }} />);
    await screen.findByRole('option', { name: /Studio B/ });
    fireEvent.change(screen.getByLabelText('Room'), { target: { value: ROOM_B } });
    rerender(<TemplateForm mode="edit" templateId="tpl-1" initial={{ ...initial, teacherRoomId: ROOM_B }} />);
    const { body } = await submit();
    expect(body).not.toHaveProperty('teacherRoomId');
  });
```

If the option's accessible name doesn't match `/Studio B/`, read the `<option>` rendering near `template-form.tsx:550` and use its real text. Don't weaken the wait to a bare `findByLabelText('Room')`: the change needs the fetched option to exist.

- [ ] **Step 2: Run the component tests and confirm the right ones fail**

Run: `pnpm exec vitest run --project components src/components/settings/template-form.test.tsx`

Expected: the rewritten test fails (the body has an extra `teacherRoomId`), the changed-back test fails, and the rerender test fails. The "sends the room when the teacher changed it" test **passes**, because today's code sends the room always. Record the three failure messages.

- [ ] **Step 3: Implement**

In `template-form.tsx` `handleSubmit`, replace the `payload` block. Keep the intersection annotation on the full body. It is what holds the value types against both schemas, and `withoutRoom` inherits its types from it:

```tsx
      const full: CreateTemplateWire & UpdateTemplateWire = {
        ...form,
        classType: form.classType.trim(),
        description: form.description.trim() || null,
      };
      const { teacherRoomId, ...withoutRoom } = full;
      const payload =
        mode === 'edit' && teacherRoomId === initial?.teacherRoomId ? withoutRoom : full;
```

Update the comment above it. Keep the paragraph on why the annotation is the intersection, retargeted to `full`, and add one paragraph on the omission. That paragraph says:
- An edit carries the room only when the teacher changed it. A room switch (`POST /api/teacher-rooms/[id]/switch`) can move the template after this tab loaded, and resending the loaded id is a move back (#685).
- The comparison reads the `initial` prop rather than a snapshot, because `router.refresh()` after a save re-renders it.

`JSON.stringify(payload)` below needs no change.

- [ ] **Step 4: Run the component tests and confirm they pass**

Run: `pnpm exec vitest run --project components src/components/settings/template-form.test.tsx`
Expected: every test in the file passes.

- [ ] **Step 5: Mutation-test the fix**

Commit first (Step 8's commit, or a WIP commit), so restoring the mutation cannot discard other edits.

Mutation M1: replace the `payload` expression with `full`. This restores the whole-state body.
Run the Step 4 command. Expected: the rewritten test, the changed-back test and the rerender test fail. Record the exact failure text for each.

Mutation M2: replace `initial?.teacherRoomId` in the comparison with a value captured once at mount (`const [loadedRoomId] = useState(initial?.teacherRoomId);` then compare against `loadedRoomId`). This is the snapshot the design rejected.
Run the Step 4 command. Expected: only the rerender test fails. Record the text.

Restore with `git checkout -- src/components/settings/template-form.tsx`, confirm `git status --short` shows the file clean, and re-run Step 4 green.

- [ ] **Step 6: Add the integration acceptance test**

This pins the issue's scenario end to end at the wire: a paused template on the private link, a real switch, then the PUT that a fixed stale tab now sends (no `teacherRoomId`, one unrelated field changed). It passes against today's server as well, because the fix is in what the client omits. It is the acceptance record, not the regression guard; Step 5 is the guard. Say that in its comment.

In `tests/integration/teacher-rooms-switch-api.test.ts`, inside the `describe`, add:

```ts
  // #685. The PUT a stale edit tab sends once it leaves an untouched room out:
  // the template stays on the shared link the switch moved it to.
  it('keeps a paused template on the shared room when a later edit omits the room', async () => {
    const { link, shared } = await makePair(owner.id, 'stale');
    const template = await prisma.classTemplate.create({
      data: {
        scheduleRule: {
          create: {
            teacherId: owner.id, kind: 'regular', classType: 'Stale Tab', dayOfWeek: 3,
            startTime: hhmmToTime('07:00'), durationMinutes: 60, isActive: false,
          },
        },
        teacherRoom: { connect: { id: link.id } },
        roomCost: 20, minRate: 15, targetRate: 25, minStudents: 2, maxStudents: 10,
      },
    });

    const switched = (await expectApplied(await post(owner.token, link.id, { roomId: shared.id }), 200)) as {
      sharedTeacherRoomId: string;
    };

    const res = await fetch(`${BASE_URL}/api/class-templates/${template.id}`, {
      method: 'PUT',
      headers: { ...cookie(owner.token), ...freshIp(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'Edited in a tab opened before the switch' }),
    });
    expect(res.status).toBe(200);

    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: template.id } });
    expect(after.teacherRoomId).toBe(switched.sharedTeacherRoomId);
    expect(after.roomArchived).toBe(false);
  });
```

No cleanup change is needed. The `afterAll` already deletes `scheduleRule` rows for this file's teachers, and `ClassTemplate.scheduleRule` is `onDelete: Cascade` (`prisma/schema.prisma:425`, checked while writing this plan).

`dayOfWeek: 3` / `07:00` must not collide with another live template for this teacher. This file creates none, and the template is paused but still holds its slot, so it is the only one.

- [ ] **Step 7: Run the integration test**

In a worktree: `pnpm install --frozen-lockfile`, then `pnpm run worktree:setup` once, then `pnpm run worktree:up`.
Run: `pnpm exec vitest run --project integration tests/integration/teacher-rooms-switch-api.test.ts`
Expected: all tests in the file pass.

- [ ] **Step 8: Commit**

```bash
git add src/components/settings/template-form.tsx src/components/settings/template-form.test.tsx tests/integration/teacher-rooms-switch-api.test.ts
git commit -m "fix(templates): send the room only when the edit changed it (#685)"
```

- [ ] **Step 9: Full verification**

Run: `pnpm run verify` against the worktree app. Expected: typecheck, lint and every vitest project green. Record the per-project test counts for the PR body.
