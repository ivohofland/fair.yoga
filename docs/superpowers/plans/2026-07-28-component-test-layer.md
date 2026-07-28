# Component Test Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the six toggle buttons' wiring under test — the URL each sends, and for the four template ones whether the confirmation and error actually render (#99).

**Architecture:** A third Vitest project named `components` runs `src/components/**/*.test.tsx` in a jsdom environment, disjoint from `unit`'s `.ts` glob. A shared setup file registers the jest-dom matchers and a default `next/navigation` mock. Each test renders a button, clicks it against a stubbed `fetch`, and asserts on the request and the DOM.

**Tech Stack:** Vitest 4 projects, jsdom, @testing-library/react (React 19), @testing-library/jest-dom, Next 16 App Router client components.

## Global Constraints

- **TypeScript `strict: true`.** No `any`, no type assertions to silence errors, no eslint suppressions.
- **Exactly three new dev dependencies:** `jsdom`, `@testing-library/react`, `@testing-library/jest-dom`. **Not** `@testing-library/user-event` — `fireEvent.click` is sufficient for a button, and a fourth dependency buys realism this design never exercises.
- **jsdom, not happy-dom.** This is an open-source project with volunteer contributors and jsdom is what every testing-library document assumes; the speed difference across six small files does not repay an unfamiliar runtime.
- **The new project's glob is `src/components/**/*.test.tsx`** — the `.tsx` extension is what keeps it disjoint from `unit`'s `src/**/*.test.ts`. Do not widen either.
- **CI must actually run it.** `npm test` is `vitest run` with no `--project` flag and `.github/workflows/ci.yml:150` runs exactly that, so a new project is collected automatically. Verify this rather than assuming it — a test layer CI never runs is worse than none.
- **URL assertions check the whole string**, never `toContain('state=')`. A substring match survives the template id being dropped, which is the wiring error this layer exists to catch.
- **Both prop values for every button.** Asserting one direction leaves the ternary half-covered, and inverting it is the exact mistake the inline derivation risks.
- **Assertions on rendered output go through the DOM** (`findByText`, `getByRole`), never through the resolver's return value — that is already covered in the `unit` project.
- **Async state updates need `findBy*`/`waitFor`**, not synchronous `getBy*`. The handlers set state after an awaited `fetch`; getting this wrong produces tests that pass while emitting `act()` warnings, which is the shape of a test everyone learns to ignore.
- **Mutation-verify**, and per the #66 lesson confirm the mutation applied inside the component under test before trusting the result.
- **This layer is not a mandate to backfill every component.** Do not add tests beyond the six buttons named here.

---

## File Structure

| File | Responsibility |
|---|---|
| `package.json` | Three new `devDependencies` |
| `vitest.config.ts` | The third project entry |
| `tests/setup/components.ts` | jest-dom matchers + default `next/navigation` mock |
| `src/components/settings/toggle-template-button.test.tsx` | URL ×2, confirmation, error, disabled |
| `src/components/settings/archive-template-button.test.tsx` | same five |
| `src/components/settings/toggle-studio-template-button.test.tsx` | same five |
| `src/components/settings/archive-studio-template-button.test.tsx` | same five |
| `src/components/settings/archive-room-button.test.tsx` | URL ×2 |
| `src/components/students/archive-student-button.test.tsx` | URL ×2 |

**Two tasks.** Task 1 stands the layer up and proves it end to end on one button — that is the risky part, and a reviewer could reasonably reject the configuration while approving nothing else. Task 2 applies the established pattern to the remaining five, which is mechanical once Task 1's harness exists.

---

### Task 1: The layer, proved on one button

**Files:**
- Modify: `package.json`, `vitest.config.ts`
- Create: `tests/setup/components.ts`, `src/components/settings/archive-template-button.test.tsx`

**Interfaces:**
- Produces: the `components` Vitest project; `tests/setup/components.ts` exporting nothing but registering matchers and the `next/navigation` mock globally; and the test shape Task 2 copies for five more buttons.

- [ ] **Step 1: Install the three dev dependencies**

```bash
npm install -D jsdom @testing-library/react @testing-library/jest-dom
```

