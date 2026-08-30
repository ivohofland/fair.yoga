# #282 — an empty class type gets product copy in both studio forms, before any request

**Date:** 2026-08-23 · **Issue:** #282 · **Bundle:** 7 (the studio class family) ·
**Prior art:** `template-form.tsx` (the class-family twin already does this); `2026-08-23-studio-class-page-header-design.md` (same files, one day earlier)

## 1. What was measured (and where the issue needed correction)

Every claim checked against the merge base (`9cf17ec`) before designing.

### Holds

| Claim | Verified |
|---|---|
| `studio-class/new` validates location + date, nothing else | `src/app/(teacher)/studio-class/new/page.tsx:92-99`; renders `json.error?.message` verbatim at `:122` |
| `studio-template-form` validates location only | `src/components/settings/studio-template-form.tsx:101-104`; renders verbatim at `:133`. One `handleSubmit` serves create **and** edit |
| Both wire schemas require `classType: z.string().min(1)` | `src/lib/schemas.ts:446,468`. (The issue cited `:445,467` — those are the schema declarations; `classType` sits one line below each.) |
| `parseBody` joins Zod issues as developer strings | `src/lib/api-utils.ts:64-66`, `` `${i.path.join('.')}: ${i.message}` `` |
| Legacy-row mechanism | `20260411120000_add_class_type_to_studio` set `DEFAULT ''` on both tables; `20260717204036` dropped it from `StudioClassTemplate` only; `prisma/schema.prisma:563` still carries `@default("")` on `StudioClass.classType`; the template edit page loads the raw column into form state (`settings/studio-classes/[id]/page.tsx:28`) |

### New measurements the issue did not make

1. **Dev DB has zero rows with `classType = ''`** in either table
   (`docker compose exec -T db psql -U yoga -d ethical_yoga -c "SELECT …"` → `0 | 0`,
   2026-08-23). The legacy save-blocker is real in mechanism and currently empty in
   instance. No migration is warranted — a backfill cannot invent a class type.
2. **All wire-required fields are validated client-side before sending.**
   All fields of `StudioClassFormValues` and `StudioTemplateFormValues` without a valid
   default are validated before the request with product copy (#310).
3. **The class-family twins already do this.** `template-form.tsx:248`
   ("Class type is required") and the wizard `class/new/page.tsx:245`
   ("Enter a class type"). The studio forms are missing exactly their mirror's check —
   which settles the copy question and turns the issue's "asymmetry" into a rule worth
   one sentence: *client checks precisely the required fields that have no default;
   everything else arrives valid.*
4. **The write surface, re-checked after the #276 rebase.** At this branch's original
   merge base `updateStudioClassSchema` had no `classType` field at all; issue #276 has
   since admitted `classType: z.string().min(1).optional()` and opened
   `studio-class/[id]/edit` with its own form. That form already refuses an empty class
   type client-side (`studio-class-edit-form.tsx` validates in `validate()` before any
   request), so the surface stays covered — but it is three forms now, not two.
   Generation copies the template's value verbatim and every Prisma create sets the
   field explicitly (#304's spec §1 re-derived the same census).

### Wrong

Nothing in the issue failed verification. The premise held completely — recorded here
because that is itself rare enough to say.

## 2. Decision — option A: straight mirror-port

Chosen at the direction gate over:

- **B, also softening server-side Zod messages** (`parseBody` mapping or route-level
  copy): broader surface, overlaps #197's territory, and the acceptance criterion —
  refused *before a request is sent* — is met without it. The raw-string path stays for
  non-UI clients, which is who it is for.
- **C, HTML `required` attributes**: the design system's error pattern in these forms is
  the shared `setError` banner; native tooltips would be a third style, and the implicit-
  submission guards these comments carry (#40) already exist.

With the fix, both forms validate in field order (Class type → Location → Date), matching
render order, under the de facto house rule of measurement 3.

## 3. Changes

### 3.1 `src/app/(teacher)/studio-class/new/page.tsx`

Insert above the location check at `:92`:

```tsx
if (!classType.trim()) {
  setError('Class type is required');
  return;
}
```

### 3.2 `src/components/settings/studio-template-form.tsx`

Insert above the location check at `:101`:

```tsx
if (!form.classType.trim()) {
  setError('Class type is required');
  return;
}
```

One insertion covers create and edit — the legacy-row teacher now reads product copy
instead of raw Zod. No schema, service, API, or migration change. Trimmed-value check,
matching how both payloads are built (`classType.trim()` at build time in both forms).

## 4. Coverage

### Component tests (the pin)

Both files exist: `studio-template-form.test.tsx` (11 tests after this branch's
addition, 10 at the merge base) and `(teacher)/studio-class/new/page.test.tsx`
(5 after, 4 at the merge base). One addition per file:

> Submit with `classType` left empty (and everything else filled) → expect the banner
> 'Class type is required' **and** `fetch` not called.

Stub `fetch` explicitly with `vi.fn()` (`tests/setup/components.ts` does not mock it) so
"not called" is asserted against a spy rather than inferred from absence of network noise.
The two assertions pin different things — the request not being sent, and the exact copy.
On the realistic continuing-guard mutant (the guard fires but its `return` is dropped),
both assertions go red: `handleSubmit` clears `error` just before the request, so the
banner assertion finds nothing and throws, but that red would read as a missing guard;
the spy's red names the outgoing request. The spy also stays decisive if the pre-request
clearing ever changes, which a banner-only pin would not.

### Proving the guards bite (explicit steps, per guard)

For each of the two new guards, in each form:

1. With the test in place, comment out the new `if` block. Run the single file.
   Expected failure: the spy assertion reports `fetch` called once (or, unstubbed, the
   catch arm sets 'Network error…'). Record the exact failure text.
2. Restore. Re-run green.

Component tests hit no dev server, so warm-route discipline does not apply here; the
mutation values are deletions of real code, so the reserved-value rule does not either.

### Deliberately not covered

- **No integration test.** This branch touches no API/service file; the refusal happens
  client-side by construction, and the component spy pins "before a request is sent"
  more directly than an HTTP-level test could.
- **No e2e step.** It would duplicate the component pin through a slower harness. The
  existing arcs stay untouched.

## 5. What this does not do

- **#197 is unaffected** — its eighteen conflict responses are a different mechanism
  (409s after a round trip) with their own issue.
- **#284 is unaffected** (generation week-keying).
- No change to `parseBody`: developer strings remain correct output for non-UI clients.
- No data migration for `''` rows: none exist here, and none can be meaningfully
  invented. Should production ever hold one, this fix alone downgrades its symptom from
  raw Zod to the same banner every other missing field gets.

## 6. Re-derivables

- Client-checked required fields across the app:
  `grep -rn "is required'" src/app src/components | grep -v test` — returns the API
  state-guards (server side, different thing) plus **eleven** client lines at the
  pre-branch merge base and **thirteen** after this branch (the two new ones land in this
  branch's two files). #276's edit form contributes no hits — its copy ends in a period,
  which the pattern does not match.
- Wire requirements: `sed -n '445,483p' src/lib/schemas.ts`.
- Empty-`classType` row count: the psql one-liner in §1.1, re-runnable verbatim.
