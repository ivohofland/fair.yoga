# Input bounds and send limits (#769) — design

The premise is measured in `2026-10-07-input-bounds-census.md`, which sits beside this file and carries the tooling and grep commands that re-derive every count. This file decides what to do about it.

## 1. What the census changed about the issue

- **The issue lists examples; the census found the whole set.** 50 persisted, user-authored text fields have no `.max()`: 59 unbounded string leaves − 5 bounded by a refine − 4 never stored. Beside them sit 6 email fields and 2 `pageSlug` fields with no length cap, and 31 numbers with no upper bound.
- **Long strings in indexed columns are 500s, not just bloat.** A btree index refuses a value of roughly 2,700 bytes or more (SQLSTATE 54000), and `classifyApiError` has no branch for it. The affected columns are the room identity indexes, `Teacher.pageSlug` and every email column.
- **Overflow is 500, as the issue says.** A value rounding to ≥ 10⁸ in `Decimal(10,2)` raises 22003/P2020, and a value ≥ 2³¹ in `Int` raises an unclassified conversion error.
- **A derived overflow the issue misses.** Completing a class writes `roomCost + effectiveTeacherRate` into `Decimal(10,2)`. Capping each field at the column maximum would only move the 500 from the request to the hourly completion sweep.
- **nginx is 1 MB for announcements, not 10 MB.** The 10 MB raise covers only the photo route. Next.js and `parseBody` set no limit of their own.
- **A second arbitrary-address email channel.**
  - A walk-in with `newContact` creates an unclaimed `Student` at an address the teacher chose.
  - That student is sent `walk_in_added`, whose subject is `You're in ${classType}`.
  - They are then sent cancellations, payment requests and announcements.
  - The issue names only the invitation email.
- **Line numbers in the issue are stale.** The census gives the current ones.

## 2. Decisions

### 2.1 One bounds module, and which builder each field gets

`src/lib/input-bounds.ts` is client-safe: no server imports, because the forms import it. It exports named limit constants and the zod builders below. Every regex uses the `u` flag: without it, `\p{…}` matches literal text.

- **`singleLineText(max)`:** trim, then `.max(max)`. It refuses:
  - `\p{Cc}`;
  - every `\p{Cf}` *except* U+200C and U+200D. ZWNJ and ZWJ are needed by Indic and Persian scripts and emoji sequences. Refusing the rest removes the bidi controls (U+200E/F, U+202A–E, U+2066–9, U+061C), U+FEFF, and invisible splitters such as ZWSP (U+200B) and the word joiner (U+2060), which can make `evil​.com` render as `evil.com`;
  - `\p{Zl}` and `\p{Zp}` (U+2028/9).
- **`multiLineText(max)`:** the same refusals, except that `\n`, `\r` and `\t` are allowed. It does **not** trim. A description or message keeps its leading and trailing whitespace exactly as stored today, so the edit forms' resend stays byte-identical.
- **`linkFreeText(max)`:** `singleLineText(max)`, plus the link refusal:
  - `://`, `www.`, `@`;
  - the look-alike dots U+3002, U+FF0E, U+FF61 and U+2024;
  - a **host-shaped token**: a label of two or more letters/digits/hyphens, a `.`, then either any two ASCII letters or one of a short list of common generic TLDs, followed by a non-letter or the end. The match is case-insensitive and Unicode-aware.

  The label must be two or more characters, and the part after the dot must be exactly two letters or a listed TLD. That keeps `St.Clair`, `J.R.`, `J.de Groot`, `Th.van Dijk` and `Ma.del Carmen` legal while refusing `evil.com`, `EVIL.COM`, `bank.nl` and `verify.de`. The TLD list lives in the module as a named constant.

**Which fields get which builder.** Each field keeps its current requiredness: every existing `.min(1)` stays, and every optional or `''`-defaulting field stays so.

