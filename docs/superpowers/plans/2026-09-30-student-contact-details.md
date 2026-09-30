# Student Contact Details Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A student can set, change and clear their phone, birthday and address on `/account`, and share each per teacher — birthday as two independent disclosures (day-and-month, and age), neither ever carrying the birth year to a teacher.

**Architecture:** A new pure module `src/lib/birthday.ts` owns every date rule (parse `YYYY-MM-DD` to a UTC-midnight `Date`, day-and-month, whole-year age). The wire schema uses it to turn today's 500 into a 400; the teacher projection uses it to replace `birthday: Date` with `{ day, month }` plus a separately gated `age`, so the year is absent from the teacher type itself. A new `StudentPrivacy.shareAge` column carries the second consent. The UI is a new `ContactDetailsForm` on `/account` and two changes to the privacy card.

**Tech Stack:** Next.js 16 App Router, TypeScript strict, Prisma 6 / PostgreSQL, Zod 4, Vitest (unit / components / integration projects), Playwright.

**Spec:** `docs/superpowers/specs/2026-09-30-student-contact-details-design.md`

## Global Constraints

- Node 24 is required (`.nvmrc`). In an agent shell that defaults to Node 22, run every `pnpm` command as `env PATH=/Users/ivohofland/.nvm/versions/node/v24.21.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin pnpm …` — one plain command per call; compound shell is refused in this worktree.
- Integration and e2e run against the worktree's own app (`pnpm run worktree:up`, port 3100); never touch `:3000`.
- `birthday` on the wire: `YYYY-MM-DD` only, a real calendar date, from `1900-01-01` to today (UTC) inclusive; stored as `new Date(Date.UTC(y, m - 1, d))`.
- `phone`: trimmed, max 40 characters. `address`: trimmed, max 300 characters, newlines allowed. For all three, `""` and `null` store `null`.
- A teacher-facing shape never carries the birth year. `birthday` there is `{ day: number; month: number } | null` gated on `shareBirthday`; `age` is `number | null` gated on `shareAge`. Independent.
- Age is whole years to today's **UTC** calendar date. A 29 February birthday turns over on 1 March in non-leap years.
- `shareAge` defaults to `false` everywhere a flag set is written, like every other `share*` flag.
- Copy, verbatim: toggle labels `Full last name` · `Email address` · `Phone number` · `Birthday (day and month)` · `Age` · `Address`. Empty-field caption `Not added yet — add it in Settings` ("add it in Settings" is the link to `/account`). Birthday hint `Share it per teacher under Privacy — as your birthday (day and month), your age, or both.` Save button `Save contact details`.
- *Comment Discipline* (CLAUDE.md): no counts or member rosters in comments; a comment annotates the code it sits on. Migration comments describe only their own SQL.
- Tests assert status codes, stored rows and field names — never a literal full error message.
- Stage exact paths; never `git add -A` / `git add .`. Quote paths containing parentheses.

## Review Focus

1. **An empty body still answers 400.** Transforms placed *outside* `.optional()` make Zod emit the key as `undefined` for an absent field, so `{}` would parse to three keys and slip past the route's `Object.keys(updateData).length === 0` check into a no-op 200. Pinned in Task 1.
2. **A half-typed birthday must not erase the stored one.** A browser `type="date"` with only some parts filled reports `value === ""` and `validity.badInput === true`; sending that `""` would clear the date. The form refuses to save instead. Pinned in Task 4.
3. **A whitespace-only phone or address stores `null`, not `" "`.** Trim before the empty check. Pinned in Task 1.
4. **A multi-line address reads as lines on the teacher page.** `<p>` collapses newlines; the teacher page renders it with `whitespace-pre-line`. Pinned in Task 2.
5. **A teacher shown only `age` sees it, not the empty state.** The "No contact information to show." branch must count `age`. Pinned in Task 2.

**Task order is load-bearing:** 1 → 2 → 3 → 4. Task 2's migration precedes Task 3's schema flag; Task 4's e2e drives the privacy toggles Task 3 adds and the wire rules Task 1 adds.

---

### Task 1: The birthday module and the wire schema

**Files:**
- Create: `src/lib/birthday.ts`
- Create: `src/lib/birthday.test.ts`
- Modify: `src/lib/schemas.ts` (`updateStudentSchema`, the `phone`/`birthday`/`address` lines)
- Modify: `src/lib/schemas.test.ts` (add a `describe` for the three fields)
- Test: `tests/integration/students-api.test.ts` (inside the existing `describe('PUT /api/students/[id]')` block)

**Interfaces:**
- Produces, from `src/lib/birthday.ts`:
  - `export const BIRTHDAY_MIN = '1900-01-01'`
  - `export type BirthdayParse = { ok: true; date: Date } | { ok: false; reason: 'format' | 'range' }`
  - `export function parseBirthday(s: string, now?: Date): BirthdayParse`
  - `export interface BirthdayDayMonth { day: number; month: number }` — `month` is 1–12
  - `export function dayMonthOf(birthday: Date): BirthdayDayMonth`
  - `export function ageOn(birthday: Date, now: Date): number`
- Produces: `updateStudentSchema`'s output type has `birthday?: Date | null`, `phone?: string | null`, `address?: string | null`. The route (`src/app/api/students/[id]/route.ts`) is **unchanged** — its spread writes the transformed values.

- [ ] **Step 1: Write the failing unit tests for `birthday.ts`**

