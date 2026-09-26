# Every IANA zone in the timezone picker, one spelling in the database (#258)

## 1. What the issue said, and what holds now

#258 named two defects: every teacher was created in `Europe/Amsterdam` and
never asked, and the Settings picker that could fix it offers 26 zones.

| Claim | Measured 2026-09-26 on `main` |
|---|---|
| Creation hardcodes Amsterdam; nothing infers it | **Fixed by #385.** `detectTimeZone()` in `src/components/signup/profile-setup-form.tsx` reads the browser's zone at submit; `detectedTimezoneField` (`src/lib/schemas.ts`) keeps it when `isValidTimeZone` accepts it; `POST /api/account/teacher-profile` falls back to Amsterdam only when it is absent. The cited `src/app/api/teachers/route.ts` no longer exists. |
| `TIMEZONE_OPTIONS` is a hand-written list of 26 zones | **Holds.** `src/components/settings/profile-form.tsx`: 18 `Europe/*` + 6 `America/*` + 2 `Australia/*` = 26. It is the only zone list under `src/`. |
| A stored zone outside the list renders the picker blank, and the first touch replaces it with one of the 26 (issue comment 2) | **Holds**, and is reachable today without any manual edit — see §2. |
| `Intl.supportedValuesOf('timeZone')` returns ~400 zones | **418** on Node v22.22.2: Africa 52 + America 144 + Antarctica 11 + Arctic 1 + Asia 82 + Atlantic 10 + Australia 11 + Europe 58 + Indian 11 + Pacific 38 = 418. `UTC` is not among them. |

The issue's option 1 (infer at signup) is done. This spec is option 2 (every
zone selectable). Option 3 (show the inferred zone during onboarding) was
considered and left out: detection is right for nearly everyone, and the
picker this spec builds is where a wrong one is corrected.

## 2. The finding the issue did not have: two spellings of one zone

V8 enumerates CLDR's identifiers, and CLDR never renames one once published.
IANA does. So the list V8 offers and the value a browser reports can spell the
same zone differently — Node resolves `Europe/Kyiv` to `Europe/Kiev`, lists
only `Europe/Kiev`, and `isValidTimeZone` accepts both.

Consequences today, before this change:

- A teacher whose browser reports `Europe/Kyiv` stores it at signup, and a
  picker built from V8's list would not contain it — the blank-picker defect
  survives a full list.
- A teacher in Kolkata, Ho Chi Minh City or Kyiv would find their city under a
  name it stopped using years ago.

**Measured against the system tzdata** (`/usr/share/zoneinfo`, version
`2026c-rearguard`): V8's 418 and `zone.tab`'s 418 differ in exactly 19 names,
one-for-one — each of V8's 19 is an old spelling whose current name is the
`zone.tab` entry V8 lacks.

```
node -e "
const fs=require('fs');
const tab=new Set(fs.readFileSync('/usr/share/zoneinfo/zone.tab','utf8').split('\n')
  .filter(l=>l&&!l.startsWith('#')).map(l=>l.split('\t')[2]));
const v8=Intl.supportedValuesOf('timeZone');
console.log(v8.filter(z=>!tab.has(z)));      // V8's old spellings
console.log([...tab].filter(z=>!v8.includes(z))); // their current names
"
```

**The pairing is by rename, not by tzdata link.** Following `tzdata.zi`'s link
lines gets four of the 19 wrong, because IANA also links a zone to another
country's zone when their clocks have agreed since 1970: `Africa/Asmera →
Africa/Nairobi`, `Pacific/Ponape → Pacific/Guadalcanal`, `Pacific/Truk →
Pacific/Port_Moresby`, `America/Coral_Harbour → America/Panama`. The pairs this
spec uses are the renames — `Asmara`, `Pohnpei`, `Chuuk`, `Atikokan` — each of
which is the `zone.tab` entry for that place.

## 3. Decisions

1. **Native `<select>` with `<optgroup>` per region**, no filter input. Phones
   render a native list the teacher can scroll and type into; it is the same
   `Select` every other form here uses.
2. **The database holds the current IANA spelling.** Both write paths rename an
   old spelling before storing, so one zone has one value in the column and in
   the picker. Not in production yet, so there is no stored data to migrate.
3. **The picker is built on the server** and passed to the client form as
   props (§4.3).
4. **No onboarding confirmation step** (issue option 3).

## 4. Design

### 4.1 `modernTimeZone` — `src/lib/iana-timezone.ts`

A `MODERN_ZONE_NAMES` record from each old spelling to its current name (§2's
19 pairs), and `modernTimeZone(tz: string): string` returning the mapped name
or `tz` unchanged.

It lives in `iana-timezone.ts` because `schemas.ts` needs it and that file is
the client-safe, import-free home for zone logic; it stays import-free.

Which pairs, and how they were derived, goes in `docs/data-model.md` beside
the `default_timezone` row, with §2's command — a membership claim has an owner
there and not in a comment (*Comment Discipline*). The record's docblock links
there and states only what the function does.

### 4.2 Both write paths store the modern spelling — `src/lib/schemas.ts`

- **Signup:** `detectedTimezoneField`'s transform becomes
  `isValidTimeZone(s) ? modernTimeZone(s) : undefined`.
- **Settings:** `updateTeacherSchema.defaultTimezone` becomes
  `z.string().refine(isValidTimeZone, 'Unknown timezone').transform(modernTimeZone).optional()`.

In the schema, not the route, so every consumer of the parsed body sees one
spelling. That matters for signup's unchanged check:
`POST /api/account/teacher-profile` compares the requested profile against the
stored row (`COMPARED_COLUMNS`). With the rename in the schema, a resubmit whose
browser reports `Europe/Kiev` against a row holding `Europe/Kyiv` compares
equal and answers unchanged; with it in the create alone, the same resubmit
would answer `ALREADY_TEACHER`.

Nothing else compares zone strings — no `===` on `defaultTimezone` or
`timeZone` outside tests — and no SQL reads the column (`AT TIME ZONE` appears
nowhere in `src/` or `prisma/migrations/`), so Postgres's tzdata is never
asked about either spelling.

### 4.3 `timeZoneOptions` — new `src/lib/timezone-options.ts`

```ts
interface TimeZoneOption { value: string; label: string }
interface TimeZoneGroup { region: string; options: TimeZoneOption[] }
interface TimeZoneOptions { standalone: TimeZoneOption[]; groups: TimeZoneGroup[] }

