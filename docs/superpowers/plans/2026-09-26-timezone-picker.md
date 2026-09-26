# Every IANA zone in the timezone picker — Implementation Plan (#258)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Settings → Profile timezone picker offers every IANA zone, never renders blank for a stored zone outside its list, and the database holds each zone under its current IANA spelling.

**Architecture:** A 19-pair rename map and `modernTimeZone` in the import-free `src/lib/iana-timezone.ts`; both write schemas pass the zone through it; a pure `timeZoneOptions(stored, now)` builds grouped options from `Intl.supportedValuesOf`, called by the server page and handed to the client form as a prop.

**Tech Stack:** Next.js 16 App Router, TypeScript strict, zod, Vitest (`unit`, `components`, `integration` projects), React Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-26-timezone-picker-design.md`

## Global Constraints

- `src/lib/iana-timezone.ts` stays import-free — it reaches every client bundle through `src/lib/schemas.ts`.
- `ProfileForm` (`'use client'`) never calls `Intl` to build the zone list; it renders what the server page passes.
- Comments annotate their own code only. Which 19 pairs, and the command that re-derives them, live in `docs/data-model.md`; no comment carries a count or a roster (CLAUDE.md, *Comment Discipline*).
- Tests assert refusal codes, never message text. `updateTeacherSchema`'s `'Unknown timezone'` refine message is not asserted anywhere.
- Integration tests in a worktree: `pnpm install --frozen-lockfile`, then `pnpm run worktree:setup` once, then `pnpm run worktree:up` before any `--project integration` run. Never touch the dev server on `:3000`.
- Stage exact paths; never `git add -A` / `git add .`.
- Every mutation step: break it, record the exact failing assertion text in the task report, restore, re-run green, and confirm `git status` shows only the intended files.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

1. **A stored zone `Intl` cannot resolve** (only by direct DB edit; #145's case) — the Settings page must still render, labelling the option with the raw identifier, not throw a `RangeError` into a 500. Pinned in Task 3.
2. **A stored valid alias that is neither listed nor renamed** (`CET`, `US/Eastern` — `isValidTimeZone` accepts both) — must appear as a standalone option and stay selected. Pinned in Task 3 (`CET`).
3. **Daylight saving** — the offset in a label is the offset at `now`; January and July differ for Amsterdam and Auckland. Pinned in Task 3.
4. **The form computing its own list** — would reintroduce the server/browser hydration mismatch. Pinned in Task 4 by rendering a one-option fixture and asserting exactly that option.
5. **Picking a new zone** — the PUT must carry the chosen value, not the initial one. Pinned in Task 4.

## Task order

1 → 2 → 3 → 4. Tasks 2 and 3 both consume Task 1's `modernTimeZone`; Task 4 consumes Task 3's types. Tasks 2 and 3 are otherwise independent.

---

### Task 1: `modernTimeZone` and its rename map

**Files:**
- Modify: `src/lib/iana-timezone.ts`
- Test: `src/lib/iana-timezone.test.ts`
- Modify: `docs/data-model.md` (the `default_timezone` row in `### Teacher (core)`, and a new bullet in `## Design Notes`)

**Interfaces:**
- Produces: `export const MODERN_ZONE_NAMES: ReadonlyMap<string, string>` and `export function modernTimeZone(tz: string): string` from `@/lib/iana-timezone`.

- [ ] **Step 1: Write the failing tests** — append to `src/lib/iana-timezone.test.ts`, and change its import line to `import { isValidTimeZone, modernTimeZone, MODERN_ZONE_NAMES } from './iana-timezone';`