```ts
// src/lib/birthday.test.ts
import { describe, it, expect } from 'vitest';
import { parseBirthday, dayMonthOf, ageOn } from './birthday';

const NOW = new Date('2026-09-30T12:00:00.000Z');

describe('parseBirthday', () => {
  it('builds UTC midnight from a date-only string', () => {
    const r = parseBirthday('1990-01-01', NOW);
    expect(r).toEqual({ ok: true, date: new Date('1990-01-01T00:00:00.000Z') });
  });

  it.each(['1990-1-1', '1990-01-01T00:00:00.000Z', '1990-01-01T00:00:00+02:00', 'not-a-date', ''])(
    'refuses %j as format',
    (s) => {
      expect(parseBirthday(s, NOW)).toEqual({ ok: false, reason: 'format' });
    },
  );

  it.each(['2023-02-30', '1990-13-01', '1990-00-10', '2023-02-29'])('refuses the non-date %j as format', (s) => {
    expect(parseBirthday(s, NOW)).toEqual({ ok: false, reason: 'format' });
  });

  it('accepts 29 February in a leap year', () => {
    expect(parseBirthday('2000-02-29', NOW).ok).toBe(true);
  });

  it('accepts today and the lower bound, refuses tomorrow and before 1900', () => {
    expect(parseBirthday('2026-09-30', NOW).ok).toBe(true);
    expect(parseBirthday('1900-01-01', NOW).ok).toBe(true);
    expect(parseBirthday('2026-10-01', NOW)).toEqual({ ok: false, reason: 'range' });
    expect(parseBirthday('1899-12-31', NOW)).toEqual({ ok: false, reason: 'range' });
  });
});

describe('dayMonthOf', () => {
  it('reads with UTC accessors, month 1-based', () => {
    expect(dayMonthOf(new Date('1992-06-15T00:00:00.000Z'))).toEqual({ day: 15, month: 6 });
  });
});

describe('ageOn', () => {
  const b = new Date('1990-04-17T00:00:00.000Z');
  it('is one less the day before the birthday', () => {
    expect(ageOn(b, new Date('2026-04-16T23:59:00.000Z'))).toBe(35);
  });
  it('turns over on the birthday itself', () => {
    expect(ageOn(b, new Date('2026-04-17T00:00:00.000Z'))).toBe(36);
  });
  it('turns a 29 February birthday over on 1 March in a non-leap year', () => {
    const leap = new Date('2000-02-29T00:00:00.000Z');
    expect(ageOn(leap, new Date('2026-02-28T12:00:00.000Z'))).toBe(25);
    expect(ageOn(leap, new Date('2026-03-01T00:00:00.000Z'))).toBe(26);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run --project unit src/lib/birthday.test.ts`
Expected: FAIL — `Failed to resolve import "./birthday"`.

- [ ] **Step 3: Implement `src/lib/birthday.ts`**

