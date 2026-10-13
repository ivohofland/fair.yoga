# #880 — Bump eslint-config-next to 16.4.0; resolve react-hooks 7.1.1's four errors

**Issue:** #880. **Spec:** none — gated out: a dev-dependency bump plus four client
components, no data model, invariant, money or auth logic touched, and each site has one
design once its premise is measured (below). The issue body is the requirements.

**Premise verified on `0421b58c` (origin/main), `eslint-config-next@16.4.0` added:**
`pnpm exec eslint .` → `✖ 10 problems (4 errors, 6 warnings)` — the four errors the issue
names, at the lines it names, and the six `no-location-assign-relative-destination`
warnings. Lockfile then holds `eslint-plugin-react-hooks@7.1.1` and no `7.0.1`.

Per-site verdict, each measured by editing the file and re-linting:

| site | rule | verdict | resolution |
|---|---|---|---|
| `bank-account-form.tsx:214` | `refs` | false positive — `handleRemove` reads `headingRef` only from the confirm click | rewrite: `onConfirm` moves from the `removeControlProps(...)` return object to a JSX prop at both `<RemoveControl>` sites. Measured CLEAN. The rule flags any ref-reading closure handed to a function called during render; extracting the ref read into a `focusHeading()` helper is still flagged |
| `attendance-list.tsx:219` | `refs` | false positive — a ref callback runs at commit | per-line `eslint-disable-next-line react-hooks/refs -- …`. React's own documented "list of refs" pattern (`map.set` + returned cleanup) is flagged identically, measured; a `useCallback` ref factory passes the rule only by hiding the read from it, and the DOM-query alternative couples focus order to DOM order instead of to the id |
| `account-security.tsx:82` | `set-state-in-effect` | **issue premise wrong**: no state is set "at the top of the effect" — every `setState` in `loadPasskeys` sits after `await fetch`. The rule does not model an `await` inside a called function | rewrite: a module-level `fetchPasskeys()` returns the rows or `null` without touching state; the effect applies the result in `.then`, behind a `cancelled` flag; a component-local `applyPasskeys(rows)` sets state, and `loadPasskeys` (handlers) is `applyPasskeys(await fetchPasskeys())` |
| `add-walk-in.tsx:107` | `set-state-in-effect` | **real**: six synchronous `setState`s at the top of the effect, an extra render per open and per refetch | rewrite, see Task 3 |

## Global Constraints

- TypeScript `strict`, no `any`, no casts to silence the compiler.
- No blanket rule disable — the one disable is per-line and states why.
- CLAUDE.md *Comment Discipline*: comments state what is true now; no prose counts.
- Stage exact paths; never `git add -A`.
- `package.json` changes by the one version line only — `pnpm add` reformats the
  `devEngines` object, so edit the line by hand and run `pnpm install`.

Task order is load-bearing: Task 1 lands the bump so Tasks 2–3 lint against the rules they
are fixing.

## Task 1 — the bump

**Files:** `package.json` (`eslint-config-next` `16.3.4` → `16.4.0`), `pnpm-lock.yaml`.

- After `pnpm install`, the lockfile holds `eslint-plugin-react-hooks@7.1.1` and no `7.0.1`.
- `pnpm exec eslint .` reports exactly the four errors above (lint is red at this commit;
  Tasks 2–3 turn it green).
- Commit: `chore: bump eslint-config-next to 16.4.0 (#880)`.

## Task 2 — the three small sites

**Files:** `src/components/settings/bank-account-form.tsx`,
`src/components/class/attendance-list.tsx`, `src/components/account/account-security.tsx`.
One commit per file.

- **bank-account-form:** as in the table. No behaviour change; existing
  `bank-account-form.test.tsx` covers remove-confirm and focus.
- **attendance-list:** the disable sits on the line before the `ref={(el) => …}` callback's
  first `dismissRefs.current` access, with a reason in the house style
  (`-- a ref callback runs at commit, not render`). No code change.
- **account-security:** as in the table. Behaviour: identical on mount, plus a result that
  lands after unmount is dropped (React already ignores it; no test needed). Existing
  `account-security.test.tsx` must pass unchanged.
- Verify: `pnpm exec eslint <file>` clean for each; the file's component test passes.

## Task 3 — `AddWalkIn` loads without synchronous effect state

**Files:** `src/components/class/add-walk-in.tsx`, `src/components/class/add-walk-in.test.tsx`.

**Shape:** each list's four pieces of state (`students` + `studentsLoaded` +
`studentsFailed`, and the invitations trio) collapse into one discriminated union per list:
`{ status: 'loading' } | { status: 'loaded'; rows: T[] } | { status: 'failed' }`. "Failed
with stale rows" becomes unrepresentable, which is the bug the current
reset-both-lists comment guards against by hand.

**Behaviour:**
1. Opening the picker (the "Add walk-in" click) sets both lists to `loading`, then opens —
   the reset lives in the event handler, not the effect.
2. The effect only fetches; each list's state is set in its `.then`/`.catch`, behind the
   existing `cancelled` flag. Its deps stay `[open, registeredStudentIds, classId]` — the
   refetch on a fresh `registeredStudentIds` identity is how `LiveUpdates`'
   `router.refresh()` brings a newly linked student into an open picker, and an existing
   test pins it.
3. A refetch while open keeps the current rows on screen until its result replaces them
   (success → new rows; failure → `failed`, rows gone, message shown). A list already
   `failed` keeps its message until the refetch settles. Today the picker blanks to loading
   on every refresh.
4. The already-registered filter applies at render against the current
   `registeredStudentIds`, not at fetch time, so a student registered by the refresh that
   triggered the refetch is gone from the picker immediately, not one fetch later.

**Tests (write first; the first two fail on the current code, the third passes there — the old effect's reset covered reopen — and guards the open-handler reset instead, proven by mutation (c)):**
- A refetch triggered by a rerender with a fresh `registeredStudentIds` keeps the picker's
  existing options visible while the refetch is pending (hold the second fetch on a
  deferred promise).
- A rerender whose `registeredStudentIds` gains a listed student drops that option before
  the refetch resolves.
- Close then reopen shows no options from the earlier open while the new fetch is pending.
- Every existing test passes unchanged.

**Prove the guards bite:** after GREEN, (a) re-add a `loading` reset at the top of the effect
→ the keep-rows and drop-option tests fail; (b) move the registered filter back into the fetch `.then` → the
drop-option test fails; (c) remove the reset from the open handler → the reopen test fails.
Record each failure's text, restore, re-run.

Commit: `fix: AddWalkIn resets its lists on open, not in the effect (#880)`.

## Done

`pnpm run lint` exits 0 (warnings: the six pre-existing); `pnpm run verify` green;
`pnpm run build` succeeds.