Then confirm nothing else arrived: `git diff package.json` should show exactly three additions under `devDependencies`.

- [ ] **Step 2: Add the setup file**

Create `tests/setup/components.ts`:

```ts
/**
 * Setup for the vitest `components` project.
 *
 * Registers the jest-dom matchers and stubs `next/navigation`, so six button
 * test files do not each redeclare `useRouter`. Testing-library's automatic
 * cleanup activates from `globals: true` in the root config, so no teardown
 * is wired here.
 *
 * The router mock returns both `refresh` and `push`: the template buttons call
 * `refresh()` to re-render the page they are on, the room and student buttons
 * call `push()` to navigate away. Tests that assert on either import them from
 * here.
 */
import '@testing-library/jest-dom/vitest';
import { vi, beforeEach } from 'vitest';

export const routerRefresh = vi.fn();
export const routerPush = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: routerRefresh, push: routerPush }),
}));

beforeEach(() => {
  routerRefresh.mockClear();
  routerPush.mockClear();
});
```

- [ ] **Step 3: Add the third project**

In `vitest.config.ts`, add after the `integration` project entry:

```ts
        {
          extends: true,
          test: {
            name: 'components',
            // jsdom, overriding the root's `environment: 'node'`. The `.tsx`
            // glob is what keeps this disjoint from `unit`'s `src/**/*.test.ts`
            // — no file is collected by both.
            environment: 'jsdom',
            include: ['src/components/**/*.test.tsx'],
            setupFiles: ['./tests/setup/components.ts'],
          },
        },
```

- [ ] **Step 4: Write the failing test file**

Create `src/components/settings/archive-template-button.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ArchiveTemplateButton } from './archive-template-button';
import { routerRefresh } from '../../../tests/setup/components';
// Importing the mock fns from the setup file relies on Vitest giving the test
// and the setup file the same module instance. If that does not hold in
// practice, move the `vi.mock('next/navigation', …)` block into each test file
// instead and say so in your report — do not paper over it with a second mock.

/**
 * #99. The `?state=` target is derived inline, beside the label ternary that
 * reads the same prop — deliberately, so the two cannot disagree about which
 * direction a click means. Nothing asserted that they agree until this file.
 *
 * The resolver these buttons call is already unit-tested as a pure function;
 * what only a rendered test can see is whether the button *sends* the right
 * request and *displays* what the resolver returned.
 */
describe('ArchiveTemplateButton', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  function stubFetch(response: {
    ok: boolean;
    json?: () => Promise<unknown>;
  }): void {
    fetchMock.mockResolvedValue(response as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
  }

  const archivedOk = {
    ok: true,
    json: async () => ({ data: { action: 'archived', deleted: 2, remaining: 1 } }),
  };

  it('sends state=archived when the template is not archived', async () => {
    stubFetch(archivedOk);
    render(<ArchiveTemplateButton templateId="tpl-1" isArchived={false} />);

    fireEvent.click(screen.getByRole('button'));

    // The whole URL, not a substring: `toContain('state=')` would survive the
    // template id being dropped, which is exactly the wiring error this catches.
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/class-templates/tpl-1?state=archived', {
        method: 'PATCH',
      }),
    );
  });

  it('sends state=unarchived when the template is archived', async () => {
    stubFetch({ ok: true, json: async () => ({ data: { action: 'unarchived' } }) });
    render(<ArchiveTemplateButton templateId="tpl-1" isArchived={true} />);

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/class-templates/tpl-1?state=unarchived', {
        method: 'PATCH',
      }),
    );
  });

  it('renders the confirmation rather than merely computing it', async () => {
    stubFetch(archivedOk);
    render(<ArchiveTemplateButton templateId="tpl-1" isArchived={false} />);

    fireEvent.click(screen.getByRole('button'));

    // Queried from the DOM. Asserting the resolver's return value would prove
    // nothing this project does not already prove in `unit`.
    expect(
      await screen.findByText(/Classes on the schedule without bookings are now deleted/),
    ).toBeInTheDocument();
    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
  });

  it('renders the server error message when the request fails', async () => {
    stubFetch({ ok: false, json: async () => ({ error: { message: 'Class template not found' } }) });
    render(<ArchiveTemplateButton templateId="tpl-1" isArchived={false} />);

    fireEvent.click(screen.getByRole('button'));

    expect(await screen.findByText('Class template not found')).toBeInTheDocument();
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it('disables the button while the request is in flight', async () => {
    let release!: (value: { ok: boolean; json: () => Promise<unknown> }) => void;
    fetchMock.mockReturnValue(
      new Promise((resolve) => {
        release = resolve as typeof release;
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<ArchiveTemplateButton templateId="tpl-1" isArchived={false} />);
    const button = screen.getByRole('button');
    fireEvent.click(button);

    await waitFor(() => expect(button).toBeDisabled());

    release(archivedOk);
    await waitFor(() => expect(button).toBeEnabled());
  });
});
```