function timeZoneOptions(stored: string, now: Date): TimeZoneOptions
```

- Takes `Intl.supportedValuesOf('timeZone')`, maps through `modernTimeZone`,
  groups on the segment before the first `/`, sorts regions and, within each,
  options by label.
- **Label:** the segments after the region, `/` → ` / ` and `_` → space, then
  the zone's offset at `now` from `timeZoneName: 'shortOffset'` —
  `Auckland (GMT+13)`, `Argentina / Buenos Aires (GMT-3)`,
  `Kolkata (GMT+5:30)`. The offset is today's, and says so by being a number
  rather than an abbreviation; the old labels' fixed `(CET)` was wrong half
  the year.
- **`standalone`** holds `stored` when it is not among the grouped values after
  `modernTimeZone` — `UTC` is the reachable case (a browser can report it, V8
  does not list it) — labelled with its identifier and offset, rendered before
  the groups. Otherwise it is empty. This is what keeps the picker from
  rendering blank, and a first touch from destroying a correct zone.
- `now` is a parameter so tests pin the offset; the page passes `new Date()`.

**Why the server builds it.** `ProfileForm` is `'use client'`, which still
server-renders. A list computed in its render would be Node's on the server and
the browser's on hydration, and nothing makes those agree — a browser's ICU
version and naming are its own, not Node's — so React would hit a mismatch in
the `<option>` children. Built
in `settings/profile/page.tsx` and passed as a prop, both renders use the
server's list — which is also exactly what the PUT's `isValidTimeZone` accepts.

### 4.4 `ProfileForm` and the page

- `settings/profile/page.tsx` computes
  `timeZoneOptions(teacher.defaultTimezone, new Date())` and passes it as
  `timeZoneOptions`.
- `ProfileForm` renders `standalone` options, then one `<optgroup label={region}>`
  per group. `TIMEZONE_OPTIONS` is deleted.

## 5. Tests

| Test | Pins |
|---|---|
| `iana-timezone.test.ts` | For every `MODERN_ZONE_NAMES` pair, `Intl` resolves both sides to the same zone; every value passes `isValidTimeZone`; `modernTimeZone` returns an unmapped zone unchanged. The resolve-equality check is what catches a cross-country pair like Asmera→Nairobi, which no type can. |
| `timezone-options.test.ts` | Auckland, Tokyo, São Paulo, Lagos, Mumbai-as-`Asia/Kolkata` are present; no old spelling appears (`Europe/Kiev` absent, `Europe/Kyiv` present); no value appears twice; `UTC` stored → one standalone option, `Europe/Amsterdam` stored → none; label shape with a pinned `now`. |
| `schemas.test.ts` | Both schemas turn `Europe/Kiev` into `Europe/Kyiv`; `updateTeacherSchema` still refuses `Not/AZone`. |
| `profile-form.test.tsx` | A stored `UTC` renders selected (not blank), and saving untouched sends `UTC`; a stored grouped zone renders selected. |
| integration: signup + PUT | `Europe/Kiev` sent → `Europe/Kyiv` stored, on each path; signup resubmitted with `Europe/Kiev` against a `Europe/Kyiv` row answers unchanged. |

**Mutations, each recorded with its failure text:**

1. Empty `standalone` unconditionally → the `UTC` form test fails.
2. Delete the `Europe/Kiev` pair → the options test's "no old spelling" fails.
3. Pair `Africa/Asmera` with `Africa/Nairobi` → the resolve-equality test fails.
4. Drop `.transform(modernTimeZone)` from `updateTeacherSchema` → the PUT
   integration test fails; likewise the signup transform.

## 6. Scope

- **#145 is unaffected** — it is about an *invalid* stored zone, which
  `isValidTimeZone` and the daily audit already cover.
- The daily timezone audit (`src/services/timezone-audit.ts`) is not taught to
  flag old spellings: with both write paths renaming, none can be stored.
- No filter input, no onboarding step, no migration.