```ts
const resolve = (tz: string): string =>
  new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone;

describe('modernTimeZone', () => {
  it('renames an old spelling to its current IANA name', () => {
    expect(modernTimeZone('Europe/Kiev')).toBe('Europe/Kyiv');
    expect(modernTimeZone('Asia/Calcutta')).toBe('Asia/Kolkata');
    expect(modernTimeZone('America/Buenos_Aires')).toBe('America/Argentina/Buenos_Aires');
  });

  it('returns every other zone unchanged, including valid aliases it does not rename', () => {
    for (const zone of ['Europe/Amsterdam', 'Europe/Kyiv', 'UTC', 'CET', 'US/Eastern', 'Not/AZone']) {
      expect(modernTimeZone(zone)).toBe(zone);
    }
  });

  /**
   * A rename, not a tzdata link: IANA links some zones to another country's
   * (Asmera → Nairobi), and following one would move a teacher across a
   * border. `Intl` resolving both sides to one zone is what a rename is.
   */
  it('pairs each old spelling with a name Intl treats as the same zone', () => {
    for (const [old, current] of MODERN_ZONE_NAMES) {
      expect(isValidTimeZone(current), current).toBe(true);
      expect(resolve(current), `${old} → ${current}`).toBe(resolve(old));
    }
  });

  it('never maps to a name it would rename again', () => {
    for (const current of MODERN_ZONE_NAMES.values()) {
      expect(MODERN_ZONE_NAMES.has(current), current).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run --project unit src/lib/iana-timezone.test.ts`
Expected: FAIL — `modernTimeZone` / `MODERN_ZONE_NAMES` are not exported.

- [ ] **Step 3: Implement** — append to `src/lib/iana-timezone.ts` (no imports):

```ts
/**
 * Current IANA spelling for each zone V8 still enumerates under a name IANA
 * has since changed. Keys are what `Intl.supportedValuesOf('timeZone')` and a
 * browser's `resolvedOptions().timeZone` may report; values are what the
 * database stores. Which pairs, and the command that re-derives them:
 * `docs/data-model.md`, Design Notes → "Teacher timezones are stored under
 * their current IANA name".
 */
export const MODERN_ZONE_NAMES: ReadonlyMap<string, string> = new Map([
  ['Africa/Asmera', 'Africa/Asmara'],
  ['America/Buenos_Aires', 'America/Argentina/Buenos_Aires'],
  ['America/Catamarca', 'America/Argentina/Catamarca'],
  ['America/Coral_Harbour', 'America/Atikokan'],
  ['America/Cordoba', 'America/Argentina/Cordoba'],
  ['America/Godthab', 'America/Nuuk'],
  ['America/Indianapolis', 'America/Indiana/Indianapolis'],
  ['America/Jujuy', 'America/Argentina/Jujuy'],
  ['America/Louisville', 'America/Kentucky/Louisville'],
  ['America/Mendoza', 'America/Argentina/Mendoza'],
  ['Asia/Calcutta', 'Asia/Kolkata'],
  ['Asia/Katmandu', 'Asia/Kathmandu'],
  ['Asia/Rangoon', 'Asia/Yangon'],
  ['Asia/Saigon', 'Asia/Ho_Chi_Minh'],
  ['Atlantic/Faeroe', 'Atlantic/Faroe'],
  ['Europe/Kiev', 'Europe/Kyiv'],
  ['Pacific/Enderbury', 'Pacific/Kanton'],
  ['Pacific/Ponape', 'Pacific/Pohnpei'],
  ['Pacific/Truk', 'Pacific/Chuuk'],
]);

/** `tz` under its current IANA name, or `tz` itself when it has no other. */
export function modernTimeZone(tz: string): string {
  return MODERN_ZONE_NAMES.get(tz) ?? tz;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec vitest run --project unit src/lib/iana-timezone.test.ts`
Expected: PASS.

- [ ] **Step 5: Document the pairs** in `docs/data-model.md`.

In `### Teacher (core)`, change the `default_timezone` row's Notes cell to:
`IANA identifier, e.g. 'Europe/Amsterdam', stored under its current IANA name — see Design Notes`

In `## Design Notes`, add a bullet:

```markdown
- **Teacher timezones are stored under their current IANA name** (#258). V8 enumerates CLDR's identifiers, which never change once published; IANA renames. So `Intl.supportedValuesOf('timeZone')` and a browser's detected zone can spell one zone two ways (`Europe/Kiev`, `Europe/Kyiv`). Both write paths — signup's detected zone and `PUT /api/teachers/[id]` — pass the value through `modernTimeZone` (`src/lib/iana-timezone.ts`), so the column and the Settings picker hold one spelling. The pairs are the renames, **not** tzdata's link targets: IANA also links a zone to another country's when their clocks have agreed since 1970, and following those would file Asmara under Nairobi, Pohnpei under Guadalcanal, Chuuk under Port Moresby and Atikokan under Panama. Measured 2026-09-26, Node v22.22.2 against tzdata `2026c`: V8's 418 zones and `zone.tab`'s 418 differ in 19 names each way, one-for-one, and those 19 are `MODERN_ZONE_NAMES`. Re-derive:

  ```sh
  node -e "
  const fs=require('fs');
  const tab=new Set(fs.readFileSync('/usr/share/zoneinfo/zone.tab','utf8').split('\n')
    .filter(l=>l&&!l.startsWith('#')).map(l=>l.split('\t')[2]));
  const v8=Intl.supportedValuesOf('timeZone');
  console.log(v8.filter(z=>!tab.has(z)));             // old spellings (the keys)
  console.log([...tab].filter(z=>!v8.includes(z)));   // current names (the values)
  "
  ```
```

- [ ] **Step 6: Mutation — break the pairing the realistic way.** Change `['Africa/Asmera', 'Africa/Asmara']` to `['Africa/Asmera', 'Africa/Nairobi']`. Run Step 4's command. Expected: FAIL in "pairs each old spelling…" naming `Africa/Asmera → Africa/Nairobi`. Record the text. Restore; re-run green.

- [ ] **Step 7: Mutation — drop a pair.** Delete the `Europe/Kiev` entry. Run Step 4's command. Expected: FAIL in "renames an old spelling…" (`expected 'Europe/Kiev' to be 'Europe/Kyiv'`). Record; restore; re-run green; `git status` shows only this task's files.

- [ ] **Step 8: Commit**

```bash
git add src/lib/iana-timezone.ts src/lib/iana-timezone.test.ts docs/data-model.md
git commit -m "feat(timezone): modernTimeZone renames V8's old zone spellings to IANA's (#258)"
```

---

### Task 2: Both write paths store the current spelling

**Files:**
- Modify: `src/lib/schemas.ts` (`detectedTimezoneField` and its preceding `// #258` comment; `updateTeacherSchema.defaultTimezone`)
- Test: `src/lib/schemas.test.ts` (the `describe('updateTeacherSchema.defaultTimezone'` block, plus a new `teacherProfileSchema` block beside it)
- Test: `tests/integration/teachers-api.test.ts` (`describe('PUT /api/teachers/[id]'`)
- Test: `tests/integration/teacher-signup-api.test.ts` (`describe('POST /api/account/teacher-profile — session mode'`)

**Interfaces:**
- Consumes: `modernTimeZone` from `@/lib/iana-timezone` (Task 1).
- Produces: nothing new — both schemas' parsed `defaultTimezone` is now the modern spelling.

- [ ] **Step 1: Write the failing unit tests.** In `src/lib/schemas.test.ts`, inside `describe('updateTeacherSchema.defaultTimezone'`, add:

```ts
  it('stores a renamed zone under its current IANA name', () => {
    const parsed = updateTeacherSchema.parse({ defaultTimezone: 'Europe/Kiev' });
    expect(parsed.defaultTimezone).toBe('Europe/Kyiv');
  });
```

And after that describe block, add (importing `teacherProfileSchema` in the existing import list if it is not already there):

```ts
describe('teacherProfileSchema.defaultTimezone', () => {
  const base = { firstName: 'A', lastName: 'B', bio: '', pageSlug: 'zone-test' };

  it('keeps a detected zone under its current IANA name', () => {
    expect(teacherProfileSchema.parse({ ...base, defaultTimezone: 'Asia/Calcutta' }).defaultTimezone)
      .toBe('Asia/Kolkata');
    expect(teacherProfileSchema.parse({ ...base, defaultTimezone: 'Pacific/Auckland' }).defaultTimezone)
      .toBe('Pacific/Auckland');
  });

  it('drops a detected zone the server cannot use, rather than refusing the signup', () => {
    expect(teacherProfileSchema.parse({ ...base, defaultTimezone: 'Not/AZone' }).defaultTimezone)
      .toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec vitest run --project unit src/lib/schemas.test.ts`