- [ ] **Step 5: Run it to verify it fails, then passes**

Run: `npx vitest run --project components`

The first run may fail to collect if the project or setup file is wrong — that is the signal the configuration is not yet right, and it is worth seeing before it works. Fix until all five pass.

- [ ] **Step 6: Verify CI would run this project**

```bash
npx vitest run 2>&1 | grep -E "components|unit|integration"
```

Expected: all three project names appear. `npm test` is `vitest run` with no `--project`, and `.github/workflows/ci.yml:150` runs exactly that, so this is the check that the layer is not invisible to CI. If `components` does not appear here, stop and fix the config — everything downstream is worthless without it.

- [ ] **Step 7: Verify the new file lints and type-checks**

```bash
npx tsc --noEmit
npm run lint
```

Both must be clean. If eslint does not pick up `.test.tsx` under its current config, say so in the report rather than adding an override — that is a decision, not a fix.

- [ ] **Step 8: Mutation-verify both guards**

```bash
git add -A   # `git checkout --` restores from the index; docs/backlog-roadmap.md
             # is untracked and must stay that way — unstage it if swept in
```

**Mutation A — invert the target ternary.** In `src/components/settings/archive-template-button.tsx`, change `const target = isArchived ? 'unarchived' : 'archived';` to `const target = isArchived ? 'archived' : 'unarchived';`. Confirm by reading the line that it changed in the component and not the test, then run `npx vitest run --project components`.
Expected: both URL tests FAIL; the confirmation, error and disabled tests still PASS.

**Mutation B — drop the display.** Restore, then change `setMessage(resolveTemplateConfirmation(data) ?? '')` to `resolveTemplateConfirmation(data)` (compute, discard). Run again.
Expected: only `'renders the confirmation rather than merely computing it'` FAILS — the URL tests still pass, which is the proof that this test observes rendering rather than the call.

Restore: `git checkout -- src/components/settings/archive-template-button.tsx`

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json vitest.config.ts tests/setup/components.ts \
  src/components/settings/archive-template-button.test.tsx
