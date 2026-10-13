# Push tap navigates even when focus is refused (#871)

**Goal:** a notification tap navigates the already-open app window whether or
not `WindowClient.focus()` succeeds, and every failure the click handler
recovers from is logged with the worker's `[sw]` prefix.

**Premise, measured:** `public/sw.js`'s `notificationclick` handler chains
`existing.focus().then((client) => client.navigate(url)).catch(() => self.clients.openWindow(url))`.
A rejected `focus()` therefore skips `navigate()` entirely and goes to
`openWindow`, and the `.catch` discards the error. Both claims in the issue
hold. Outside `docs/superpowers/`, no page under `docs/` describes this
handler, and the only source file naming `notificationclick` besides the worker
is `src/lib/sw.test.ts`. The web-push design spec
(`docs/superpowers/specs/2026-10-02-web-push-design.md`) describes it as
"focus an open fair.yoga window and navigate it to `url`, else
`openWindow(url)`", which stays true after this change.

**Design (decided, no alternatives worth carrying):**

- Keep the order focus → navigate (the existing order test pins it; focusing
  first is what a desktop browser wants). Focus is best-effort: a rejection is
  logged with `console.warn('[sw] …', err)` and the chain continues.
- Navigate `existing` — the window `matchAll` found — not the client `focus()`
  resolves to, since on the refused path there is no resolved client.
- Fall back to `self.clients.openWindow(url)` only when `navigate` rejects,
  logging that rejection with `console.warn('[sw] …', err)` first.
- The outer `.catch` (`console.error('[sw] notificationclick failed', err)`)
  stays as the net for `matchAll` or `openWindow` failing.
- The comment above the branch states what is true of the new chain: focus is
  best-effort, navigate does not need it, and why navigate can reject.

## Task 1 — the click handler (single task)

**Files:** `public/sw.js`, `src/lib/sw.test.ts`.

**Tests first** (in the `notificationclick` cases of `src/lib/sw.test.ts`):

1. Replace *"opens a window at the url when the open window refuses focus"*
   with: focus rejects, navigate resolves → `navigate` called with the url,
   `openWindow` not called, `console.warn` called once with a `[sw] `-prefixed
   message and the focus error.
2. Add: focus rejects, navigate rejects → `openWindow(url)` called,
   `console.warn` called with the focus error and with the navigate error
   (each with a `[sw] ` prefix).
3. Extend *"opens a window at the url when the open window refuses to
   navigate"* to assert the navigate error is warned with a `[sw] ` prefix.
4. Unchanged and must keep passing: the focus→navigate order case, the
   `waitUntil` keep-alive case, the outer-failure `console.error` case.

Spy on `console.warn` with `mockImplementation(() => {})` inside
`try/finally … mockRestore()`, as the existing `console.error` cases do.

Run `pnpm exec vitest run src/lib/sw.test.ts` and see cases 1–3 fail against
the current worker.

**Implement** the design above in `public/sw.js`. Re-run; all pass.

**Prove the guards bite** (record each error text, restore, re-run green):

- Restore the old `.then((client) => client.navigate(url))` chain → case 1
  must fail (navigate not called / openWindow called).
- Drop the `console.warn` on the focus rejection → cases 1 and 2 must fail.
- Drop the `console.warn` on the navigate rejection → cases 2 and 3 must fail.

**Verify:** `pnpm run typecheck`, `pnpm run lint`, and the unit project.

**Commit:** one `fix:` commit for the worker and its tests, `(#871)` suffix.

No whole-branch review step of its own: with one task, the task review sees the
whole branch.

## Folded from review

- A test that an `openWindow` rejection in the fallback reaches the outer
  `console.error` (*"logs a fallback window that fails to open, rather than
  failing the event"*), proven by replacing the outer catch with
  `.catch(() => {})`.
- The happy-path order case asserts no `console.warn`; the navigate-refused
  case pins the warn count to one.
- The comment and the navigate-refusal log say `openWindow(url)` is *asked*:
  on an app already running it may only bring the app forward.