Expected: FAIL — `'Europe/Kiev'` / `'Asia/Calcutta'` come back unchanged. The `Not/AZone` test passes already (existing behaviour).

- [ ] **Step 3: Implement** in `src/lib/schemas.ts`. Change the import to `import { isValidTimeZone, modernTimeZone } from '@/lib/iana-timezone';`. Then:

```ts
const detectedTimezoneField = z
  .string()
  .transform((s) => (isValidTimeZone(s) ? modernTimeZone(s) : undefined));
```

```ts
  defaultTimezone: z.string().refine(isValidTimeZone, 'Unknown timezone').transform(modernTimeZone).optional(),
```

Append one sentence to the `// #258:` comment above `detectedTimezoneField`: `A zone it keeps is stored under its current IANA name (\`modernTimeZone\`), the same as a Settings save.`

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm exec vitest run --project unit src/lib/schemas.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the integration tests.** In `tests/integration/teachers-api.test.ts`, directly after `it('rejects a timezone Intl cannot resolve'`:

```ts
  it('stores a renamed zone under its current IANA name', async () => {
    const res = await putTeacher(teacherId, { defaultTimezone: 'Europe/Kiev' }, teacherToken);
    expect(res.status).toBe(200);

    const persisted = await prisma.teacher.findUniqueOrThrow({
      where: { id: teacherId },
      select: { defaultTimezone: true },
    });
    expect(persisted.defaultTimezone).toBe('Europe/Kyiv');
  });
```

In `tests/integration/teacher-signup-api.test.ts`, at the end of `describe('POST /api/account/teacher-profile — session mode'`. Self-contained, with guarded teardown — an unguarded `deleteMany` on an undefined id deletes every row:

```ts
  /**
   * Why the rename lives in the schema rather than the create: the unchanged
   * check compares the parsed request against the stored row. A resubmit
   * whose browser still reports the old spelling must compare equal to the
   * row the first submit created, not be refused as a different request.
   */
  it('stores a renamed zone under its current name, and a resubmit in the old spelling is unchanged', async () => {
    const email = `teacher-signup-tz-renamed-${suffix}@test.local`;
    const slug = `tz-renamed-${suffix}`;
    let accountId: string | undefined;
    try {
      const account = await prisma.account.create({ data: { email }, select: { id: true } });
      accountId = account.id;
      const token = await seedSession(prisma, accountId);
      const submit = (): Promise<Response> =>
        fetch(`${BASE_URL}/api/account/teacher-profile`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...cookie(token), ...freshIp() },
          body: JSON.stringify({
            firstName: 'Zone', lastName: 'Renamed', bio: '', pageSlug: slug,
            defaultTimezone: 'Europe/Kiev',
          }),
        });

      expect((await submit()).status).toBe(201);
      const teacher = await prisma.teacher.findUniqueOrThrow({
        where: { pageSlug: slug },
        select: { id: true, defaultTimezone: true },
      });
      expect(teacher.defaultTimezone).toBe('Europe/Kyiv');

      expect(await expectUnchanged(await submit())).toEqual({ teacherId: teacher.id });
    } finally {
      if (accountId) await prisma.session.deleteMany({ where: { accountId } });
      if (accountId) await prisma.teacher.deleteMany({ where: { accountId } });
      if (accountId) await prisma.account.deleteMany({ where: { id: accountId } });
    }
  });
```

- [ ] **Step 6: Run the integration tests**

Run: `pnpm exec vitest run --project integration tests/integration/teachers-api.test.ts tests/integration/teacher-signup-api.test.ts`
Expected: PASS.

- [ ] **Step 7: Mutation — drop the Settings transform.** Remove `.transform(modernTimeZone)` from `updateTeacherSchema`. Re-run Steps 4 and 6 (curl `/api/teachers/x` once first so the route is compiled). Expected: the unit test and the PUT integration test FAIL with `'Europe/Kiev'` stored. Record; restore; re-run green.

