# Decimal comma in number fields (#844) — design

## Problem

A teacher in a comma-decimal locale types `4,5` into a money field. In Chromium a
`<input type="number">` drops the comma before the page sees it: the field
reports `45` and `validity.badInput` is false, so nothing on the page can tell it
from a real `45`. A room cost, rate or VAT rate of 4,5 saves as 45 with no error.
#842 refuses input the browser flags as unreadable; this input is not flagged.

## Premise, measured

Headless Playwright, `locale: 'nl-NL'`, typed key by key into
`<input type="number" step="0.01">` and `<input type="text" inputmode="decimal">`
(Chromium 1228, WebKit 2311):

| typed | Chromium number | WebKit number | either engine, text |
|---|---|---|---|
| `4,5` | `45`, badInput false | `4.5`, badInput false | `4,5` |
| `4,55` | `455`, false | `4.55`, false | `4,55` |
| `45.` | `45`, false | `''`, **true** | `45.` |
| `1.000,5` | `1.0005`, false | `1.0005`, false | `1.000,5` |
| `-` | `''`, true | `''`, true | `-` |
| `4e` | `''`, true | `''`, true | `4e` |

What held, and what did not:

- **Held:** Chromium turns `4,5` into `45` without flagging it.
- **Wrong:** the issue guessed WebKit "may report `''` + `badInput`". Desktop
  WebKit in `nl-NL` *translates* the comma: `4,5` arrives as `4.5`. iOS Safari
  and Android Chrome on real devices remain unmeasured. The design below does
  not depend on either, because the browser no longer parses.
- **Missed:** both engines read a Dutch thousands separator as a decimal point,
  so `1.000` (one thousand) arrives as `1`. That is also silent. A naive
  "comma means decimal" parser would add the mirror case: an English-locale
  `1,000` would read as `1`.
- **Wrong, in this repo:** `NumberInput`'s docblock and three form tests
  (`new-class-form`, `template-form`, `class-edit-form`) say a browser reports
  `"4,5"` as `''` with `badInput` set. In Chromium it does not.

## Surface

Census at f2c77e87: 33 numeric `<input>`s outside tests (19 `NumberInput` + 14
`Input type="number"`). Re-derive with:

```
grep -rn '<NumberInput' src | grep -v '\.test\.'                   # 19
grep -rn 'type="number"' src | grep -v '\.test\.'                  # 16 lines − number-input.tsx:37 − a comment = 14
```

Of the 33, 16 are decimal (15 money, 1 VAT %) and 17 are integer (durations,
min/max students, capacities, a student count). This change covers **the 16
decimal fields**:

| holds | fields |
|---|---|
| a number, via `NumberInput` (10) | room cost, min rate, target rate × new-class, template, class-edit (9); default VAT % (profile) |
| a string, via `Input` (6) | hourly rate × new-studio-class, studio-template, studio-class-edit (3); rental rate × edit-room, room-settings-step, edit-teacher-room (3) |

The integer fields are unaffected: nobody types a fraction into a capacity, and
a refusal there would only be noise.

Related facts from the census:

- No money schema limits decimal places. Money columns are `Decimal(10,2)` and
  round silently. VAT is the only field with a decimals check:
  `vatPercentViolation`, at most `VAT_PERCENT_DECIMALS` (3).
- `edit-room-form` and `edit-teacher-room-form` check the rental rate's
  `MONEY_MAX` only through native `max` on a real `<form>`. Every other
  decimal field already has a JS `MONEY_MAX` check (or the VAT validator).

## Options

**A. Text field, own parser (chosen).** Render decimal fields as
`type="text" inputMode="decimal"` and parse the text ourselves. The browser
cannot drop or reinterpret a character it does not parse. The mobile decimal
keypad stays, through `inputMode`. Costs:

- No desktop spinner arrows. This product is mobile-first, and the spinner
  steps a money field by 0.01, which nobody uses.
- No native `min`/`max`/`step`. Native checks only ever ran on a real `<form>`
  submit, and six of the ten `NumberInput` fields sit outside one. The JS
  validators carry the bounds, and two room forms gain the `MONEY_MAX` check
  they were missing.

**B. Keep `type="number"` and intercept the comma** (`beforeinput`/`keydown`,
rewriting it to `.`). Paste and IME paths bypass key events. Chromium refuses a
programmatic value like `4.` mid-typing. And it leaves the thousands-separator
misread untouched. Rejected.

**C. Keep `type="number"` and rely on `lang`/locale.** Chromium's number input
does not take its separator from `lang`, as measured above. Rejected.

## Design

### `parseDecimal(text, maxDecimals)`, in `src/lib/decimal-input.ts`

A pure, client-safe function returning a number, or NaN when the text is not
one amount:

- Trim. Blank returns NaN; what a blank field means is the caller's business.
- Accept `^-?(\d+([.,]\d*)?|[.,]\d+)$`: an optional minus, digits, and **at most
  one** separator, which may be `,` or `.`.
- Refuse (NaN) more than `maxDecimals` digits after the separator. For money
  (`maxDecimals` 2) this is what catches thousands-separator typing in either
  locale. `1.000` and `1,000` have three fraction digits, which no amount has, so
  both are refused rather than read as 1.
- Otherwise replace `,` with `.` and return `Number(...)`.

