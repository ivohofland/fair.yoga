# #304 — the studio class detail page titles itself by location

**Date:** 2026-08-23 · **Issue:** #304 · **Bundle:** 7 (the studio class family) ·
**Prior art:** `2026-08-22-studio-family-e2e-design.md` §4.3 (#281's one-expression rule, landed in PR #303)

## 1. What was measured (and where the issue was wrong)

Every claim in the issue was checked against the merge base before designing.

### Holds

| Claim | Verified |
|---|---|
| Card caption leads with type | `src/components/schedule/class-list.tsx:140` — `{sc.classType ? \`${sc.classType} · ${sc.location}\` : sc.location} · Studio class` |
| Detail header titles by location alone | `src/app/(teacher)/studio-class/[id]/page.tsx:71` — `<PageHeader title={studioClass.location} … />`. **Live defect**: on a day with two classes at one venue, both pages head identically with the venue and neither names the class |
| `StudioClassCard` is the only list entry into `/studio-class/[id]` | `class-list.tsx:128`; the other references are `/studio-class/new` links and the delete button leaving the route |
| `studio-class/new` pushes there after logging | `new/page.tsx:140,173` |
| PR #303's five template surfaces use `classType \|\| location` | Three sections via the shared `StudioTemplateRow` (`studio-template-list.tsx:46`), template detail header (`settings/studio-classes/[id]/page.tsx:39`), Template link on the class page (`studio-class/[id]/page.tsx`, `studioClass.template.classType || …`) |
| Coverage gap | `tests/integration/studio-class-page.test.ts` seeds typed fixtures ('Page Case', 'Page Template', 'Page Template Today', 'Solo Case') and never asserts a heading; `tests/e2e/studio.spec.ts` visits `/studio-class/[id]` in the generated arc and lands there in the manual arc asserting buttons and URL, never the h1 |

### Wrong

**"A manually logged class with a blank class type" is not producible.**
`createStudioClassSchema.classType: z.string().min(1)` (`src/lib/schemas.ts:468`) is the
only manual write path; generation copies the template's classType verbatim
(`src/services/studio-class-generator.ts:285`) and every template write path validates
`.min(1)`; every `prisma.studioClass.create` in `src/` sets the field explicitly (two sites:
route.ts:44, generator createMany). Empty string arrives only through legacy rows or direct
DB writes. **The fallback stays anyway** — the column is `String @default("")`
(`prisma/schema.prisma:563`) so the DB permits what the app cannot write, and expression
parity across the family is the point — but its justification is "the schema allows it",
not a live path. This correction goes in the PR body, not beside the code.

### Omitted by the issue, and load-bearing

**Two existing assertions pass because of this defect.**
`tests/integration/studio-class-page.test.ts`'s first two cases assert
`expect(html).toContain('Community Studio')`. Their fixtures carry classType
('Page Case', 'Page Template Today'), their templates render *their own* classType in the
Template link ('Page Template', 'Page Template Today'), and the details block has no
Location row — so today the defective header is the only element carrying the venue.
Any fix that leads with type makes both assertions fail unless the venue becomes visible
somewhere else. This is what turns the issue's "worth deciding at the same time" question
from cosmetic into structural.

## 2. Decision — option C: type-led title plus a Location row

Chosen at the direction gate over:

- **A, bare `classType || location`** (strict parity): drops the venue from the screen
  entirely for a typed class — the issue itself calls this "probably not what is wanted" —
  and leaves the two venue assertions passing only if re-pointed at nothing.
- **B, `classType · location` in the h1** (verbatim card match): diverges from all five
  other surfaces' expression and puts a separator inside an h1, which has no precedent in
  this codebase.

C reproduces the *outcome* of both sibling families:

- The regular class family titles its detail page `title={cls.classType}` bare
  (`src/app/(teacher)/class/[id]/page.tsx:150`) with venue info in the body below.
- After PR #303, the template detail page renders title = classType with the venue
  visible in the form beneath.

## 3. Changes

### 3.1 Header (`src/app/(teacher)/studio-class/[id]/page.tsx:71`)

```tsx
<PageHeader title={studioClass.classType || studioClass.location} backHref="/" backLabel="Schedule" />
```

The same expression five other surfaces already use.

### 3.2 New Location row in the details block

Current rows render in order: Date, Time, Hourly rate, Template (conditional). Insert
**Location between Time and Hourly rate** — the when/where facts group together and money
and template stay last. This is a deliberate divergence from both studio forms, which
collect Location immediately after Class type, ahead of the time fields
(`studio-template-form.tsx`, `studio-class/new/page.tsx`); the page groups by kind of fact,
the form by order of entry. Same markup pattern as its siblings:

```tsx
<div className="min-h-14 py-2 border-b border-border">
  <span className="type-label">Location</span>
  <p className="text-base text-ink">{studioClass.location}</p>
</div>
```

It renders in both the live and the cancelled branch — the details block sits outside that
ternary — which matters because the cancelled page otherwise shows nothing naming the
class or its venue beyond the header.

No migration, no service change, no API change. The column is non-null and `.min(1)`-
validated on both write schemas.

### 3.3 Visual baselines

None cover the studio class page. `tests/e2e/visual.spec.ts` snapshots only the template
detail page (`studio-template.png`), so nothing needs regenerating.

## 4. Coverage

### Integration — `tests/integration/studio-class-page.test.ts`

Four additions, each anchored so it cannot pass against a page that renders nothing:

1. In the first case ("offers no removal on a future generated class"), assert the heading
   IS the fixture's classType: `toMatch(/<h1[^>]*>Page Case<\/h1>/)`. A whole-string anchor,
   not `toContain('Page Case</h1>')` — that form matches any h1 merely *ending* with the
   class type, so a venue-led composite (`Community Studio · Page Case`) satisfies it. The
   loose form is blind in the one direction that matters, since leading with the venue is
   the defect being removed.
2. Anchor the two venue assertions to the row that now carries them:
   `toContain('>Location</span>')` alongside the existing `toContain('Community Studio')`.
   For those to mean anything the fixture templates must **not** share the class's venue —
   they are `'Template Venue'`, so `'Community Studio'` can only have come from
   `studioClass.location`. Without that, a row reading `template.location` renders an
   identical string and no assertion in the file notices.
3. In the cancelled case ("offers removal on a cancelled past class"), assert the heading
   and pin the row as a unit — `toMatch(/>Location<\/span>\s*<p[^>]*>Community Studio<\/p>/)`,
   label and value adjacent. This is the only case exercising the cancelled branch, and
   without it §3.2's claim that the details block renders there is pinned by nothing: a
   change gating that block on the live branch passes every other assertion in the file.
   The class has no template, so it is also the only case where a row reading template
   state renders empty rather than merely wrong.
4. A case for the `|| location` fallback itself, seeded `classType: ''`. Unreachable
   through the app — see §1 — but this file writes through Prisma, so it can seed what the
   API refuses. Without it, deleting `|| studioClass.location` leaves the whole suite green.
   The template family already pins its equivalent
   (`src/components/settings/studio-template-list.test.tsx`).

### e2e — `tests/e2e/studio.spec.ts`

1. Generated-class arc (~:203, after the existing button asserts on
   `/studio-class/${first.id}`):
   `await expect(page.getByRole('heading', { name: 'Studio Flow', exact: true })).toBeVisible()`.
   `exact` is load-bearing: Playwright's `name` matches a **substring** by default, so
   without it a venue-led composite passes. The arc also pins the card's `href` against the
   id it then opens — otherwise the card assertion and the heading assertion describe two
   screens that merely happen to agree, since nothing else in the suite pins that target.
2. Manual-log arc (~:491): after the URL assertion, heading 'Cover Class' and the
   'Guest Studio' row visible. Exercises the non-fallback branch end to end from the
   form the teacher filled.

### Proving the guards bite (explicit steps, per guard)

- **Heading assertions**: run the new integration cases against unfixed source — both must
  fail on the h1 reading 'Community Studio'. Record the failure text, apply §3.1, re-run green.
- **Location-row assertions**: apply §3.1 alone (header fixed, no row) — the venue
  assertions must fail ('Community Studio' nowhere in the HTML); add §3.2, green.
- **e2e**: same order — heading assertion red against current dev server, then fixed.
  Warm the route before judging (`next dev` compiles lazily; a cold-route timeout reads
  like a red).

Mutation values here are reverts and deletions of real code, so the "value the code cannot
produce" rule does not apply; the rule that does apply is warm-routes-before-scoring.

## 5. What this does not do

- **#284 is unaffected** (generation still not week-keyed).
- **#275, #276, #277, #278, #280, #282 are unaffected** — behavioural defects with their own acceptance.
- No change to the card caption, the Template link, reporting, or any API response shape.
- No fallback-behaviour change anywhere: the ternary on the card and the `||` in the new
  title keep the legacy-row safety the DB affords.

## 6. Re-derivables

- Sites titling a studio *class*: two — the schedule card (`class-list.tsx:140`) and this
  header — and they do **not** agree: the card composes both facts, the h1 names one.
  Every site titling a studio *template*, plus this header, does share one expression.
  Re-derive with `grep -rn "classType || " src/ --include='*.tsx'`, which returns **four
  lines, not six**: the shared `StudioTemplateRow` (`studio-template-list.tsx:46`) is one
  line rendered from three call sites, so `3 + 1 + 1 + 1 = 6` surfaces come from 4 code
  sites — that row, the template detail header, the Template link, and this header. The
  card's ternary is a different expression and matches none of them. Count lines when
  reading the grep and surfaces when reasoning about the UI — a shared component is one
  line and many surfaces.
- Blank-classType reachability: `sed -n '445,483p' src/lib/schemas.ts` — all three studio
  schema lines that accept a `classType` read `.min(1)`, and `updateStudioClassSchema` has
  no `classType` field at all, so the value is immutable after creation. The column default
  that permits the empty string lives at `prisma/schema.prisma:563`.