git commit -m "test: add a jsdom component project, proved on the archive button (#99)"
```

---

### Task 2: The remaining five buttons

**Files:**
- Create: `src/components/settings/toggle-template-button.test.tsx`, `src/components/settings/toggle-studio-template-button.test.tsx`, `src/components/settings/archive-studio-template-button.test.tsx`, `src/components/settings/archive-room-button.test.tsx`, `src/components/students/archive-student-button.test.tsx`

**Interfaces:**
- Consumes: the `components` project and `tests/setup/components.ts` from Task 1, which exports `routerRefresh` and `routerPush` as `vi.fn()`s cleared before each test. Task 1's `archive-template-button.test.tsx` is the shape to copy — read it first.

**The three template siblings get five tests each**, the same shape as Task 1's, with these differences:

| File | Component | Endpoint | Targets (`isArchived`/`isActive` false → true) | Success payload | Expected confirmation text |
|---|---|---|---|---|---|
| `toggle-template-button.test.tsx` | `ToggleTemplateButton`, prop `isActive` | `/api/class-templates/tpl-1` | `paused` when active, `active` when paused | `{ action: 'paused', lastScheduled: { date: '2026-06-12T00:00:00.000Z', startTime: '09:30' } }` | `/No new classes will be added to your schedule/` |
| `toggle-studio-template-button.test.tsx` | `ToggleStudioTemplateButton`, prop `isActive` | `/api/studio-class-templates/tpl-1` | `paused` when active, `active` when paused | same as above | `/No new classes will be added to your schedule/` |
| `archive-studio-template-button.test.tsx` | `ArchiveStudioTemplateButton`, prop `isArchived` | `/api/studio-class-templates/tpl-1` | `archived` when not archived, `unarchived` when archived | `{ action: 'archived', deleted: 4, remaining: 0 }` | `/Deleted 4 scheduled studio classes/` |

Each still asserts the whole URL, both prop values, the rendered confirmation, the rendered error, and the disabled state — and each still asserts `routerRefresh` was called on success and not on error.

**The room and student buttons get two tests each — URL only.** They render no confirmation; success is a `router.push`, so there is nothing further a component test would observe. Their shape:

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ArchiveRoomButton } from './archive-room-button';

/**
 * URL only. This button renders no confirmation — success is a `router.push`
 * — so there is nothing further a component test would see that a pure
 * function could not. See the spec's scope boundary (#99).
 */
describe('ArchiveRoomButton', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  function stubOk(): void {
    fetchMock.mockResolvedValue({ ok: true } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
  }

  it('sends state=archived when the room is not archived', async () => {
    stubOk();
    render(<ArchiveRoomButton teacherRoomId="tr-1" isArchived={false} />);

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/teacher-rooms/tr-1?state=archived', {
        method: 'PATCH',
      }),
    );
  });

  it('sends state=unarchived when the room is archived', async () => {
    stubOk();
    render(<ArchiveRoomButton teacherRoomId="tr-1" isArchived={true} />);

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/teacher-rooms/tr-1?state=unarchived', {
        method: 'PATCH',
      }),
    );
  });
});
```

`archive-student-button.test.tsx` is the same file with `ArchiveStudentButton` from `./archive-student-button`, prop `studentId="st-1"`, and URLs `/api/students/st-1?state=archived` and `?state=unarchived`.

- [ ] **Step 1: Write all five test files**

Read `src/components/settings/archive-template-button.test.tsx` from Task 1 first and copy its structure, then apply the table above. Read each component before writing its test rather than trusting the table alone — the confirmation strings come from `template-action-messages.ts` and must match what the resolver actually returns for the payload you stub.

- [ ] **Step 2: Run the project**

Run: `npx vitest run --project components`
Expected: this task's 5 files contribute 19 tests (5 + 5 + 5 for the template siblings,
2 + 2 for room and student), for **24 across six files** once Task 1's five are included.

- [ ] **Step 3: Mutation-verify one of the five**

Stage, then invert the target ternary in `src/components/students/archive-student-button.tsx`. Confirm by reading the line that it changed in the component, then run the project.
Expected: only that file's two URL tests FAIL. Restore.

This one is chosen deliberately: it is the button furthest from Task 1's, in a different directory, so a passing mutation here shows the harness works for the whole glob rather than only for the file it was built against.

- [ ] **Step 4: Full verification**

```bash
npx tsc --noEmit
npm run lint
npx vitest run
```

Expected: clean, and all three projects collected. Baselines before this plan: 388 unit, 214 integration, 0 component.

- [ ] **Step 5: Commit**

```bash
git add src/components/settings/toggle-template-button.test.tsx \
  src/components/settings/toggle-studio-template-button.test.tsx \
  src/components/settings/archive-studio-template-button.test.tsx \
  src/components/settings/archive-room-button.test.tsx \
  src/components/students/archive-student-button.test.tsx
git commit -m "test: cover the remaining five toggle buttons' wiring (#99)"
```

---

## Verification before opening the PR

- [ ] `npx tsc --noEmit` — clean
- [ ] `npm run lint` — clean
- [ ] `npx vitest run` — all three projects collected; 388 unit, 214 integration, 24 component
- [ ] `npx vitest run --project integration` — 214 passing (needs the app on `:3000`; do not restart it. `signup-api` 429s are the local rate limiter, not this change)
- [ ] `npx playwright test` — 118 passing
- [ ] `git diff main -- package.json` shows exactly three new devDependencies and nothing else