VAT passes `Infinity`, not `VAT_PERCENT_DECIMALS`. A thousands separator cannot
mean anything in a value capped at 100, and `vatPercentViolation` already refuses
a fourth decimal with its own, clearer message ("Use at most 3 decimals for
VAT."). A parser limit would turn that message into a generic NaN refusal.

Text with grouping characters is refused: two separators (`1.000,5`), spaces
(`1 000`), or anything else. Refusing it is the safe way to fail. The teacher
sees each form's existing NaN message: "Enter a number for room cost" in the
class forms, and "Enter an hourly rate — 0 if this class is unpaid." in the
studio forms. The three room forms send NaN to "Rental rate must be 0 or more",
which is wrong for `1.000`. Their NaN case splits off as "Enter a number for
rental rate", matching the class forms. A `1.000` or `4,555` refusal does not
say that the problem is the decimals. That is accepted: the failure is visible
and the teacher retypes, and both inputs were silent misreads before.

A money-decimals constant, `MONEY_DECIMALS = 2`, joins `MONEY_MAX` in
`src/lib/input-bounds.ts`, so every money call site names the same value.

### `NumberInput`, decimal mode

`NumberInput` gains an optional `decimals` prop. With it, the field renders
`type="text" inputMode="decimal"` and parses with
`parseDecimal(text, decimals)`, keeping its blank-holds-0 rule. Without it, the
field is the integer `type="number"` it is today, `badInput` path included. The
prop type makes `min`, `max` and `step` impossible alongside `decimals` (a union
with `?: never`). Those attributes do nothing on a text field, so the compiler
rules them out instead of letting them mislead.

The rewrite rule ("rewrite the text only when it no longer parses to `value`")
keeps working: `"4,5"` parses to 4.5, so a held 4.5 leaves the comma as typed.
NaN stays unrewritable, as it is today. One new case needs a guard. In decimal
mode, `String(value)` need not parse back to `value`: a held 4.555 in a
2-decimal field, or an exponent form like `1e-7`, parses to NaN. Rewriting to
it would then rewrite again on every render. The rule also skips the rewrite
when `text === String(value)`.

The docblock's `"4,5"` claim is replaced by what is true now.

### The six string-held fields

They render `type="text" inputMode="decimal"`, drop `step`/`max`, and convert
with `parseDecimal(x, MONEY_DECIMALS)` where they used `Number(x)`. Swapping the
type without swapping the parse would be a new silent misread, because
`Number('4,5')` is NaN, and every place that ran `Number()` on the field must
change. `studio-class-edit-form` has two: the validator and the save payload.

Each form's blank handling stays the same, but `parseDecimal('')` is NaN where
`Number('')` was 0, so keeping it takes code in the room forms:

- The three studio forms refuse blank with `!x.trim()` before parsing.
  Unchanged.
- The three room forms send a blank rental rate as 0 today, through
  `Number('') === 0`. `room-settings-step` starts the field empty, so this is
  the path of a room saved without touching the rate. They now convert with
  `x.trim() === '' ? 0 : parseDecimal(x, MONEY_DECIMALS)`. A rental rate of 0
  is a legitimate free room, and changing what blank means is not this issue.

`edit-room-form` and `edit-teacher-room-form` gain the `rate > MONEY_MAX` check
that `room-settings-step` has, with its message ("Rental rate cannot exceed
100,000").

`studio-class-edit-form`'s docblock explains its string state through
`<input type="number">` reporting `''`. It is rewritten for a text field.

### Display

A held 4.5 is shown back as `4.5` (`String(value)`) after a reload, even to a
teacher who typed `4,5`. The parser accepts it either way, so this is cosmetic.
Locale-aware display belongs with i18n, which CLAUDE.md defers.

## Testing

- **Unit, `parseDecimal`:** the table above, plus `,5`, `5,`, `-4,5`, `0,00`,
  `4,555` (NaN at 2, 4.555 at 3), and blank.
- **Component:** each changed form, with `"4,5"` typed into a decimal field,
  sends 4.5. `NumberInput` keeps `"4,5"` as typed while holding 4.5. The
  `badInput` tests on decimal fields go: `badInput` cannot occur on a text
  input. The comments claiming `"4,5"` produces it go too. The integer
  `badInput` test in `number-input.test.tsx` stays.
- **e2e, real Chromium:** jsdom does not reproduce Chromium's comma-dropping,
  so one spec per path: a `NumberInput` field (class-edit target rate) and a
  string-held field (new studio class hourly rate), each typed `x,5` and read
  back as `x.5` from the database. Type key by key (`pressSequentially`).
  Playwright's `fill` throws `Cannot type text into input[type=number]` on the
  old field, so a `fill`-based proof would fail for the wrong reason. Measured:
  under both the default `en-US` and `nl-NL`, `pressSequentially('24,5')` into
  Chromium's number input yields `245`. No locale override is needed.
- **Guard proof:** each e2e spec fails on `origin/main`'s field (Chromium saves
  `x5`), and each component test fails with the field's old `type="number"`.
  Record the error text.

## Out of scope

- Integer fields (above).
- Server-side decimal-place limits on money. The client now refuses a third
  decimal, and the server still accepts and rounds one sent directly.
- The pre-existing gaps the census found that this change does not touch:
  `student-count-editor`'s JS validator has no integer or negative check (the
  server refuses both), and the room forms' blank rental rate becomes 0 (above).
