# Verify sends its token once — plan (#760)

**Goal:** one page load of `/verify?token=…` sends exactly one
`POST /api/auth/magic-link/verify`, in development (React Strict Mode) and in
any future case that re-runs the verification effect.

**No spec.** One file, one reasonable design (the issue's), no data model,
auth-flow, or concurrency invariant changes on the server.

## Premise, as measured

- Holds. `src/app/(public)/verify/page.tsx`: the verification effect has no
  cleanup and no once-guard; its line numbers have moved by one since the
  issue was filed (`useEffect` at :628, `fetch` at :632, deps at :758 on
  `18eb8ad5`).
- Strict Mode is on in `next dev`: `next.config.ts` does not set
  `reactStrictMode`, and the bundled docs
  (`node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/reactStrictMode.md`)
  say it defaults to `true` for the App Router since 13.5.1.
- Reproduced in jsdom: rendering inside `<StrictMode>` sends two POSTs, and
  with the server's real answers (one success, one 400, probe 401) the page
  ends on **"Verification failed"** — last outcome wins.
- One twin the issue did not name: the `router` mock's docblock in
  `page.test.tsx`, and `student-directory.test.tsx`'s claim that
  `grep -rn StrictMode src/` is empty — this change makes it non-empty.

## Task 1 — once-guard, test first

Files: `src/app/(public)/verify/page.tsx`,
`src/app/(public)/verify/page.test.tsx`,
`src/components/students/student-directory.test.tsx` (comment only).

1. Add a `describe('under React Strict Mode')` block to `page.test.tsx`:
   - *sends a single-use token once*: the mock answers like the server (first
     verify ok, later ones 400, session probe 401), a turn late, honouring its
     abort signal. Assert one verify POST, the signed-in screen, no error
     screen, no `console.error`.
   - *lets the ceiling abort the request it is waiting on*: a never-answering
     fetch, advance `VERIFY_CEILING_MS`, assert one call and that its signal is
     aborted.
   Run both; both must fail on `main`.
2. In `VerifyContent`, add `sentFor = useRef<string | null>(null)`; at the top
   of the effect, return when `sentFor.current === token`, then record it.
   No abort-in-cleanup (it can cancel a request that already spent the token).
3. Rewrite the comments that described the double-mount as expected: the
   `inFlight` docblock, `settle`'s second-outcome branch, the note under it
   about `settle`'s stability, the test file's `router` docblock, and the
   `student-directory.test.tsx` StrictMode grep claim.
4. Prove the guard bites — apply each, record the failure, restore:
   - remove the `sentFor` check;
   - reset `sentFor` in an effect cleanup;
   - add `return () => controller.abort()` as the effect's cleanup, guard
     kept — the alternative the issue rejects.
5. `pnpm run verify`; one Playwright page load against the worktree's dev
   server counting verify POSTs.