- [ ] **Step 8: Mutation — move the signup rename out of the schema into the create.** Revert `detectedTimezoneField` to `isValidTimeZone(s) ? s : undefined`, and in `src/app/api/account/teacher-profile/route.ts` change the create's fallback line to `defaultTimezone: modernTimeZone(auth.body.defaultTimezone ?? 'Europe/Amsterdam'),` (importing `modernTimeZone`). This is the realistic regression: the stored value is still right, and only the resubmit breaks. Re-run Step 6 (curl the route first). Expected: the signup test FAILS at `expectUnchanged` with an `ALREADY_TEACHER` refusal. Record; restore both files; re-run green; `git status` shows only this task's files.

- [ ] **Step 9: Commit**

```bash
git add src/lib/schemas.ts src/lib/schemas.test.ts tests/integration/teachers-api.test.ts tests/integration/teacher-signup-api.test.ts
git commit -m "feat(timezone): both write paths store a zone under its current IANA name (#258)"
```

---

### Task 3: `timeZoneOptions`

**Files:**
- Create: `src/lib/timezone-options.ts`
- Test: `src/lib/timezone-options.test.ts`

**Interfaces:**
- Consumes: `isValidTimeZone`, `modernTimeZone` from `@/lib/iana-timezone`.
- Produces, from `@/lib/timezone-options`:

```ts
export interface TimeZoneOption { value: string; label: string }
export interface TimeZoneGroup { region: string; options: TimeZoneOption[] }
export interface TimeZoneOptions { standalone: TimeZoneOption[]; groups: TimeZoneGroup[] }
export function timeZoneOptions(stored: string, now: Date): TimeZoneOptions
```

- [ ] **Step 1: Write the failing tests** — `src/lib/timezone-options.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { timeZoneOptions, type TimeZoneOptions } from './timezone-options';

const JANUARY = new Date('2026-01-15T12:00:00Z');
const JULY = new Date('2026-07-15T12:00:00Z');

const groupedValues = (o: TimeZoneOptions): string[] =>
  o.groups.flatMap((g) => g.options.map((opt) => opt.value));
const labelOf = (o: TimeZoneOptions, value: string): string | undefined =>
  [...o.standalone, ...o.groups.flatMap((g) => g.options)].find((opt) => opt.value === value)?.label;

describe('timeZoneOptions', () => {
  it('offers the zones the 26-item list could not', () => {
    const values = groupedValues(timeZoneOptions('Europe/Amsterdam', JANUARY));
    for (const zone of [
      'Pacific/Auckland', 'Asia/Tokyo', 'America/Sao_Paulo', 'Africa/Lagos', 'Asia/Kolkata', 'Asia/Dubai',
    ]) {
      expect(values, zone).toContain(zone);
    }
  });

  it('lists current IANA names, never the old spellings', () => {
    const values = groupedValues(timeZoneOptions('Europe/Amsterdam', JANUARY));
    expect(values).toContain('Europe/Kyiv');
    expect(values).not.toContain('Europe/Kiev');
    expect(values).not.toContain('Asia/Calcutta');
  });

  it('lists no zone twice', () => {
    const values = groupedValues(timeZoneOptions('Europe/Amsterdam', JANUARY));
    expect(new Set(values).size).toBe(values.length);
  });

  it('groups by region, regions and cities sorted', () => {
    const { groups } = timeZoneOptions('Europe/Amsterdam', JANUARY);
    const regions = groups.map((g) => g.region);
    expect(regions).toEqual([...regions].sort((a, b) => a.localeCompare(b, 'en')));
    for (const g of groups) {
      const labels = g.options.map((o) => o.label);
      expect(labels, g.region).toEqual([...labels].sort((a, b) => a.localeCompare(b, 'en')));
      for (const o of g.options) expect(o.value.startsWith(`${g.region}/`), o.value).toBe(true);
    }
  });

  it('labels a zone with its city and its offset at `now`', () => {
    const jan = timeZoneOptions('Europe/Amsterdam', JANUARY);
    const jul = timeZoneOptions('Europe/Amsterdam', JULY);
    expect(labelOf(jan, 'Pacific/Auckland')).toBe('Auckland (GMT+13)');
    expect(labelOf(jul, 'Pacific/Auckland')).toBe('Auckland (GMT+12)');
    expect(labelOf(jan, 'Europe/Amsterdam')).toBe('Amsterdam (GMT+1)');
    expect(labelOf(jul, 'Europe/Amsterdam')).toBe('Amsterdam (GMT+2)');
    expect(labelOf(jan, 'Asia/Kolkata')).toBe('Kolkata (GMT+5:30)');
    expect(labelOf(jan, 'America/Argentina/Buenos_Aires')).toBe('Argentina / Buenos Aires (GMT-3)');
  });

  it('adds no standalone option when the stored zone is listed', () => {
    expect(timeZoneOptions('Europe/Amsterdam', JANUARY).standalone).toEqual([]);
    expect(timeZoneOptions('Asia/Kolkata', JANUARY).standalone).toEqual([]);
  });

  it('offers a stored zone the list lacks, so the picker is never blank', () => {
    for (const stored of ['UTC', 'CET']) {
      const options = timeZoneOptions(stored, JANUARY);
      expect(options.standalone.map((o) => o.value), stored).toEqual([stored]);
      expect(groupedValues(options), stored).not.toContain(stored);
    }
  });

  it('still renders a stored zone Intl cannot resolve, labelled with its identifier', () => {
    expect(timeZoneOptions('Invalid/Test_Zone_145', JANUARY).standalone).toEqual([
      { value: 'Invalid/Test_Zone_145', label: 'Invalid/Test_Zone_145' },
    ]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run --project unit src/lib/timezone-options.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** `src/lib/timezone-options.ts`:

```ts
import { isValidTimeZone, modernTimeZone } from '@/lib/iana-timezone';