```ts
/**
 * Every rule about a student's birthday, which is a calendar date stored in a
 * `@db.Date` column. Postgres keeps only the UTC calendar date of whatever
 * instant it is handed, so every `Date` here is UTC midnight and every read
 * uses UTC accessors.
 */

export const BIRTHDAY_MIN = '1900-01-01';

export type BirthdayParse = { ok: true; date: Date } | { ok: false; reason: 'format' | 'range' };

export interface BirthdayDayMonth {
  day: number;
  /** 1–12. */
  month: number;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function utcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * `YYYY-MM-DD` only: an offset instant is refused rather than truncated,
 * because truncation to the UTC date is what shifts a local midnight east of
 * UTC onto the previous day.
 */
export function parseBirthday(s: string, now: Date = new Date()): BirthdayParse {
  const m = ISO_DATE.exec(s);
  if (!m) return { ok: false, reason: 'format' };
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  // Date.UTC rolls 30 February into March; a round-trip mismatch is a non-date.
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) {
    return { ok: false, reason: 'format' };
  }
  if (date < new Date(`${BIRTHDAY_MIN}T00:00:00.000Z`) || date > utcMidnight(now)) {
    return { ok: false, reason: 'range' };
  }
  return { ok: true, date };
}

export function dayMonthOf(birthday: Date): BirthdayDayMonth {
  return { day: birthday.getUTCDate(), month: birthday.getUTCMonth() + 1 };
}

/** Whole years on `now`'s UTC calendar date. */
export function ageOn(birthday: Date, now: Date): number {
  const years = now.getUTCFullYear() - birthday.getUTCFullYear();
  const beforeBirthday =
    now.getUTCMonth() < birthday.getUTCMonth() ||
    (now.getUTCMonth() === birthday.getUTCMonth() && now.getUTCDate() < birthday.getUTCDate());
  return beforeBirthday ? years - 1 : years;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec vitest run --project unit src/lib/birthday.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing schema unit tests**

Add to `src/lib/schemas.test.ts` (import `updateStudentSchema` if the file does not already):

```ts
describe('updateStudentSchema — contact fields (#714)', () => {
  it('omits absent keys, so an empty body stays empty', () => {
    const r = updateStudentSchema.safeParse({});
    expect(r.success).toBe(true);
    expect(Object.keys(r.success ? r.data : {})).toEqual([]);
  });

  it.each(['phone', 'address'] as const)('%s: trims, and stores "" / whitespace / null as null', (key) => {
    expect(updateStudentSchema.parse({ [key]: '  x  ' })[key]).toBe('x');
    expect(updateStudentSchema.parse({ [key]: '' })[key]).toBeNull();
    expect(updateStudentSchema.parse({ [key]: '   ' })[key]).toBeNull();
    expect(updateStudentSchema.parse({ [key]: null })[key]).toBeNull();
  });

  it('caps phone at 40 and address at 300', () => {
    expect(updateStudentSchema.safeParse({ phone: '1'.repeat(40) }).success).toBe(true);
    expect(updateStudentSchema.safeParse({ phone: '1'.repeat(41) }).success).toBe(false);
    expect(updateStudentSchema.safeParse({ address: 'a'.repeat(300) }).success).toBe(true);
    expect(updateStudentSchema.safeParse({ address: 'a'.repeat(301) }).success).toBe(false);
  });

  it('keeps newlines in an address', () => {
    expect(updateStudentSchema.parse({ address: 'Straat 1\n1011 AB Amsterdam' }).address)
      .toBe('Straat 1\n1011 AB Amsterdam');
  });

  it('birthday: date-only becomes UTC midnight; "" and null become null', () => {
    expect(updateStudentSchema.parse({ birthday: '1990-01-01' }).birthday)
      .toEqual(new Date('1990-01-01T00:00:00.000Z'));
    expect(updateStudentSchema.parse({ birthday: '' }).birthday).toBeNull();
    expect(updateStudentSchema.parse({ birthday: null }).birthday).toBeNull();
  });

  it.each(['not-a-date', '2023-02-30', '1990-01-01T00:00:00+02:00', '2999-01-01'])(
    'birthday: refuses %j with an issue on the birthday path',
    (birthday) => {
      const r = updateStudentSchema.safeParse({ birthday });
      expect(r.success).toBe(false);
      expect(r.success ? [] : r.error.issues.map((i) => i.path.join('.'))).toEqual(['birthday']);
    },
  );
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `pnpm exec vitest run --project unit src/lib/schemas.test.ts`
Expected: FAIL — `'   '` is kept, `''` is kept, `'1990-01-01'` stays a string, `'1'.repeat(41)` succeeds.

- [ ] **Step 7: Implement the schema**

In `src/lib/schemas.ts`, import `parseBirthday` from `@/lib/birthday` and replace the three lines of `updateStudentSchema`:

```ts
/**
 * Optional free text: trimmed, and "" stores null so a cleared input clears
 * the column. The transform sits inside `.optional()` so an absent key stays
 * absent — the route's empty-body check counts keys.
 */
function optionalText(max: number) {
  return z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();
}

const birthdayField = z
  .string()
  .transform((s, ctx) => {
    if (s === '') return null;
    const parsed = parseBirthday(s);
    if (parsed.ok) return parsed.date;
    ctx.addIssue({
      code: 'custom',
      message: parsed.reason === 'range'
        ? 'Birthday must be between 1900 and today'
        : 'Birthday must be a real date (YYYY-MM-DD)',
    });
    return z.NEVER;
  })
  .nullable()
  .optional();
```

and in the object:

```ts
  phone: optionalText(40),
  birthday: birthdayField,
  address: optionalText(300),
```

Delete the `// ISO date string` comment with the line it sat on.

- [ ] **Step 8: Run to verify it passes, then typecheck**

Run: `pnpm exec vitest run --project unit src/lib/schemas.test.ts src/lib/birthday.test.ts`
Expected: PASS.
Run: `pnpm run typecheck`
Expected: exit 0. If a form's `z.infer<typeof updateStudentSchema>` pin now complains, switch that pin to `z.input<typeof updateStudentSchema>` — the wire is the input side. Record which files needed it.

- [ ] **Step 9: Write the route integration tests**

In `tests/integration/students-api.test.ts`, inside `describe('PUT /api/students/[id]')`, after `'refuses a whitespace-only first name'`. They reuse that block's `alice`, `put` and `prisma`:

```ts
  describe('contact fields (#714)', () => {
    async function contactOf(id: string) {
      return prisma.student.findUniqueOrThrow({
        where: { id },
        select: { phone: true, birthday: true, address: true },
      });
    }

    it.each([
      ['phone', '+31 6 1234 5678', '+31 6 0000 0000'],
      ['address', 'Straat 1\n1011 AB Amsterdam', 'Plein 2'],
    ] as const)('%s: sets, changes, clears with null and with ""', async (key, first, second) => {
      expect((await put(alice.id, { [key]: first }, alice.token)).status).toBe(200);
      expect((await contactOf(alice.id))[key]).toBe(first);
      expect((await put(alice.id, { [key]: second }, alice.token)).status).toBe(200);
      expect((await contactOf(alice.id))[key]).toBe(second);
      expect((await put(alice.id, { [key]: null }, alice.token)).status).toBe(200);
      expect((await contactOf(alice.id))[key]).toBeNull();
      await put(alice.id, { [key]: first }, alice.token);
      expect((await put(alice.id, { [key]: '' }, alice.token)).status).toBe(200);
      expect((await contactOf(alice.id))[key]).toBeNull();
    });

    it('birthday: a date-only string round-trips without shifting a day', async () => {
      expect((await put(alice.id, { birthday: '1990-01-01' }, alice.token)).status).toBe(200);
      expect((await contactOf(alice.id)).birthday?.toISOString()).toBe('1990-01-01T00:00:00.000Z');
      expect((await put(alice.id, { birthday: '1990-12-31' }, alice.token)).status).toBe(200);
      expect((await contactOf(alice.id)).birthday?.toISOString()).toBe('1990-12-31T00:00:00.000Z');
    });

    it('birthday: clears with null and with ""', async () => {
      await put(alice.id, { birthday: '1990-01-01' }, alice.token);
      expect((await put(alice.id, { birthday: null }, alice.token)).status).toBe(200);
      expect((await contactOf(alice.id)).birthday).toBeNull();
      await put(alice.id, { birthday: '1990-01-01' }, alice.token);
      expect((await put(alice.id, { birthday: '' }, alice.token)).status).toBe(200);
      expect((await contactOf(alice.id)).birthday).toBeNull();
    });

    it.each([
      { birthday: 'not-a-date' },
      { birthday: '2023-02-30' },
      { birthday: '2999-01-01' },
      { birthday: '1990-01-01T00:00:00+02:00' },
      { phone: '1'.repeat(41) },
      { address: 'a'.repeat(301) },
    ])('refuses %j with a 400 naming the field, and writes nothing', async (body) => {
      await put(alice.id, { phone: 'keep', birthday: '1990-01-01', address: 'keep' }, alice.token);
      const before = await contactOf(alice.id);
      const res = await put(alice.id, body, alice.token);
      expect(res.status).toBe(400);
      const json = (await res.json()) as { error?: { message?: string } | string };
      const message = typeof json.error === 'string' ? json.error : json.error?.message;
      expect(message).toMatch(new RegExp(Object.keys(body)[0]!));
      expect(await contactOf(alice.id)).toEqual(before);
    });

    it('still refuses an empty body', async () => {
      expect((await put(alice.id, {}, alice.token)).status).toBe(400);
    });
  });
```

- [ ] **Step 10: Run the integration block**

Run: `pnpm exec vitest run --project integration tests/integration/students-api.test.ts`
Expected: PASS (the route needed no change). Step 11 is the red proof.

- [ ] **Step 11: Prove the guards bite (record the exact failures in the task report)**

Commit first (Step 12), then for each mutation: apply it, curl `PUT /api/students/<any>` once to warm the route, run the named test, record the failing assertion text, restore with `git checkout -- src/lib/schemas.ts src/lib/birthday.ts`, and confirm `git status --short` is clean.

1. Replace `birthday: birthdayField` with the original `birthday: z.string().nullable().optional()` → the date-only round-trip integration test goes red with a 500, the regression this issue measured.
2. In `parseBirthday`, delete the `|| date > utcMidnight(now)` half → the tomorrow unit case and the `2999-01-01` integration case go red.
3. Move `optionalText`'s `.transform` after `.optional()` → `'omits absent keys, so an empty body stays empty'` goes red, and `'still refuses an empty body'` goes red.
4. Remove `.trim()` from `optionalText` → the whitespace case goes red.

- [ ] **Step 12: Commit**

```bash
git add src/lib/birthday.ts src/lib/birthday.test.ts src/lib/schemas.ts src/lib/schemas.test.ts tests/integration/students-api.test.ts
git commit -m "feat: validate student phone, birthday and address on the wire (#714)"
```

(Plus any form file whose pin moved to `z.input` in Step 8.)

---

### Task 2: `shareAge`, the year-free projection, and the teacher page

**Files:**
- Modify: `prisma/schema.prisma` (`StudentPrivacy`: add `shareAge Boolean @default(false)` after `shareBirthday`)
- Create: `prisma/migrations/20260930120000_student_privacy_share_age/migration.sql`
- Modify: `src/lib/student-visibility.ts` (`VisibilityFlags`, `StudentProjectionInput` unchanged, `TeacherVisibleStudent`, `_projectionCarriesNoRawIdentity`, `projectStudentForTeacher`, `studentVisibilitySelect`)
- Modify: `src/lib/student-visibility.test.ts`
- Modify: `src/lib/format.ts` (add `formatDayMonth`)
- Modify: `src/app/(teacher)/students/[id]/page.tsx` (contact section)
- Modify: `src/app/api/students/[id]/privacy/route.ts` (GET default body)
- Modify: `src/services/invitations.ts` (`SILENCED_PRIVACY`)
- Modify: `src/services/gdpr.ts` (export's `privacySettings` mapping)
- Modify: `docs/data-model.md` (StudentPrivacy table; `birthday` row note)
- Test: `tests/integration/student-detail-page.test.ts`, `tests/integration/students-api.test.ts` (teacher GET)

**Interfaces:**
- Consumes: `dayMonthOf`, `ageOn`, `BirthdayDayMonth` from `src/lib/birthday.ts` (Task 1).
- Produces:
  - `TeacherVisibleStudent.birthday: BirthdayDayMonth | null` and `TeacherVisibleStudent.age: number | null`
  - `projectStudentForTeacher(student: StudentProjectionInput, teacherId: string, now?: Date): TeacherVisibleStudent`
  - `formatDayMonth(value: BirthdayDayMonth): string` in `src/lib/format.ts`, producing the same text as `formatDateShort` (e.g. `15 Jun`)
  - Column `StudentPrivacy.shareAge` (Task 3 adds it to `updatePrivacySchema`)

- [ ] **Step 1: Schema and migration**

Add the column in `prisma/schema.prisma`. `migrate dev` refuses a non-interactive shell, so generate the SQL:

Run: `pnpm exec prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script`
Expected output: one `ALTER TABLE "StudentPrivacy" ADD COLUMN "shareAge" BOOLEAN NOT NULL DEFAULT false;`

Write it to `prisma/migrations/20260930120000_student_privacy_share_age/migration.sql`, no comments beyond what describes that SQL. Apply and regenerate:

Run: `pnpm exec prisma migrate deploy`
Run: `pnpm exec prisma generate`
Run: `pnpm exec prisma migrate status`
Expected: "Database schema is up to date!"

The worktree's dev server holds a Prisma client generated before the column existed. After `prisma generate`, check `curl -s localhost:3100/api/health` still answers; if integration tests later report an unknown `shareAge` field, restart only the **worktree** server (`pnpm run worktree:down`, then `pnpm run worktree:up`) — never `:3000`.

- [ ] **Step 2: Run typecheck to see the flag tether fire**

Run: `pnpm run typecheck`
Expected: FAIL at `_visibilityFlagsAreExhaustive` in `src/lib/student-visibility.ts` — `shareAge` is an unclassified `StudentPrivacy` column. Record the error text in the task report; that is the tether working.

- [ ] **Step 3: Write the failing projection tests**

In `src/lib/student-visibility.test.ts`: add `shareAge: false` to `ALL_FALSE` and `shareAge: true` to `ALL_TRUE_FOR_OTHER`. Replace the `shareBirthday` assertion inside `'gates each field on its own flag'` (currently `.toEqual(BIRTHDAY)`) with `.toEqual({ day: 17, month: 4 })`. Add wherever the file asserts every field null under `ALL_FALSE`: `expect(result.age).toBeNull();`. Then add:

```ts
describe('projectStudentForTeacher — birthday and age (#714)', () => {
  const NOW = new Date('2026-09-30T12:00:00.000Z'); // BIRTHDAY is 1990-04-17 → 36
  const flags = (shareBirthday: boolean, shareAge: boolean) =>
    claimedStudent({ studentPrivacy: [{ ...ALL_FALSE, shareBirthday, shareAge }] });

  it.each([
    [false, false, null, null],
    [true, false, { day: 17, month: 4 }, null],
    [false, true, null, 36],
    [true, true, { day: 17, month: 4 }, 36],
  ] as const)('shareBirthday=%s shareAge=%s', (b, a, birthday, age) => {
    const r = projectStudentForTeacher(flags(b, a), TEACHER, NOW);
    expect(r.birthday).toEqual(birthday);
    expect(r.age).toBe(age);
  });

  it('never carries the birth year, with everything shared', () => {
    const r = projectStudentForTeacher(flags(true, true), TEACHER, NOW);
    expect(JSON.stringify(r)).not.toContain('1990');
  });

  it('is null for both when the birthday column is null, whatever the flags', () => {
    const r = projectStudentForTeacher(
      claimedStudent({ birthday: null, studentPrivacy: [{ ...ALL_FALSE, shareBirthday: true, shareAge: true }] }),
      TEACHER,
      NOW,
    );
    expect(r.birthday).toBeNull();
    expect(r.age).toBeNull();
  });
});
```

- [ ] **Step 4: Implement the projection**

In `src/lib/student-visibility.ts`:
- `VisibilityFlags` adds `'shareAge'` to its `Pick`.
- `TeacherVisibleStudent`: `birthday: BirthdayDayMonth | null;` and add `age: number | null;` (import the type from `@/lib/birthday`).
- `_projectionCarriesNoRawIdentity`: add `'age'` to the allowlist union. In its docblock, "The projection carries these seven keys and nothing else" becomes "The projection carries these keys and nothing else" — the number is a prose count this change falsifies (*Comment Discipline*).
- `projectStudentForTeacher` gains `now: Date = new Date()` and returns:

```ts
    birthday:
      (flags?.shareBirthday ?? false) && student.birthday ? dayMonthOf(student.birthday) : null,
    age: (flags?.shareAge ?? false) && student.birthday ? ageOn(student.birthday, now) : null,
```

- `studentVisibilitySelect`'s nested `select` adds `shareAge: true`.

- [ ] **Step 5: Run unit tests and typecheck**

Run: `pnpm exec vitest run --project unit src/lib/student-visibility.test.ts`
Expected: PASS.
Run: `pnpm run typecheck`
Expected: FAIL only at `src/app/(teacher)/students/[id]/page.tsx` (`formatDateShort` given a `BirthdayDayMonth`) and at any other consumer the compiler names. Record the list. Fix each by Step 6–7, not by casting.

- [ ] **Step 6: `formatDayMonth` and the teacher page**

In `src/lib/format.ts`, beside `formatDateShort`:

```ts
/** `15 Jun` from a day and 1-based month — a birthday, which has no year to show. */
export function formatDayMonth({ day, month }: BirthdayDayMonth): string {
  return `${day} ${MONTHS[month - 1]}`;
}
```

In `src/app/(teacher)/students/[id]/page.tsx`'s contact section:
- The birthday row renders `formatDayMonth(visible.birthday)`. Replace the JSX comment above it with one line: the year is absent from `TeacherVisibleStudent` itself (`src/lib/student-visibility.ts`), so no formatter here can show it.
- After it, an Age row, only when `visible.age !== null` (not truthiness — a shared age of `0` is a value):

```tsx
          {visible.age !== null && (
            <div>
              <span className="type-label">Age</span>
              <p className="text-base text-ink type-number">{visible.age}</p>
            </div>
          )}
```

- The address `<p>` gains `whitespace-pre-line`.
- The empty-state condition adds `&& visible.age === null`. Its JSX comment above stays true; leave it.
- Drop the `formatDateShort` import if nothing else on the page uses it.

- [ ] **Step 7: The other flag writers**

Each full flag set adds `shareAge`:
- `src/app/api/students/[id]/privacy/route.ts` GET default: `shareAge: false,` after `shareBirthday`.
- `src/services/invitations.ts` `SILENCED_PRIVACY`: `shareAge: false,`.
- `src/services/gdpr.ts` export `privacySettings`: `shareAge: p.shareAge,`.

Then re-derive the census: `grep -rn "shareBirthday" src --include='*.ts' --include='*.tsx' | grep -v '\.test\.'` and `grep -rn "shareAge" src --include='*.ts' --include='*.tsx' | grep -v '\.test\.'`. Every `shareBirthday` hit either has a `shareAge` sibling or belongs to Task 3 (`schemas.ts` `updatePrivacySchema`, `services/student-privacy.ts`, `account/privacy/page.tsx`, `teacher-privacy-card.tsx`). List each hit with its verdict in the task report.

Run: `pnpm run typecheck`
Expected: exit 0.

- [ ] **Step 8: Integration tests — teacher page and teacher GET**

In `tests/integration/student-detail-page.test.ts`:
- The existing selective test's `studentPrivacy.create` stays as is (no `shareAge` → default false). Add after its birthday assertions: `expect(html).not.toContain('>Age</span>');`.
- Add a test: student with `birthday: new Date('1992-06-15T00:00:00.000Z')`, `address: 'Straat 1\n1011 AB Amsterdam'`, privacy `{ shareAge: true, shareAddress: true }` and every other flag false. Assert the HTML contains `>Age</span>`, the age computed with `ageOn(birthday, new Date())` (import from `@/lib/birthday`), `whitespace-pre-line`, does **not** contain `15 Jun` or `1992`, and does **not** contain `No contact information to show.`
- Add a test: only `shareAge: true`, `phone`/`address` null → contains `>Age</span>` and not `No contact information to show.`

In `tests/integration/students-api.test.ts`, in `describe('GET /api/students/[id] — profile-presence authorization')` (or a new sibling block with its own linked teacher/student fixtures if that block's fixtures do not fit): a linked teacher's `GET /api/students/<id>` for a student with `birthday: 1988-03-14` sharing `shareBirthday` and `shareAge` returns `data.birthday` equal to `{ day: 14, month: 3 }`, a numeric `data.age`, and a response text not containing `1988`.

Run: `pnpm exec vitest run --project integration tests/integration/student-detail-page.test.ts tests/integration/students-api.test.ts`
Expected: PASS.

- [ ] **Step 9: Docs**

`docs/data-model.md`: in the StudentPrivacy table add `| share_age | boolean, default false | |` after `share_birthday`; the `birthday` row's note reads `Year collected for the age; never shown to a teacher — the projection returns day and month and, separately, the age`.

- [ ] **Step 10: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260930120000_student_privacy_share_age/migration.sql src/lib/student-visibility.ts src/lib/student-visibility.test.ts src/lib/format.ts "src/app/(teacher)/students/[id]/page.tsx" "src/app/api/students/[id]/privacy/route.ts" src/services/invitations.ts src/services/gdpr.ts docs/data-model.md tests/integration/student-detail-page.test.ts tests/integration/students-api.test.ts
git commit -m "feat: split a shared birthday into day-month and age, never the year (#714)"
```

- [ ] **Step 11: Prove the guards bite**

After committing, for each: apply, warm `/students/<id>`, run the named test, record the failure, restore with `git checkout -- <file>`, confirm `git status --short` clean.

1. Return `student.birthday` unprojected for `birthday` (cast to satisfy the type) → the no-year unit test and the teacher GET test go red.
2. Gate `age` on `flags?.shareBirthday` → the four-combination test goes red on two rows.
3. Remove `'shareAge'` from `VisibilityFlags` → `tsc` fails at `_visibilityFlagsAreExhaustive` (already seen in Step 2; confirm it still fires).
4. Remove `&& visible.age === null` from the empty state → the age-only page test goes red.

---

### Task 3: Privacy card — the Age toggle and the empty-field hint

**Files:**
- Modify: `src/lib/schemas.ts` (`updatePrivacySchema`: `shareAge: z.boolean().optional()`)
- Modify: `src/services/student-privacy.ts` (the upsert's `create`: `shareAge: input.fields.shareAge ?? false`)
- Modify: `src/components/student/teacher-privacy-card.tsx`
- Modify: `src/components/student/teacher-privacy-card.test.tsx`
- Modify: `src/app/(student)/account/privacy/page.tsx`
- Modify: `docs/product-concept.md` (visibility table)
- Test: `tests/integration/privacy-page.test.ts`

**Interfaces:**
- Consumes: `StudentPrivacy.shareAge` (Task 2).
- Produces:
  - `TeacherPrivacyValues.shareAge: boolean`
  - `export interface FilledFields { phone: boolean; birthday: boolean; address: boolean }` exported from `teacher-privacy-card.tsx`
  - `TeacherPrivacyCardProps.filled: FilledFields`

- [ ] **Step 1: Write the failing component tests**

In `src/components/student/teacher-privacy-card.test.tsx`, update the existing render helper's props with `filled={{ phone: true, birthday: true, address: true }}` and `shareAge: false` in its `initial`, then add:

```tsx
describe('TeacherPrivacyCard — age and empty fields (#714)', () => {
  it('labels the two birthday disclosures separately', () => {
    renderCard();
    expect(screen.getByRole('checkbox', { name: 'Birthday (day and month)' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Age' })).toBeInTheDocument();
  });

  it('sends shareAge when the Age toggle changes', async () => {
    stubFetch();
    renderCard();
    fireEvent.click(screen.getByLabelText('Age'));
    const { body } = await save();
    expect(body.shareAge).toBe(true);
    expect(body.shareBirthday).toBe(false);
  });

  it('captions a toggle whose field is empty, linking to /account', () => {
    renderCard({ filled: { phone: false, birthday: false, address: true } });
    const links = screen.getAllByRole('link', { name: 'add it in Settings' });
    // phone, birthday, age
    expect(links).toHaveLength(3);
    links.forEach((l) => expect(l).toHaveAttribute('href', '/account'));
  });

  it('shows no caption when every field is filled, and never disables a toggle', () => {
    renderCard({ filled: { phone: false, birthday: true, address: true } });
    expect(screen.getAllByRole('link', { name: 'add it in Settings' })).toHaveLength(1);
    expect(screen.getByRole('checkbox', { name: 'Phone number' })).toBeEnabled();
  });
});
```

The file's `stubFetch`, `save` and `initial` already exist at the top of its `describe`. `renderCard` exists in a nested block; if the new `describe` cannot reach it, lift it to file scope with an optional `{ filled?: FilledFields; initial?: TeacherPrivacyValues }` override, defaulting `filled` to all true. Every existing body assertion that lists the sent keys gains `shareAge`. The file's top docblock says "all seven keys, teacherId plus the six privacy fields" — a prose count this change falsifies; rewrite it without numbers ("every key: teacherId plus each privacy field") per *Comment Discipline*.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run --project components src/components/student/teacher-privacy-card.test.tsx`
Expected: FAIL — no `Age` checkbox, no `filled` prop.

- [ ] **Step 3: Implement**

- `updatePrivacySchema` adds `shareAge: z.boolean().optional()`. The card's two pins (`_formCoversUpdate`, `_formHasNoExtras`) now fail typecheck until `TeacherPrivacyValues` gains `shareAge: boolean` — that is the tether.
- `services/student-privacy.ts` create half: `shareAge: input.fields.shareAge ?? false,`.
- The card:

```tsx
export interface FilledFields {
  phone: boolean;
  birthday: boolean;
  address: boolean;
}

const SHARE_FIELDS: Array<{
  key: keyof TeacherPrivacyValues;
  label: string;
  /** The student's field this toggle discloses, when it can be empty. */
  field?: keyof FilledFields;
}> = [
  { key: 'shareFullName', label: 'Full last name' },
  { key: 'shareEmail', label: 'Email address' },
  { key: 'sharePhone', label: 'Phone number', field: 'phone' },
  { key: 'shareBirthday', label: 'Birthday (day and month)', field: 'birthday' },
  { key: 'shareAge', label: 'Age', field: 'birthday' },
  { key: 'shareAddress', label: 'Address', field: 'address' },
];
```

  In the map, under a toggle whose `field` is set and `!filled[field.field]`, render (inside the same list item, below the `<label>`, indented to align with the label text):

```tsx
<p className="type-caption text-brown-light pl-8">
  Not added yet — <Link href="/account">add it in Settings</Link>
</p>
```

  The link sits outside the `<label>` so clicking it does not toggle the checkbox. Add `filled: FilledFields` to the props with a one-line docblock: presence only, never the values.

- `account/privacy/page.tsx`: `MAX_PRIVACY` and the row mapping add `shareAge`. Query the student's presence once, alongside the existing `Promise.all`:

```ts
    prisma.student.findUniqueOrThrow({
      where: { id: session.studentId },
      select: { phone: true, birthday: true, address: true },
    }),
```

  and pass `filled={{ phone: contact.phone !== null, birthday: contact.birthday !== null, address: contact.address !== null }}` to every card.

- `docs/product-concept.md` visibility table: `| Birthday (optional) | … |` becomes `| Birthday — day and month (optional) | Per-teacher opt-in by student |`, and add `| Age (optional) | Per-teacher opt-in by student, separate from the birthday; the birth year itself is never shown |`.

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm exec vitest run --project components src/components/student/teacher-privacy-card.test.tsx`
Expected: PASS.
Run: `pnpm run typecheck`
Expected: exit 0.

- [ ] **Step 5: Integration — the privacy page**

In `tests/integration/privacy-page.test.ts`, add: a student linked to exactly one teacher, with `phone: null`, `birthday` set, `address: null` renders the caption text `Not added yet` exactly twice (phone and address). And: `PUT /api/students/<id>/privacy` with `{ teacherId, shareAge: true }` on a student with no existing row creates it with `shareAge: true` and every other `share*` false (read the row back).

Run: `pnpm exec vitest run --project integration tests/integration/privacy-page.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/schemas.ts src/services/student-privacy.ts src/components/student/teacher-privacy-card.tsx src/components/student/teacher-privacy-card.test.tsx "src/app/(student)/account/privacy/page.tsx" docs/product-concept.md tests/integration/privacy-page.test.ts
git commit -m "feat: an Age share toggle, and a hint on toggles over an empty field (#714)"
```

- [ ] **Step 7: Prove the guards bite**

Apply, run, record, restore, confirm clean:
1. In `services/student-privacy.ts` drop the `shareAge` line from `create` → the privacy-route integration test goes red (`shareAge` false).
2. Render the caption regardless of `filled` → the "no caption when filled" test goes red.

---

### Task 4: The contact details form on `/account`, and the end-to-end journey

**Files:**
- Modify: `src/components/ui/input.tsx` (optional `hint`)
- Modify: `src/components/ui/textarea.tsx` (`aria-invalid`, `aria-describedby`, `role="alert"` error id, optional `hint` — matching `Input`)
- Create: `src/components/student/contact-details-form.tsx`
- Create: `src/components/student/contact-details-form.test.tsx`
- Modify: `src/app/(student)/account/page.tsx`
- Modify: `docs/form-validation-accessibility.md` (census row)
- Test: `tests/e2e/account.spec.ts`

**Interfaces:**
- Consumes: `updateStudentSchema` wire rules (Task 1); `BIRTHDAY_MIN` from `src/lib/birthday.ts`; the Age toggle (Task 3) in the e2e.
- Produces: `ContactDetailsForm` with props `{ studentId: string; initialPhone: string; initialBirthday: string; initialAddress: string }` — every initial value a string, `''` for null; `initialBirthday` is `YYYY-MM-DD`.

- [ ] **Step 1: `hint` on `Input` and `Textarea`**

Both components gain `hint?: string`, rendered as `<span id={`${id}-hint`} className="type-caption text-brown-light">` between the label and the field, and `aria-describedby` becomes the space-joined ids of hint and error that exist (undefined when neither). `Textarea` also gains `aria-invalid`, the error's `id` and `role="alert"`, matching `Input`.

Add a component test beside whichever of the two already has one (otherwise in `contact-details-form.test.tsx`): with `hint` and `error` both set, the field's `aria-describedby` names both ids and each id exists in the document.

- [ ] **Step 2: Write the failing form tests**

`src/components/student/contact-details-form.test.tsx`, modelled on `name-form.test.tsx` (same `stubFetch`, same `routerRefresh` import):

- Renders the initial values in fields labelled `Phone`, `Birthday`, `Address`; the address is a `textbox` that is a `TEXTAREA`.
- Saving sends `PUT /api/students/student-1` with body exactly `{ phone, birthday, address }`, phone and address trimmed, a cleared field sent as `''`.
- A 400 whose message is `birthday: Birthday must be a real date (YYYY-MM-DD)` renders `Birthday must be a real date (YYYY-MM-DD)` against the Birthday field (its `aria-invalid` is `true`), not as a banner.
- A 400 with a message not prefixed by one of the three field names renders in the form-level `role="alert"` banner.
- Editing a field clears its error and the `Saved` notice.
- **Review Focus 2:** with the birthday input's `validity.badInput` forced true (`Object.defineProperty(input, 'validity', { value: { badInput: true } })`), clicking save does **not** call fetch and shows `Enter a full date, or clear the field` against Birthday.
- The Birthday field's `aria-describedby` includes the hint's id, and the hint text is the Global Constraints copy.
- `fetch` rejecting shows `Network error. Try again.`

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm exec vitest run --project components src/components/student/contact-details-form.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `ContactDetailsForm`**

Follow `name-form.tsx`'s structure exactly: the narrowly wrapped `fetch` with `logRequestFailure('contact-details-form', {}, err)`, `readErrorMessage`, `router.refresh()` in its own try, `saving`/`saved`/`error` state. Differences:

- Types and pin:

```ts
type UpdateStudentWire = z.input<typeof updateStudentSchema>;

interface ContactBody {
  phone: string;
  birthday: string;
  address: string;
}

/** Reverse pin only, as `name-form.tsx`: a key the `.strict()` schema dropped would 400. */
const _formHasNoExtras: NoneOf<Exclude<keyof ContactBody, keyof UpdateStudentWire>> = true;
void _formHasNoExtras;
```

- Per-field errors: `fieldErrors: Partial<Record<keyof ContactBody, string>>`. On a 400, split the message at the first `': '`; when the part before it is `phone`, `birthday` or `address`, set that field's error to the part after; otherwise set the banner `error`.
- Before sending, read the birthday element from the submitted form — no ref, so `Input` changes only by `hint`:

```ts
    const birthdayInput = e.currentTarget.elements.namedItem('birthday');
    if (birthdayInput instanceof HTMLInputElement && birthdayInput.validity.badInput) {
      setFieldErrors({ birthday: 'Enter a full date, or clear the field' });
      return;
    }
```
- Fields: `<Input label="Phone" id="phone" name="phone" type="tel" autoComplete="tel" />`, `<Input label="Birthday" id="birthday" name="birthday" type="date" min={BIRTHDAY_MIN} max={todayUtcIso} hint="Share it per teacher under Privacy — as your birthday (day and month), your age, or both." />` where `todayUtcIso = new Date().toISOString().slice(0, 10)` (the server bound is UTC too), `<Textarea label="Address" id="address" name="address" autoComplete="street-address" rows={3} />`.
- Every `onChange` clears that field's error, the banner, and `saved`.
- Button `Save contact details` (`Saving...` while saving); `Saved` caption as `NameForm`.
- On success, set each field to its trimmed value.

- [ ] **Step 5: Run the form tests**

Run: `pnpm exec vitest run --project components src/components/student/contact-details-form.test.tsx`
Expected: PASS.

- [ ] **Step 6: Mount it on `/account`**

`src/app/(student)/account/page.tsx`: the student `select` adds `phone: true, birthday: true, address: true`. Under `NameForm`, inside the same "Personal details" section, add a `mt-8` wrapper holding:

```tsx
        <ContactDetailsForm
          studentId={student.id}
          initialPhone={student.phone ?? ''}
          initialBirthday={student.birthday ? student.birthday.toISOString().slice(0, 10) : ''}
          initialAddress={student.address ?? ''}
        />
```

`toISOString()` is UTC, so a `@db.Date` value prefills as the stored date on any host timezone.

- [ ] **Step 7: Census row**

`docs/form-validation-accessibility.md`, Form Validation Census, add:

`| **Student Contact Details** | \`src/components/student/contact-details-form.tsx\` | Client badInput check & per-field API errors | \`<Input error={...} />\` / \`<Textarea error={...} />\` + \`<p role="alert">\` banner | each \`onChange\` clearing its \`fieldErrors[key]\`, \`error\` and \`saved\` |`

- [ ] **Step 8: e2e**

In `tests/e2e/account.spec.ts`, using the file's existing student session setup and `tests/e2e/page-helpers.ts`: a student linked to a teacher (seed the `TeacherStudent` link and the teacher session in the test's setup, following how the file seeds its student) opens `/account`, fills Phone `+31 6 1234 5678`, Birthday `1990-04-17`, Address `Straat 1` / newline / `1011 AB Amsterdam`, saves, sees `Saved`; reloads (`reloadHydrated`) and sees the three values prefilled; goes to Privacy, turns on **Phone number** only for that teacher and waits for the save. As the teacher, `/students/<id>` shows `+31 6 1234 5678` and does not show `17 Apr`, `Age` or `Amsterdam`. Then clear Phone on `/account`, save, and the teacher page shows `No contact information to show.`

Run: `pnpm exec playwright test tests/e2e/account.spec.ts`
Expected: PASS.

- [ ] **Step 9: Full verification**

Run: `pnpm run verify`
Expected: exit 0 — record the per-project test file counts from its output for the PR body.
Run: `pnpm run build`
Expected: exit 0 (catches a `server-only` leak `verify` cannot).

- [ ] **Step 10: Commit**

```bash
git add src/components/ui/input.tsx src/components/ui/textarea.tsx src/components/student/contact-details-form.tsx src/components/student/contact-details-form.test.tsx "src/app/(student)/account/page.tsx" docs/form-validation-accessibility.md tests/e2e/account.spec.ts
git commit -m "feat: students enter phone, birthday and address on their account page (#714)"
```

(Plus the `Input`/`Textarea` test file if Step 1 put one there.)

- [ ] **Step 11: Prove the guards bite**

Apply, run, record, restore, confirm clean:
1. Remove the `badInput` check → the Review Focus 2 test goes red (fetch called).
2. Add `nickname: string` to `ContactBody` → `tsc` fails at `_formHasNoExtras`.
3. In `Input`, drop the hint id from `aria-describedby` → the Step 1 describedby test goes red.
