# Settings slug field: live availability check (#827) — plan

## Premise, as measured on `origin/main` (dafe0d4b)

- Holds: Settings → Profile (`src/components/settings/profile-form.tsx`) edits the
  slug with a plain `Input`, filtering characters only. A taken slug surfaces as
  the 409 `SLUG_TAKEN` in the form-level error after Save; a reserved one as the
  route's 400 validation message.
- Holds: `/api/teachers/slug-available` answers `available: false` for the
  caller's own slug — it is a `findUnique` on `pageSlug`, with no notion of who
  asks (it is public, used before a session exists at signup).
- Changed since filing: #826 is closed and its warning ("Links you've already
  shared to fair.yoga/<saved> will stop working.") is live in the profile form,
  in an always-mounted `aria-live` region, tied to the field by
  `aria-describedby`. The issue's "if both land" is the current state.
- Not in the issue: the two fields carry different labels — signup "Page
  address", settings "Page slug" — and `PAGE_SLUG_TAKEN_MESSAGE`
  (`src/lib/schemas.ts`) is documented as worded after the settings label.

## Decisions (gates self-adjudicated; the user asked for an unattended run)

1. **Reuse `PageAddressField`, don't copy its check.** One component, so the two
   places that edit a slug cannot drift. (Alternative — extract a
   `useSlugAvailability` hook and keep the settings `Input` — rejected: two
   renderings of the verdict to keep in step.)
2. **The teacher's own slug is answered locally, silently.** New optional prop
   `currentSlug`. While `value === currentSlug`: no request, and no verdict drawn
   — even a stored answer for that value (an "Available" fetched before it was
   saved must not linger as a claim about the teacher's own address). Silence,
   not "Available": the field is unchanged, so there is nothing to say.
   Client-side rather than a session-aware endpoint: the endpoint is public and
   serves signup, where no teacher exists yet.
3. **The #826 warning sits with the verdict, under the field.** `PageAddressField`
   gains `children` (rendered last in its column, after the verdict) and an
   `aria-describedby` passthrough to its `Input`. The profile form passes its
   live region + warning as children, unchanged in behaviour.
4. **The 409 `SLUG_TAKEN` at save becomes the field's `error`,** keyed to the
   slug it was about (the `SlugRejection` shape `profile-setup-form.tsx` already
   uses), so editing the slug retires it. Other failures keep the form-level
   error. It still renders as `role="alert"` (the `Input`'s error span).
5. **One label: "Page address".** Settings adopts the signup label; the
   form-level "Page slug is required" becomes "Page address is required";
   `PAGE_SLUG_TAKEN_MESSAGE` becomes "That page address is already taken." and
   its docblock keeps naming the label it follows.
6. **Kept as is:** the settings field's character filter (lowercase, strip
   outside `[a-z0-9-]`) stays in the profile form's `onChange` — not asked for,
   and harmless with a live check.

## Task 1 — `PageAddressField`: `currentSlug`, `children`, describedby

Files: `src/components/signup/page-address-field.tsx`,
`src/components/signup/page-address-field.test.tsx`.

Tests first (follow the file's existing timer/fetch style):
- with `currentSlug="anna"` and `value="anna"`: after the debounce, no request
  is made and neither "Available" nor "That address is taken" is drawn;
- a value other than `currentSlug` is still checked and its verdict drawn;
- an answer stored for a value that then becomes `currentSlug` (rerender with
  `currentSlug` equal to the checked value) draws no verdict;
- `children` render inside the field's column, after the verdict;
- an `aria-describedby` passed in reaches the input, alongside the error id
  when there is an error.

Then implement. Docblocks state what is true now; no prose counts.

Prove the guard bites: remove the `currentSlug` short-circuit in the effect,
record the failing test's message, restore; same for the render-side
suppression.

## Task 2 — `ProfileForm` uses `PageAddressField`

Files: `src/components/settings/profile-form.tsx`,
`src/components/settings/profile-form.test.tsx`, `src/lib/schemas.ts`
(`PAGE_SLUG_TAKEN_MESSAGE` text), and any test asserting the old label or
message (`grep -rn "Page slug\|page slug is already taken" src tests e2e`).

Depends on Task 1.

Tests first:
- the field is labelled "Page address";
- typing a different slug triggers a `slug-available` request and draws its
  verdict ("Available" / "That address is taken");
- the saved slug (initial, and after a successful save of a new one) draws no
  verdict and makes no `slug-available` request;
- a 409 `SLUG_TAKEN` at save shows the server message as the field's error
  (`role="alert"`, input `aria-invalid`), not the form-level error, and editing
  the slug clears it; a non-slug failure still uses the form-level error;
- every existing #826 warning test still passes (live region pre-mounted,
  `aria-describedby` contains the warning id, etc.). Existing tests whose
  `fetchMock` now also sees `slug-available` calls must route by URL rather
  than assume call order.

Implement: replace the slug `Input` + caption with `PageAddressField`
(`value`, filtered `onChange`, `currentSlug={savedSlug}`, `error`,
`aria-describedby` for the warning, warning live region as children). The
field's own caption "Your booking page: fair.yoga/…" replaces the form's.

Prove the guard bites: route `SLUG_TAKEN` back to the form-level error and
record the failing test; drop `currentSlug` from the call and record which test
fails.

## Then

Whole-branch review (2 tasks) → one fix wave → scoped re-review → `pnpm run
verify` in the worktree (`pnpm run worktree:up` first) → PR → CI → PR toolkit →
rebase-merge.
