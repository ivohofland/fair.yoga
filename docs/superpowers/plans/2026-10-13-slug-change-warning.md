# Slug-change warning Implementation Plan (#826)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Before a teacher saves a new page slug, tell them that the links they have already shared to the old one will stop working.

**Architecture:** One client component, `src/components/settings/profile-form.tsx`. The form records the slug the server last confirmed (`savedSlug`, the same pattern as the existing `savedCurrency`) and, while the field differs from it, shows a gold attention caption under the field naming the old address. No server, schema or route change.

**Tech Stack:** React 19 client component, Vitest + Testing Library (`components` project).

**Spec:** none — single file, one obvious approach. Direction was set on the issue: warning only, no redirect (a `PreviousSlug` table and redirects add reservation, erasure and availability surface to maintain). No confirm-on-save either: the caption sits beside the field being edited, and a modal would be a second interruption for the same fact.

## Premise, as measured

- `Teacher.pageSlug` is one `@unique` string (`prisma/schema.prisma`); no previous value is kept, and `src/app/(public)/[slug]/page.tsx` calls `notFound()` when no teacher holds the slug. Holds.
- The only path that *changes* an existing slug is `PUT /api/teachers/[id]` from the profile form. Signup (`page-address-field.tsx`, `profile-setup-form.tsx`) and `api/account/teacher-profile` *create* one; `services/gdpr.ts` rewrites it on erasure. Holds.
- Refinement: in-app notification links are built at read time from the current slug (`src/lib/notification-links.ts`, `/${…teacher.pageSlug}/book/…`), so they follow a change. What breaks is only what left the app — bio links, emails, copied share links. The warning's wording says "links you've already shared" for that reason.

## Global Constraints

