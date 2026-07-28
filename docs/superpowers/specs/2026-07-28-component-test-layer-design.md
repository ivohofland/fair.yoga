# A component test layer for wiring pure functions cannot reach

**Date:** 2026-07-28
**Status:** Approved (issue #99; design agreed with Ivo in discussion)

## Problem

No React component in this codebase is under test. `vitest.config.ts` declares
two projects, both `environment: 'node'` — `unit` over `src/**/*.test.ts` and
`integration` over `tests/integration/**/*.test.ts` — and there is no `.test.tsx`
anywhere.

This is not academic. During PR #93 a wiring bug shipped and was caught by human
review rather than CI: `archiveStudioMessage` had the wrong signature and the
button silently discarded `remaining`. The pure-function tests were internally
consistent with the wrong shape, so nothing failed.

### What #98 already fixed, and what it left

#98 took this issue's own cheap option. The buttons' decision — whether to show a
confirmation and which one — is now `resolveTemplateConfirmation` /
`resolveStudioConfirmation` in `src/components/settings/template-action-messages.ts`,
pure and tested in the `unit` project. That closes the `2b06f13` class of bug
directly.

What remains is what a pure function structurally cannot see:

- **The URL each button sends.** The `?state=` target is derived inline, beside
  the label ternary that reads the same prop — deliberately, so the two cannot
  disagree about which direction a click means. Nothing asserts they agree.
- **Whether the confirmation is displayed**, as opposed to computed. A button
  could call the resolver correctly and drop the result.
- **The error branch**, which renders a different element.
- **The in-flight disabled state.**

#98 also lowered the stakes: all six toggle endpoints are idempotent now, so a
mis-sent request no longer inverts an action. That is why this is a hardening
task rather than a bug fix, and why the scope below stops where it does.

## Design

### 1. A third Vitest project

```ts
{
  extends: true,
  test: {
    name: 'components',
    environment: 'jsdom',
    include: ['src/components/**/*.test.tsx'],
    setupFiles: ['./tests/setup/components.ts'],
  },
}
```

The `.tsx` extension keeps this glob disjoint from `unit`'s `src/**/*.test.ts` —
no file is collected twice. `extends: true` inherits the `@/` path alias and
`globals: true`; the project overrides the inherited `environment: 'node'`.

**CI needs no change.** `npm test` is `vitest run` with no `--project` flag, and
`.github/workflows/ci.yml:150` runs exactly that, so a new project is collected
automatically. This is worth stating because the failure mode — adding a test
layer CI never runs — would be worse than not adding one.

### 2. Three dev dependencies

`jsdom`, `@testing-library/react`, `@testing-library/jest-dom`.

**Not `@testing-library/user-event`.** These are buttons; `fireEvent.click` is
sufficient. A fourth dependency for input realism this design never exercises is
not worth its install.

**jsdom, not happy-dom**, despite happy-dom being faster and lighter. `CLAUDE.md`
frames this as an open-source project built by volunteer contributors, and jsdom
is the environment every testing-library document assumes. The speed difference
across six small button files does not repay handing a contributor an unfamiliar
runtime.

### 3. A shared setup file

`tests/setup/components.ts` registers the jest-dom matchers and provides a
default `next/navigation` mock, so six test files do not each redeclare
`useRouter`. Testing-library's automatic cleanup activates from `globals: true`,
which is already set, so no teardown wiring is needed.

Every button calls `useRouter()` and one of `refresh()` or `push()`; the mock
returns both as `vi.fn()`, and individual tests read them where the assertion
needs to.

### 4. Scope — and its boundary

**All six toggle buttons get one URL assertion per prop value:** clicking sends
the expected `?state=`. This is the coverage the inline derivation cannot get
any other way.

| Button | Endpoint |
|---|---|
| `toggle-template-button` | `/api/class-templates/{id}?state=paused\|active` |
| `archive-template-button` | `/api/class-templates/{id}?state=archived\|unarchived` |
| `toggle-studio-template-button` | `/api/studio-class-templates/{id}?state=paused\|active` |
| `archive-studio-template-button` | `/api/studio-class-templates/{id}?state=archived\|unarchived` |
| `archive-room-button` | `/api/teacher-rooms/{id}?state=archived\|unarchived` |
| `archive-student-button` | `/api/students/{id}?state=archived\|unarchived` |

**The four template buttons additionally get** three cases each: the
confirmation is rendered (not merely computed), the error branch renders its
message, and the button is disabled while the request is in flight.

**The room and student buttons stop at the URL.** They render no confirmation —
success is a `router.push` — so there is nothing further a component test would
observe that a pure function could not.

**What this layer is not.** It is not a mandate to backfill tests for every
component in `src/components`. It exists for wiring a pure function cannot
reach: a rendered element, a URL assembled inline, a branch that only shows up
in the DOM. A component whose logic is already a tested pure function, or which
renders without branching, does not need a file here. Stating this matters —
otherwise the next contributor finds an empty jsdom project and reasonably
infers an obligation to fill it.

## Testing

The tests *are* the deliverable, so the meta-question is what makes them
trustworthy rather than decorative:

- **Each URL assertion checks the whole string**, not `toContain('state=')`. A
  substring match would survive the template id being dropped, which is the
  kind of wiring error this layer exists to catch.
- **Both prop values per button.** Asserting only one direction leaves the
  ternary half-covered, and inverting it is the exact mistake the inline
  derivation risks.
- **The confirmation tests assert rendered text**, queried from the DOM, not the
  resolver's return value — that is already covered in the `unit` project, and
  re-asserting it here would prove nothing new.

**Mutation-verified**, and per the #66 lesson each mutation is confirmed to have
applied inside the component under test before its result is trusted. Two
mutations carry the weight: inverting one button's target ternary (its two URL
tests must fail, and nothing else), and dropping the `setMessage` call (that
button's confirmation test must fail while its URL tests still pass).

## Out of scope

- **Every other component.** See the boundary above.
- **`user-event`, snapshot testing, and accessibility assertions.** Each is a
  reasonable thing to want and none is needed to close this issue.
- **Testing `router.refresh()` / `router.push()` beyond that they were called.**
  What they do is Next's business.
- **The remaining Bundle 2b items** — #97, #94, #100. This layer makes them
  easier to cover; it does not cover them.

## Risks

- **A test layer that exists but is not run** is the worst outcome. Mitigated by
  `npm test` running all projects with no flag, and by the plan verifying the
  new project appears in that run before the work is called done.
- **Three dev dependencies on a volunteer project.** They are dev-only and never
  ship to the VPS, but they are three more things to keep current. jsdom in
  particular is a large install; that cost is accepted for contributor
  familiarity.
- **`act()` warnings on async state updates.** The handlers set state after an
  awaited `fetch`, so assertions must go through `findBy*`/`waitFor` rather than
  synchronous `getBy*`. Getting this wrong produces tests that pass while
  warning, which is the shape of a test nobody trusts and everyone ignores.