export interface TimeZoneOption { value: string; label: string }
export interface TimeZoneGroup { region: string; options: TimeZoneOption[] }

/**
 * The Settings timezone picker's contents. `standalone` renders before the
 * groups and holds anything that belongs to no region — above all the stored
 * zone when the list lacks it, so a controlled `<select>` never shows blank
 * and a first touch never replaces a correct zone.
 */
export interface TimeZoneOptions { standalone: TimeZoneOption[]; groups: TimeZoneGroup[] }

/** `GMT+13`, `GMT+5:30` — the zone's offset at `now`, so it tracks daylight saving. */
function offsetAt(zone: string, now: Date): string | undefined {
  return new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' })
    .formatToParts(now)
    .find((part) => part.type === 'timeZoneName')?.value;
}

function withOffset(name: string, zone: string, now: Date): string {
  const offset = offsetAt(zone, now);
  return offset ? `${name} (${offset})` : name;
}

/**
 * Every zone this runtime enumerates, under its current IANA name, grouped by
 * region. Call it on the server and pass the result to the client form: a
 * list computed during a client component's render would be Node's on the
 * server and the browser's on hydration.
 *
 * A stored zone `Intl` cannot resolve is still offered, under its bare
 * identifier — the page must render so the teacher can pick a real one.
 */
