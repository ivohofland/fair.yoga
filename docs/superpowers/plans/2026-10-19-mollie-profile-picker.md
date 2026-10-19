# Mollie profile picker: unverified profiles shown, not choosable (#908)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In live mode a teacher can no longer connect Mollie to a profile Mollie has not verified: the picker shows such a profile disabled with the reason, the server refuses it, and the callback never auto-picks it. Each option shows its website so same-named profiles can be told apart.

**Architecture:** One predicate, `isChoosableProfile`, in `src/services/processor-connection.ts`, read by the callback's auto-pick, by `chooseProfile`'s server check, and (through the view's `choosable` flag) by the picker. Blocked profiles stay hidden; unverified ones are listed but not choosable.

**Tech Stack:** Next.js 16, TypeScript strict, zod, vitest (unit, components), Testing Library.

**Spec:** none — bounded change, design agreed in chat (issue #908 plus the decisions below). The #896 spec `docs/superpowers/specs/2026-10-18-mollie-connect-design.md` stays the authority for everything else in the connect flow; its "One usable profile" bullet is updated in Task 1.

## Decisions (owner, 2026-10-19)

- Unverified profiles are shown in the picker but cannot be chosen.
- A profile losing verification after it was chosen is **out of scope** (nothing re-reads it after the choice; existing connections are untouched).
- The no-website guidance line appears **only when at least one listed profile is not choosable** (option A).
- Same-named profiles are told apart by Mollie's `website`.

## Global Constraints

- Choosable: in test mode (`deps.config.testmode`), every listed profile; in live mode, only `status === 'verified'`. Listed (unchanged): never `blocked`, and in live mode only `mode === 'live'`.
- New registered code `PROCESSOR_PROFILE_UNVERIFIED: 409` in `src/lib/api-error-codes.ts`; copy: `Mollie hasn’t verified that profile yet.` (curly apostrophe, as the file's neighbours).
- Per-option caption for an unchoosable profile: `Mollie hasn’t verified this profile yet.`
- Guidance copy (exact): `Mollie checks each profile by hand before it can take payments. Teaching in person without a website? In Mollie, choose the option for businesses without a website, describe your classes, and link your fair.yoga page or your social media.` followed by a link `What Mollie checks` to `https://help.mollie.com/hc/en-us/articles/211745545` (`target="_blank" rel="noopener noreferrer"`).
- Never "Level 1/2" in copy. Comments annotate their own code (CLAUDE.md, Comment Discipline); no counts or rosters in comments.

## Review Focus

1. A Mollie organization with exactly one profile, unverified, in live mode: the callback must land on the picker (`choose_profile`), not auto-connect. (Task 1 test.)
2. A hand-built `PUT` with an unverified profile's id: 409 `PROCESSOR_PROFILE_UNVERIFIED`, `profileId` unchanged, no `PayoutChangeEvent`. (Task 1 test.)
3. Reconnect, same organization, previous profile now unverified, several profiles: previous is not kept; `profileId` null. (Task 1 test.)
4. Test mode: an unverified profile stays choosable and still auto-picks when it is the only one. (Task 1 test.)
5. A picker in which no profile is choosable: every radio disabled, submit disabled, guidance shown. (Task 2 test.)

---

### Task 1: The rule, the server refusal, and the website field

**Files:**
- Modify: `src/lib/mollie/client.ts` (`MollieProfile`, `profilesSchema`, the `profiles()` mapping near line 232)
- Modify: `src/services/processor-connection.ts` (`usableProfiles` ~276, `initialProfile` ~285, callback use ~165–200, `ChooseProfileOutcome` ~312, `chooseProfile` ~336–344, `ConnectionView` ~511, `readConnectionView` ~565)
- Modify: `src/lib/api-error-codes.ts`
- Modify: `src/app/api/teachers/[id]/processor/profile/route.ts`
- Modify: `docs/superpowers/specs/2026-10-18-mollie-connect-design.md` (the "One usable profile" / "Several" bullets, ~293–301)
- Test: `src/lib/mollie/client.test.ts`, `src/services/processor-connection.test.ts`, `src/app/api/teachers/[id]/processor/profile/route.test.ts`

**Interfaces:**
- Produces: `MollieProfile = { id: string; name: string; mode: 'live' | 'test'; status: string; website: string | null }`.
- Produces: `export function isChoosableProfile(p: Pick<MollieProfile, 'status'>, testmode: boolean): boolean`.
- Produces: `ProfileOption = { id: string; name: string; website: string | null; choosable: boolean }` (exported type); `ConnectionView`'s `choose_profile.profiles` and `connected.profiles` become `ProfileOption[]`.
- Produces: `ChooseProfileOutcome` gains `{ kind: 'unverified_profile' }`.

- [ ] **Step 1: Client reads `website`.** In `profilesSchema` add `website: z.string().nullish()`; `MollieProfile` gains `website: string | null`; the mapping writes `website: p.website ?? null`. Add a client test: a profile JSON with `website: 'https://zwem.men'` maps to that string; one without the key maps to `null`. Update every `MollieProfile` fixture the compiler then flags (`pnpm exec tsc --noEmit` lists them) with `website: null` or a value.

- [ ] **Step 2: Write the failing service tests** in `processor-connection.test.ts`, using the file's existing `connect`/`mollieAnswers` helpers and `liveDeps` (plus a test-mode deps variant if the file has one; otherwise build one the way `liveDeps` is built with `testmode: true`):
  - `isChoosableProfile`: live × `verified` → true; live × `unverified` → false; test × `unverified` → true.
  - Callback, live, the organization's only profile is `unverified` → outcome `choose_profile`, row `profileId` null, no `PayoutChangeEvent`.
  - Callback, test mode, only profile `unverified` → chosen (as today).
  - Callback, live, reconnect same organization, two profiles, previous one now `unverified` → `profileId` null.
  - Callback, live, two profiles, one verified and one unverified, no previous → `choose_profile` (no auto-pick when several are listed).
  - `chooseProfile` with a listed `unverified` id in live mode → `{ kind: 'unverified_profile' }`, `profileId` unchanged, no event.
  - `readConnectionView` lists the unverified profile with `choosable: false` and `website` passed through; blocked stays absent.
  Run `pnpm exec vitest run src/services/processor-connection.test.ts` — expect the new tests to FAIL.

- [ ] **Step 3: Implement.**

```ts
/** Whether a listed profile may take this connection's payments: in live mode only one Mollie has verified. */
export function isChoosableProfile(p: Pick<MollieProfile, 'status'>, testmode: boolean): boolean {
  return testmode || p.status === 'verified';
}

export type ProfileOption = { id: string; name: string; website: string | null; choosable: boolean };

function profileOptions(profiles: readonly MollieProfile[], testmode: boolean): ProfileOption[] {
  return profiles.map((p) => ({ id: p.id, name: p.name, website: p.website, choosable: isChoosableProfile(p, testmode) }));
}

/** The profile a callback lands on: the only one listed, or the previous live one when the organization is unchanged and still lists it — either only when choosable. */
function initialProfile(
  profiles: readonly MollieProfile[], organizationId: string, previousLive: LiveIdentity | null, testmode: boolean,
): MollieProfile | null {
  const pick = (p: MollieProfile | undefined) => (p !== undefined && isChoosableProfile(p, testmode) ? p : null);
  if (profiles.length === 1) return pick(profiles[0]);
  if (previousLive === null || previousLive.organizationId !== organizationId) return null;
  return pick(profiles.find((p) => p.id === previousLive.profileId));
}
```

  Rename nothing else: `usableProfiles` keeps its job (what is listed) — update its docblock to say "listed" rather than "can take payments". Pass `deps.config.testmode` to `initialProfile` at its call site. In `chooseProfile`, after the existing `unknown_profile` check:

```ts
  const picked = profiles.find((p) => p.id === input.profileId);
  if (picked === undefined) return { kind: 'unknown_profile' };
  if (!isChoosableProfile(picked, deps.config.testmode)) return { kind: 'unverified_profile' };
```

  In `readConnectionView`, `profiles` becomes `profileOptions(usableProfiles(…), deps.config.testmode)`; `profileName` lookup unchanged.

- [ ] **Step 4: Route and code.** Add `PROCESSOR_PROFILE_UNVERIFIED: 409,` to `api-error-codes.ts` in alphabetical position. In the profile route's switch add:

```ts
    case 'unverified_profile':
      return respondError('Mollie hasn’t verified that profile yet.', 409, 'PROCESSOR_PROFILE_UNVERIFIED');
```

  Route test: `m.chooseProfile.mockResolvedValue({ kind: 'unverified_profile' })` → status 409 and code `PROCESSOR_PROFILE_UNVERIFIED` (assert the code, not the message, as the file's other cases do).

- [ ] **Step 5: Run** the three test files and `pnpm exec tsc --noEmit`. Expected: PASS, no type errors.

- [ ] **Step 6: Prove the guards bite** — each mutation, the exact failure text into the report, restore, re-run:
  - `chooseProfile`: delete the `unverified_profile` line → the `chooseProfile` unverified test fails.
  - `initialProfile`: make `pick` return `p ?? null` (ignore the predicate) → the single-unverified callback test fails.
  - `isChoosableProfile`: return `true` → the predicate's live × unverified case fails.

- [ ] **Step 7: Spec text.** In the #896 spec, replace "**One usable profile:** it is chosen." with "**One listed profile that is choosable** (`isChoosableProfile`: in live mode, one Mollie has verified): it is chosen." and in "**Several:**" make the kept previous profile conditional on being choosable; add one sentence after the bullets: "A listed profile that is not choosable is shown in the picker disabled, and `PUT …/processor/profile` refuses it with 409 `PROCESSOR_PROFILE_UNVERIFIED` (#908)." Replace, don't annotate.

- [ ] **Step 8: Commit** (exact paths; quote the bracketed route path):

```bash
git add src/lib/mollie/client.ts src/lib/mollie/client.test.ts src/services/processor-connection.ts src/services/processor-connection.test.ts src/lib/api-error-codes.ts 'src/app/api/teachers/[id]/processor/profile/route.ts' 'src/app/api/teachers/[id]/processor/profile/route.test.ts' docs/superpowers/specs/2026-10-18-mollie-connect-design.md
git commit -m "feat: only a verified Mollie profile can be chosen in live mode (#908)"
```

  Plus any fixture files Step 1 touched.

### Task 2: The picker shows website, disables unverified, and guides

Depends on Task 1 (`ProfileOption`).

**Files:**
- Modify: `src/components/settings/mollie-connection-section.tsx` (`ChangeProfileControl` ~205, `ProfilePicker` ~240)
- Test: `src/components/settings/mollie-connection-section.test.tsx`

- [ ] **Step 1: Failing component tests** (extend the file's `PROFILES` fixture to `ProfileOption` shape; add an unverified one):
  - An option with a website shows the website text under the name.
  - An unchoosable option's radio is `disabled` and is described by `Mollie hasn’t verified this profile yet.` (assert via `toHaveAccessibleDescription`).
  - Guidance (`/Mollie checks each profile by hand/`) and the `What Mollie checks` link (href to the help article) appear when any option is unchoosable, and are absent when all are choosable.
  - `choose_profile` with only an unverified profile: its radio disabled, `Use this profile` disabled.
  Run `pnpm exec vitest run src/components/settings/mollie-connection-section.test.tsx` — expect FAIL.

- [ ] **Step 2: Implement.** Props for `ProfilePicker` and `ChangeProfileControl` take `ProfileOption[]` (import the type from `@/services/processor-connection` as the file already imports `ConnectionView`). Each option:

```tsx
<label key={profile.id} className="flex items-center gap-3 min-h-12">
  <input
    type="radio"
    name={name}
    value={profile.id}
    checked={chosen === profile.id}
    disabled={!profile.choosable}
    aria-describedby={profile.choosable ? undefined : `${name}-${profile.id}-unverified`}
    onChange={() => setChosen(profile.id)}
    className="w-5 h-5 accent-teal"
  />
  <span className="flex flex-col">
    <span className="type-body">{profile.name}</span>
    {profile.website !== null && <span className="type-caption">{profile.website}</span>}
    {!profile.choosable && (
      <span id={`${name}-${profile.id}-unverified`} className="type-caption">Mollie hasn’t verified this profile yet.</span>
    )}
  </span>
</label>
```

  After the fieldset, when `profiles.some((p) => !p.choosable)`, render the guidance `<p className="type-caption">` with the exact copy from Global Constraints and the link. The autoFocus query must skip disabled radios: `input:checked` then `input:not(:disabled)`.

- [ ] **Step 3: Run** the component test file and `pnpm exec tsc --noEmit`. Expected: PASS.

- [ ] **Step 4: Prove it bites:** drop `disabled={!profile.choosable}` → the disabled-radio test fails; record the text; restore.

- [ ] **Step 5: Commit**

```bash
git add src/components/settings/mollie-connection-section.tsx src/components/settings/mollie-connection-section.test.tsx
git commit -m "feat: the Mollie profile picker shows websites and disables unverified profiles (#908)"
```