- Copy, exactly: `Links you’ve already shared to fair.yoga/{savedSlug} will stop working.` (typographic apostrophe `’`, as `currencySwitchLine` in the same file uses).
- Styling follows the in-settings attention precedent `late-first-class-notice.tsx`: `type-caption text-gold-deep bg-gold-tint rounded-card px-4 py-3` (no `mb-4`; the section's `gap-4` spaces it). Gold is never body text on cream — the tint background is what makes `text-gold-deep` legible.
- The caption is tied to the input with `aria-describedby` so a screen reader hears it on the field, not only when it appears.
- The caption sits in an always-mounted `aria-live="polite"` region (`empty:hidden`, so it adds no gap while empty): `aria-describedby` is read on focus, and the caption appears while the field already has it. Added after the branch review, with a network-error test (`fetch` rejects → warning stays).
- Comments describe this file's code only (CLAUDE.md, *Comment Discipline*).

## Review Focus

1. **Warning persisting after a successful save** — `useState(initial)` ignores the refreshed `initial` prop after `router.refresh()`, so without `savedSlug` the warning would stay up naming a slug that is already gone. Pinned by the "clears after save" test.
2. **Failed save (409 `SLUG_TAKEN`, network error)** — the slug was not saved, so the warning must stay. Pinned by the "keeps the warning when the save fails" test.
3. **Typing back to the saved slug** — no change, no warning. Pinned.
4. **A second change after a saved one** — the warning names the slug saved most recently, not the one the page loaded with. Pinned.
5. **Untouched form** — no warning on load. Pinned.

---

### Task 1: Warn while the page slug differs from the saved one

**Files:**
- Modify: `src/components/settings/profile-form.tsx` (state block near `savedCurrency`; success branch of `handleSubmit`; the *Public page* section)
- Test: `src/components/settings/profile-form.test.tsx` (new `describe('page slug change', …)` block)

**Interfaces:**
- Consumes: nothing new. `Input` already accepts `aria-describedby` and merges it with its own hint/error ids (`src/components/ui/input.tsx`).
- Produces: nothing other tasks use.

- [ ] **Step 1: Write the failing tests** — add inside the top-level `describe('ProfileForm')`, after the currency `describe`:

```tsx
  describe('page slug change', () => {
    const warning = (slug: string): string =>
      `Links you’ve already shared to fair.yoga/${slug} will stop working.`;
    // Any slug's warning, so an absence check cannot pass by the caption naming the wrong one.
    const anyWarning = /^Links you’ve already shared to fair\.yoga\/.* will stop working\.$/;

    function slugField(): HTMLInputElement {
      return screen.getByLabelText('Page slug') as HTMLInputElement;
    }

    it('shows no warning while the slug is unchanged', () => {
      renderForm();
      expect(screen.queryByText(anyWarning)).toBeNull();
    });

    it('warns that links to the saved slug will stop working, and ties the warning to the field', () => {
      renderForm();
      fireEvent.change(slugField(), { target: { value: 'anna-yoga' } });
      const caption = screen.getByText(warning('anna'));
      expect(slugField().getAttribute('aria-describedby')?.split(' ')).toContain(caption.id);
    });

    it('drops the warning when the teacher types the saved slug back', () => {
      renderForm();
      fireEvent.change(slugField(), { target: { value: 'anna-yoga' } });
      fireEvent.change(slugField(), { target: { value: 'anna' } });
      expect(screen.queryByText(anyWarning)).toBeNull();
      expect(slugField()).not.toHaveAttribute('aria-describedby');
    });

    it('clears the warning once the new slug is saved', async () => {
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
      vi.stubGlobal('fetch', fetchMock);
      renderForm();
      fireEvent.change(slugField(), { target: { value: 'anna-yoga' } });
      save();
      expect(await screen.findByText('Saved')).toBeInTheDocument();
      expect(screen.queryByText(anyWarning)).toBeNull();
    });

    it('names the slug saved last when the teacher changes it again', async () => {
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
      vi.stubGlobal('fetch', fetchMock);
      renderForm();
      fireEvent.change(slugField(), { target: { value: 'anna-yoga' } });
      save();
      expect(await screen.findByText('Saved')).toBeInTheDocument();
      fireEvent.change(slugField(), { target: { value: 'anna-flow' } });
      expect(screen.getByText(warning('anna-yoga'))).toBeInTheDocument();
    });

    it('keeps the warning when the save fails', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 409,
        json: async () => ({ error: { code: 'SLUG_TAKEN', message: 'That page slug is already taken.' } }),
      });
      vi.stubGlobal('fetch', fetchMock);
      renderForm();
      fireEvent.change(slugField(), { target: { value: 'taken-slug' } });
      save();
      expect(await screen.findByText('That page slug is already taken.')).toBeInTheDocument();
      expect(screen.getByText(warning('anna'))).toBeInTheDocument();
    });
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec vitest run --project components src/components/settings/profile-form.test.tsx`
Expected: the three tests that look for the warning text FAIL (`Unable to find an element with the text: Links you’ve already shared…`); the three that assert its absence pass vacuously until Step 3 — they become meaningful only once the caption can render, which Step 5 proves.

- [ ] **Step 3: Implement** in `profile-form.tsx`.

State, beside `savedCurrency`:

```tsx
  // The slug the server last confirmed, so the warning below names the address
  // that is live now and goes away once a new one is saved.
  const [savedSlug, setSavedSlug] = useState(initial.pageSlug);
```

In `handleSubmit`'s success branch, beside `setSavedCurrency`:

```tsx
      setSavedSlug(payload.pageSlug);
```

The *Public page* section becomes:

```tsx
      {/* Public page */}
      <section className="flex flex-col gap-4">
        <h2 className="type-subtitle">Public page</h2>
        <Input
          label="Page slug"
          value={form.pageSlug}
          maxLength={PAGE_SLUG_MAX}
          aria-describedby={slugChanged ? slugWarningId : undefined}
          onChange={(e) => update('pageSlug', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
        />
        <p className="type-caption">
          Your booking page: fair.yoga/{form.pageSlug}
        </p>
        {slugChanged && (
          <p id={slugWarningId} className="type-caption text-gold-deep bg-gold-tint rounded-card px-4 py-3">
            Links you’ve already shared to fair.yoga/{savedSlug} will stop working.
          </p>
        )}
      </section>
```

with, in the component body before `return`:

```tsx
  // True while the field holds a slug the server has not confirmed; the
  // caption under the field then names the address still live.
  const slugChanged = form.pageSlug.trim() !== savedSlug;
  const slugWarningId = useId();
```

(`useId` must be called unconditionally, so place it with the other hooks at the top of the component, and import it from `react`.)

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm exec vitest run --project components src/components/settings/profile-form.test.tsx`
Expected: all PASS.

- [ ] **Step 5: Prove the guards bite** — record each exact failure text in the task report, restore, re-run green:
  1. Delete `setSavedSlug(payload.pageSlug);` → "clears the warning once the new slug is saved" and "names the slug saved last…" must FAIL.
  2. Change `slugChanged` to `form.pageSlug.trim() !== initial.pageSlug` → "clears the warning once the new slug is saved" must FAIL (realistic regression: reading the stale prop leaves a warning up naming the just-saved slug — which is why the absence checks match any slug, not only the original one).
  3. Drop the `aria-describedby` prop → "…ties the warning to the field" must FAIL.
  4. Change `slugChanged` to `true` → "shows no warning while the slug is unchanged" and "drops the warning…" must FAIL (proves the absence tests are not vacuous).

- [ ] **Step 6: Typecheck and lint** — `pnpm run typecheck && pnpm run lint` (check `package.json` for exact script names).

- [ ] **Step 7: Commit**

```bash
git add src/components/settings/profile-form.tsx src/components/settings/profile-form.test.tsx
git commit -m "feat: warn that shared links break when the page slug changes (#826)"
```