export function timeZoneOptions(stored: string, now: Date): TimeZoneOptions {
  const standalone: TimeZoneOption[] = [];
  const byRegion = new Map<string, TimeZoneOption[]>();
  const seen = new Set<string>();

  for (const zone of Intl.supportedValuesOf('timeZone').map(modernTimeZone)) {
    if (seen.has(zone)) continue;
    seen.add(zone);
    const slash = zone.indexOf('/');
    if (slash === -1) {
      standalone.push({ value: zone, label: withOffset(zone, zone, now) });
      continue;
    }
    const region = zone.slice(0, slash);
    const city = zone.slice(slash + 1).replaceAll('/', ' / ').replaceAll('_', ' ');
    const options = byRegion.get(region) ?? [];
    options.push({ value: zone, label: withOffset(city, zone, now) });
    byRegion.set(region, options);
  }

  if (!seen.has(stored)) {
    standalone.unshift({
      value: stored,
      label: isValidTimeZone(stored) ? withOffset(stored, stored, now) : stored,
    });
  }

  const byLabel = (a: TimeZoneOption, b: TimeZoneOption): number => a.label.localeCompare(b.label, 'en');
  const groups = [...byRegion.entries()]
    .sort(([a], [b]) => a.localeCompare(b, 'en'))
    .map(([region, options]) => ({ region, options: options.sort(byLabel) }));

  return { standalone, groups };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec vitest run --project unit src/lib/timezone-options.test.ts`
Expected: PASS. If a label assertion fails on the offset text, print the actual label and check it against `node -e "console.log(new Intl.DateTimeFormat('en-US',{timeZone:'Pacific/Auckland',timeZoneName:'shortOffset'}).format(new Date('2026-01-15T12:00:00Z')))"` before changing either side — report any change to the test's expectations.

- [ ] **Step 5: Mutation — drop the stored-zone fallback.** Delete the `if (!seen.has(stored))` block. Run Step 4's command. Expected: FAIL in "offers a stored zone the list lacks…" and "still renders a stored zone…". Record; restore; green.

- [ ] **Step 6: Mutation — skip the rename.** Change `.map(modernTimeZone)` to `.map((z) => z)`. Expected: FAIL in "lists current IANA names…" (`Europe/Kiev` present) and "offers the zones…" (`Asia/Kolkata` missing). Record; restore; green.

- [ ] **Step 7: Mutation — label an unresolvable stored zone with an offset.** Replace the `isValidTimeZone(stored) ? … : stored` ternary with `withOffset(stored, stored, now)`. Expected: "still renders a stored zone Intl cannot resolve…" FAILS with a thrown `RangeError`. Record; restore; green; `git status` shows only this task's files.

- [ ] **Step 8: Commit**

```bash
git add src/lib/timezone-options.ts src/lib/timezone-options.test.ts
git commit -m "feat(timezone): timeZoneOptions groups every IANA zone and keeps the stored one (#258)"
```

---

### Task 4: The Settings form renders the full list

**Files:**
- Modify: `src/components/settings/profile-form.tsx` (delete `TIMEZONE_OPTIONS`; new prop; render groups)
- Modify: `src/app/(teacher)/settings/profile/page.tsx`
- Test: `src/components/settings/profile-form.test.tsx`

**Interfaces:**
- Consumes: `timeZoneOptions` and `type TimeZoneOptions` from `@/lib/timezone-options` (Task 3).
- Produces: `ProfileFormProps` gains `timeZoneOptions: TimeZoneOptions`.

- [ ] **Step 1: Write the failing tests.** In `src/components/settings/profile-form.test.tsx`:

Add `import { timeZoneOptions, type TimeZoneOptions } from '@/lib/timezone-options';`, and change `renderForm` so every existing test gets the real list:

```ts
  const NOW = new Date('2026-01-15T12:00:00Z');

  function renderForm(
    overrides: Partial<typeof initial> = {},
    options?: TimeZoneOptions,
  ): void {
    const props = { ...initial, ...overrides };
    render(
      <ProfileForm
        teacherId="t-1"
        initial={props}
        timeZoneOptions={options ?? timeZoneOptions(props.defaultTimezone, NOW)}
      />,
    );
  }

  function timezoneSelect(): HTMLSelectElement {
    return screen.getByLabelText('Timezone') as HTMLSelectElement;
  }

  function sentBody(): Record<string, unknown> {
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    return JSON.parse(init.body as string) as Record<string, unknown>;
  }
```

Then add:

```ts
  it('shows a stored zone the list lacks as selected, and saves it untouched', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
    vi.stubGlobal('fetch', fetchMock);
    renderForm({ defaultTimezone: 'UTC' });

    expect(timezoneSelect().value).toBe('UTC');
    save();
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(sentBody().defaultTimezone).toBe('UTC');
  });

  it('offers zones outside Europe, North America and Australia, grouped by region', () => {
    renderForm();
    const select = timezoneSelect();
    expect(select.value).toBe('Europe/Amsterdam');
    expect(select.querySelector('optgroup[label="Pacific"] option[value="Pacific/Auckland"]')).not.toBeNull();
    expect(select.querySelector('optgroup[label="Asia"] option[value="Asia/Kolkata"]')).not.toBeNull();
  });

  it('sends the zone the teacher picks', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
    vi.stubGlobal('fetch', fetchMock);
    renderForm();
    fireEvent.change(timezoneSelect(), { target: { value: 'Pacific/Auckland' } });
    save();

    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(sentBody().defaultTimezone).toBe('Pacific/Auckland');
  });

  /** The list comes from the server page; the form builds none of its own. */
  it('renders exactly the options it is given', () => {
    renderForm({}, {
      standalone: [],
      groups: [{ region: 'Europe', options: [{ value: 'Europe/Amsterdam', label: 'Only option' }] }],
    });
    const options = timezoneSelect().querySelectorAll('option');
    expect([...options].map((o) => o.textContent)).toEqual(['Only option']);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec vitest run --project components src/components/settings/profile-form.test.tsx`
Expected: FAIL — `UTC` renders `''`, Auckland/Kolkata absent, "renders exactly…" sees 26 options. (TypeScript does not gate a vitest run, so the unknown prop does not stop it.)

- [ ] **Step 3: Implement** in `src/components/settings/profile-form.tsx`:

- Add `import type { TimeZoneOptions } from '@/lib/timezone-options';`.
- Add `timeZoneOptions: TimeZoneOptions;` to `ProfileFormProps`, and destructure it: `export function ProfileForm({ teacherId, initial, timeZoneOptions }: ProfileFormProps)`.
- Delete the `TIMEZONE_OPTIONS` constant.
- Replace the timezone `<Select>`'s children:

```tsx
        <Select
          id="timezone"
          label="Timezone"
          value={form.defaultTimezone}
          onChange={(e) => update('defaultTimezone', e.target.value)}
        >
          {timeZoneOptions.standalone.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
          {timeZoneOptions.groups.map((group) => (
            <optgroup key={group.region} label={group.region}>
              {group.options.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </optgroup>
          ))}
        </Select>
```

In `src/app/(teacher)/settings/profile/page.tsx`, add `import { timeZoneOptions } from '@/lib/timezone-options';` and pass the prop:

```tsx
      <ProfileForm
        teacherId={teacher.id}
        timeZoneOptions={timeZoneOptions(teacher.defaultTimezone, new Date())}
        initial={{
```

- [ ] **Step 4: Run to verify it passes, and typecheck**

Run: `pnpm exec vitest run --project components src/components/settings/profile-form.test.tsx && pnpm run typecheck && pnpm run lint`
Expected: PASS, no type or lint errors.

- [ ] **Step 5: Mutation — drop the standalone options from the render.** Delete the `timeZoneOptions.standalone.map(…)` block. Run Step 4's vitest command. Expected: "shows a stored zone the list lacks…" FAILS with `expected '' to be 'UTC'`. Record; restore; green; `git status` shows only this task's files.

- [ ] **Step 6: Drive the page.** With `pnpm run worktree:up` running, sign in as a seeded teacher (recipes in `.claude/skills/verify/`), open `/settings/profile`, and confirm: the Timezone select shows the stored zone; the list has region groups including Asia and Pacific; picking `Pacific/Auckland` and saving shows "Saved" and survives a reload. Check the browser console for hydration warnings — there must be none. Record what you saw.

- [ ] **Step 7: Commit**

```bash
git add src/components/settings/profile-form.tsx src/components/settings/profile-form.test.tsx 'src/app/(teacher)/settings/profile/page.tsx'
git commit -m "feat(settings): the timezone picker offers every IANA zone (#258)"
```

---

## After the tasks

- Whole-branch review (4 tasks), one fix wave, one scoped re-review.
- `pnpm run verify` green before pushing; cite its per-project arithmetic in the PR body.
- PR body: the premise table from spec §1; the 19-name measurement and the four link-target traps; each mutation's recorded failure text; **#145 is unaffected**; the integration files touched (`tests/integration/teachers-api.test.ts`, `tests/integration/teacher-signup-api.test.ts`).