| Field family | Builder | Limit constant |
|---|---|---|
| teacher, student, invitation and walk-in `newContact` first/last names | `linkFreeText` | `NAME_MAX` = 60 |
| `classType` (both class families) | `linkFreeText`, because it lands in the `walk_in_added` email subject | `CLASS_TYPE_MAX` = 80 |
| studio `location` | `singleLineText` | `LOCATION_MAX` = 200 |
| room `venueName`, `roomName`, `address`, `city`, `postcode`, `floor` | `singleLineText` | 120, 80, 200, 100, 16, 40 |
| room `equipment[]` items; array length | `singleLineText`; `.max` | `EQUIPMENT_ITEM_MAX` = 60, `EQUIPMENT_ITEMS_MAX` = 30 |
| class/template `description`, announcement `message`, `Room.notes`, `equipmentNotes` | `multiLineText` | `LONG_TEXT_MAX` = 2000 |
| `markPaid.method` | `singleLineText` | `PAYMENT_METHOD_MAX` = 64 |
| every `emailField` | `.max` before the format check | `EMAIL_MAX` = 254 (RFC 5321's path limit) |
| `pageSlugField` | `.max` | `PAGE_SLUG_MAX` = 60 |

The invitation `lastName`, which today has no `.trim()`, gets `linkFreeText`'s trim like every other name.

**Numbers.** Every leaf has both bounds on its own, without leaning on a cross-field refine.

| Constant | Value | Fields |
|---|---|---|
| `DURATION_MAX_MINUTES` | 1440 | every `durationMinutes` (positive int as today) |
| `MONEY_MAX` | 100000 | `roomCost`, `hourlyRate` and `rentalRate` in `[0, MONEY_MAX]` (their current lower bounds stay). `minRate` and `targetRate` in `[−MONEY_MAX, MONEY_MAX]`, with `economicsViolations` still enforcing the cross-field rules |
| `CAPACITY_MAX` | 1000 | `maxCapacity`, `capacityOverride`, studio `studentCount` |

**Why these numbers:**

- **Money.**
  - `roomCost + targetRate ≤ 2 × 100,000 = 200,000`, far below `Decimal(10,2)`'s 99,999,999.99. So completion cannot overflow.
  - No `Registration.price` or `Payment.amount` can overflow either: each is at most the class total (`pricing.ts`, `price_i = total·r_i / Σr`).
  - Studio `hourlyRate × duration` is computed in JS only, never stored.
  - **Currency dependency.** 100,000 is beyond any plausible class price in every member of today's `Currency` enum (EUR, GBP, USD, CHF, SEK, NOK, DKK). A currency such as JPY, HUF, ISK or KRW would make it a real ceiling. A unit test pins the enum's members next to the cap, so adding a currency fails until the cap is re-decided.
- **Duration.** 1440 keeps `ScheduleRule.slot` at most 1439 + 1440 = 2879, int4-safe, and an entry's span at most 24 h.
  - **Accepted:** a template that crosses midnight is not compared against the next weekday's rules. Its generated weeks can then be skipped as `blocked_by_overlap`. That gap exists today for any cross-midnight template; this cap bounds it, it does not create it.
- **Text.**
  - The capped indexed columns stay far below the btree row limit, which is in bytes. The room identity columns sum to 320 characters, at most 1,280 UTF-8 bytes.
  - `.max()` and the HTML `maxLength` both count UTF-16 code units, so client and server agree.
- **Existing data.** No seed or fixture value exceeds any cap (census §G). The product is not in production, so no backfill is needed. That is also why an edit form's full resend cannot trip over a stored value: no writer outside these schemas produces one longer.

**No DB `CHECK` mirrors.** The generator copies template values into class rows, but templates are capped by the same schemas, so every writer is covered at the edge. A `CHECK` would duplicate each bound in a migration without catching a writer the schemas miss.

### 2.2 Names, class types and phishing

The link refusal narrows the channel; it cannot close it. "Your Bank Security" passes every rule. What the change does:

- the two teacher-written strings that reach a never-signed-up address in a subject line — the teacher's name (invitation) and `classType` (`walk_in_added`) — can carry no link-shaped text, no bidi tricks and no invisible splitters, and are short;
- the 50/h per-teacher `students` bucket that already throttles invitations and walk-ins.

**Deliberately unchanged: announcement messages may contain links.** A teacher legitimately sends a video-call link, a map or a payment page. Messages are bounded in length and send rate (§2.3), not in content. The unclaimed walk-in student receives them only after a teacher has registered that address for a class.

The invitation template already escapes HTML, and its subject goes through Resend's JSON API, so no header is assembled in this repo.

### 2.3 Announcements

- **A new rate-limit prefix, `announcements`:** 10 sends per teacher per hour, keyed by `teacherId`, answering 429 through `respondRateLimited`.
- **Placement.** It is checked after `requireTeacher` and before the body parse and the audience read, so a refused send costs no query.
- **Consequence:** at the limit, a network retry of an already-sent message gets 429 rather than the dedupe's unchanged answer, and a 403/404/no-recipients request also spends budget. That is acceptable for a brake.
- **The 2-minute identical-text dedupe stays.** It answers a different question: a double submit.
- **Test budget.** `tests/integration/announcements-api.test.ts` sends about 35 announcements with one teacher on the shared server. It moves to one teacher per describe block, each sending at most 10, and the throttle test gets its own teacher.

### 2.4 Forms mirror the limits

- **Text inputs get `maxLength={CONSTANT}`.** It stops typing and silently truncates a paste, which is acceptable, because the server is the authority. The signup page-address field gets `maxLength={PAGE_SLUG_MAX}`. Its suggestion (`slugFromName`, which joins two name slugs) is truncated to `PAGE_SLUG_MAX` without a trailing `-`, since two 60-character names would otherwise pre-fill an invalid 121-character slug.
- **Number inputs are capped in each form's own JS validator,** in that form's copy. `max=` on a number input only takes part in native validation on a real `<form>` submit, and the class edit, new-class and studio-class edit forms have no `<form>`. The validators are `class-edit-form`'s `numberFieldError`, `new-class-form`, `template-form`, `new-studio-class-form`, `studio-template-form` and `studio-class-edit-form`. Inputs also get `max`, and `min={-MONEY_MAX}` where negatives are allowed, as a hint.
- **The schema caps carry human messages** (e.g. "Keep the class type under 80 characters."), so a request that reaches the server unvalidated still reads well.

## 3. Rejected

- **Raising the overflow answers to 400 in `classifyApiError`** (P2020, 22003, 54000, the int4 conversion error). With the caps, no request reaches them, and a 400 for an unreachable fault would carry no tested meaning.
- **Making `method` an enum.** Nothing reads `Payment.method`, and the UI sends `'manual'`. An enum is a product decision about payment kinds, not a bound.
- **Making `equipment[]` an enum of the checkbox vocabulary.** It is tighter, but a separate change. Length caps bound it.
- **A recipients-per-hour announcement budget.** Ten sends an hour, each at most 2,000 characters, bounds the write volume without a second unit.
- **Refusing ZWJ/ZWNJ.** That would break legitimate names.
- **A full TLD list.** It is unbounded and drifts. Two-letter labels plus a short generic list catch the realistic shapes.
- **A guard for body schemas defined outside `schemas.ts`.** The census found none (`grep -rln "from 'zod'" src | grep -v test`). A new one is a review question, not a test.

## 4. Tests and the guards they must prove

| Guard | Test | Mutation that must turn it red |
|---|---|---|
| each text cap | schema unit test: the limit passes and limit + 1 fails, one representative field per builder row of §2.1 | raise the constant, or drop `.max` |
| membership: no unbounded leaf | a unit test walking every `ZodType` export of `schemas.ts`, using the existing export filter (`instanceof z.ZodType` minus the field-validator exports): <ul><li>every string leaf has `max_length`, is uuid/datetime, is an enum, or is on an allow-list of never-persisted fields, each with a reason;</li><li>every number leaf has an upper and a lower bound;</li><li>every array has a max;</li><li>an unknown def type fails</li></ul> | remove `.max` from any one field; add an unbounded `z.number()`; add a `z.record(...)` |
| control and format characters | unit: `\u0000`, `‮`, `​`, `⁠`, `﻿`, ` ` refused; `\n` refused single-line and allowed multi-line; a ZWJ Devanagari name and a ZWNJ Persian name accepted | drop the `u` flag; drop `\p{Cf}` |
| link refusal | unit, both directions:<ul><li>refused: `evil.com`, `EVIL.COM`, `bank.nl`, `https://x`, `www.x`, `a@b`, `evil。com`, `verify.de`</li><li>accepted: `St.Clair`, `J.R. Smith`, `J.de Groot`, `Th.van Dijk`, `Ma.del Carmen`, `Anne-Marie O'Neil`, `d'Artagnan`, Arabic and CJK names</li></ul> | drop the host test; make it case-sensitive; drop the look-alike dots |
| optional last name | integration: a contact, a walk-in and a CRM edit with `lastName: ''` still succeed | apply a `.min(1)` to invitation `lastName` |
| number caps | unit: each family at its bounds passes and one past fails. `minRate` at −MONEY_MAX − 1 is refused on the **update** schemas, where no `superRefine` already refuses it | raise or drop the constant |
| completion cannot overflow | unit: `2 * MONEY_MAX <= DECIMAL_10_2_MAX`, naming the column maximum. Integration: one class at `roomCost = targetRate = MONEY_MAX` with one registration completes and stores the sum | (unit) raise `MONEY_MAX` |
| currency tether | unit: the `Currency` enum's members equal the list `MONEY_MAX` was decided for | add a member |
| the API answers 400, not 500 | integration: POST a class with `roomCost: 1e12` and with `durationMinutes: 2**31` → 400 | — |
| announcement throttle | integration: the 11th send in an hour → 429; another teacher unaffected | remove the check |
| slug suggestion | unit: two 60-character names → a suggestion of at most `PAGE_SLUG_MAX` with no trailing `-` | drop the truncation |
| forms validate | component tests driving cap + 1 in a representative form per validator (class duration, money, a name, the announcement message) and asserting the form's own error copy, not the attribute | remove the cap from one validator |
