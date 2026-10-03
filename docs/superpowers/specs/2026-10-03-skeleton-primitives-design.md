# Skeletons share their pages' layout primitives (#740)

**Status:** design, decided without interaction at the user's request — every
gate below records the option taken and why, so a reader can disagree with a
specific call rather than with the whole.

## The problem, as measured

A `loading.tsx` is a hand-drawn second copy of its page, and nothing ties the
copy to the original. The issue's account of today's state was re-derived on
`origin/main` at `c650c3ec`:

| Claim in the issue | Measured | Verdict |
|---|---|---|
| Three `loading.tsx` files, all built from raw `Skeleton` | `find src/app -name loading.tsx` → `(teacher)/loading.tsx`, `(teacher)/students/loading.tsx`, `(teacher)/inbox/loading.tsx`; each imports only `@/components/ui/skeleton` | holds |
| Root `(teacher)/loading.tsx` is schedule-shaped and covers every teacher route without its own | heading + three `h-32` blocks; its comment says "also the fallback for teacher segments without their own" | holds |
| `students/loading.tsx` also covers `students/[id]`, `new`, `contacts/[id]`, both archived lists | App Router: a `loading.tsx` wraps its segment and every nested segment without a closer one | holds |
| `(student)` has no `loading.tsx` | none under `src/app/(student)` | holds |
| Directory-row recipe `min-h-14 … border-b` written inline "at at least ten sites" | `grep -rn 'min-h-14' src \| grep -v '\.test\.' \| wc -l` = **31** lines: 15 in `src/app` (8 files, 2 of them the skeletons) + 16 in `src/components` | holds, and understates: more than half the sites are in components, which the issue's acceptance grep (`src/app` only) cannot see |
| `class-list.tsx` repeats `Card`'s classes inline | `ClassCard` is a `Link` whose class list is `Card`'s five surface classes plus `block no-underline hover:bg-sand` | holds |

Drift the issue did not list:

- **`students/loading.tsx` is a stale copy of its own page, not only of its
  children.** The real page has a `+ Add contact` header action and a
  `SendAnnouncement` block (`mb-5`) between the header and the search field;
  the skeleton has neither, so the search field and every row sit too high.
- **The design-system gate the issue asks for already exists.** The issue asks
  that "real pages look the same before and after" be verified "at 100%
  (screenshots or DOM measurement)". `tests/e2e/visual.spec.ts` holds macOS
  screenshot baselines for `schedule`, `class-detail-open`, `inbox`,
  `settings` and `studio-template` (among others), and
  `pnpm run attest-visual-baseline <route>` runs that suite and records a
  content-hashed attestation that the route's source changed while its render
  did not. CI's `checks` job refuses a PR that touches a route's source
  without either a new baseline or that attestation
  (`src/lib/visual-baseline-freshness.ts`). So the before/after proof for
  those five routes is that gate, not a new one.

## Decisions

### D1 — One rule: a skeleton is its primitive's frame with placeholder content

`XSkeleton` lives in `X`'s file and renders through the same frame `X` does,
so the frame's classes are written once. The raw `Skeleton` block stays for
**content** placeholders inside a frame. Taken from the issue unchanged.

Content placeholders get one addition, `SkeletonText` in `skeleton.tsx`: a
block element carrying one of the six type styles (`type-display` … `type-caption`)
with a short inline bar inside it. The line box is then exactly the real
text's line-height — taken from the same utility — so a skeleton line is the
right height by construction rather than by a copied `h-4`. Bars that sit on a
sand card surface use the next sand step (`bg-sand`), since `bg-sand-soft` on
`bg-sand-soft` is invisible; `Skeleton` and `SkeletonText` take a
`surface: 'page' | 'card'` prop for this (default `'page'`, today's colour).

**Where a placeholder stands in for another primitive** (a status badge, the
registration bar, the avatar, the search field), the placeholder comes from
that primitive's file too — a `StatusBadgeSkeleton` next to `StatusBadge`,
sharing its pill frame. A skeleton never re-states another file's size. Only
the primitives the loading states below actually compose get a skeleton; none
is added speculatively.

### D2 — The primitives

| Primitive | File | Frame | Skeleton |
|---|---|---|---|
| `ListRow` (+ `listRowClass`) | `src/components/ui/list-row.tsx` (new) | `min-h-14 border-b border-border` + density padding + divider rule | `ListRowSkeleton` |
| `PageHeader` | `src/components/layout/page-header.tsx` | the existing `mb-6` block, back-link slot, `h1` row | `PageHeaderSkeleton`, same `variant`/`backHref` props, plus `action?: boolean` |
| `ScheduleHeader` | `src/components/schedule/schedule-header.tsx` (new, extracted from `schedule/page.tsx`) | avatar + title + caption row with `+ Add class` | `ScheduleHeaderSkeleton` |
| `ClassCard`, `StudioClassCard` | `src/components/schedule/class-card.tsx` (new, extracted from `class-list.tsx`) | `ClassCard` on `Card`; `StudioClassCard`'s dashed frame | `ClassCardSkeleton`, `StudioClassCardSkeleton` |
| `ClassList` week section | `src/components/schedule/class-list.tsx` | `section` + `h2.type-subtitle mb-3` + `flex flex-col gap-3` | `ClassListSkeleton` |

**`ListRow` API (gate: unify the `py-2`/`py-3` split, or name it?).** Named.
The two paddings are not drift: `py-3` rows (notifications, updates, the
student's past bookings) carry a title plus a body line, `py-2` rows a single
label or a label with a caption. Unifying them would change real pages, which
the issue rules out. So `density: 'regular' | 'relaxed'` (`py-2` | `py-3`,
default `regular`). Likewise the last-row border: most sites hide it
(`last:border-b-0`), a few keep it because the list is followed by more
content. `divider: 'between' | 'after-each'` (default `between`) preserves
both. Every other class a site carries today (flex/grid layout, gap,
alignment, `no-underline`, opacity, `px-3 -mx-3` bleed) passes through
`className`.

`ListRow` renders a `div`, or a `next/link` `Link` when given `href`. Sites
whose row element is something else (the `li` steps on `/verify`) call the exported `listRowClass({ density, divider })` — the same function the
component uses, so the frame is still written once. A polymorphic `as` prop
was considered and rejected: it buys nothing the function does not, and costs
a generic prop type every reader has to decode.

**Which sites migrate.** A site migrates when one element carries the whole
recipe — `min-h-14`, the padding and the `border-b` together. Three sites split
it across two elements and are a different geometry, so they stay as they are:
`OutstandingPaymentRow` (border and `py-2` on a wrapper, `min-h-14` on an inner
row, so its minimum is 72px rather than 56), `InstallAppRow` (the wrapper holds
the border because the row expands to show install steps beneath its button)
and `AudiencePicker`'s checkbox `label` (a checklist inside a bordered box,
`px-4` and no vertical padding). Migrating any of them would change a real
page's height, which the issue rules out. **The rule is tethered:**
`src/lib/list-row-recipe.test.ts` (unit project) reads the tree and fails when `min-h-14`
appears outside `list-row.tsx` in any file not in its exception list (each
entry carrying its reason), and when an exception names a file that no longer
uses it. The issue's acceptance grep covered `src/app` only; more than half
the sites are in `src/components`, so the tether covers `src`.

**`Card` (gate: how does `ClassCard` sit on `Card`?).** `Card` gains an
optional `href`; with one it renders a `Link` carrying the same surface plus
`block no-underline hover:bg-sand`. `CardLink` (the chevron layout) keeps its
own layout but takes the surface from the same constant, so the five surface
classes exist once in `card.tsx`. `ClassCard` becomes `<Card href=…>`.

**Visual identity is proven by class sets, then by pixels.** For every migrated
element the rendered tag and class *set* must equal today's (Tailwind output
does not depend on class order). Each task lists each site's before/after set;
the visual suite then confirms five of the routes at 100% on macOS.

### D3 — Every route's loading state is chosen

- **`(teacher)/loading.tsx` becomes neutral:** `PageHeaderSkeleton` with its
  defaults (title variant, back link) and nothing below. A route that forgets
  its own shows a quiet header, never another page's body.
- **Own `loading.tsx`, composed only from primitive skeletons:** the four tab
  roots (`schedule`, `students`, `inbox`, `settings`), `class/[id]` and
  `students/[id]`.
- **A page's own boundary must not cover its children (gate).** A
  `loading.tsx` wraps every nested segment without a closer one, so
  `settings/loading.tsx` would put the settings list in front of
  `settings/profile`, `class/[id]/loading.tsx` in front of the edit form, and
  `schedule/loading.tsx` in front of `schedule/past` — the wrong-page fallback
  this issue removes, one level down (today's `students/loading.tsx` already
  does it to `students/new`). Options: (a) a one-line `loading.tsx` in every
  nested segment, (b) move each such page and its `loading.tsx` into an
  `(overview)` route group beside its children, so the boundary covers that
  page alone. Taking (b): it is Next's documented idiom for exactly this, the
  URL is unchanged, and a page added under `settings/` later falls through to
  the neutral fallback instead of needing boilerplate. It moves five pages —
  `schedule`, `students`, `inbox`, `settings`, `class/[id]` — and
  `students/[id]`, which has no children, keeps its `loading.tsx` beside it.
  Every reference to the moved paths moves with them, the visual-baseline
  map (`ROUTE_BASELINES`) included.
- **Everything else** under `(teacher)` — forms, edit pages, `schedule/past`,
  the settings sub-pages and list pages, `studio-class/*`, `students/*` other
  than the directory and a student's detail, `inbox/invitations` — uses the
  neutral fallback, recorded in the coverage test's allowlist (D4). The
  settings list pages (`recurring`, `rooms`, `studio-classes`) were candidates
  for their own skeleton; they are set-up-once screens, and each would cost an
  `(overview)` move for a list of rows behind a header the neutral fallback
  already draws.
- **`(student)` gets no `loading.tsx` (gate).** Options: (a) a neutral group
  fallback, (b) skeletons for the student tab pages, (c) none. Taking (c).
  A route with no loading boundary shows the previous page until the next is
  ready, so it cannot flash a wrong shape — there is nothing to drift. The
  student pages do not use `PageHeader` (raw `h1`s, `bookings` with
  `items-baseline`), so (a) or (b) would mean either hand-drawn copies — what
  this issue removes — or migrating those headers first, a visual change to
  pages with no screenshot baseline. The coverage test records every student
  page as `none`, so adding one later is a deliberate one-line change.
- **`(public)` gets none either,** recorded the same way.

### D4 — The coverage test

`src/lib/loading-coverage.test.ts` (unit project; the filesystem is its only
input). It walks `src/app` for every `page.tsx` and resolves the closest
`loading.tsx` at or above it (route groups count as segments, as they do for
Next). Each page must satisfy exactly one of:

1. its own segment has a `loading.tsx`; or
2. it appears in `FALLBACK_ROUTES` (in the test file) with the kind it
   deliberately uses, and that kind matches the filesystem:
   - `'group'` — the closest `loading.tsx` is its route group's root one
     (`(teacher)/loading.tsx`); an entry whose closest boundary is anything
     else fails, naming that file, because the page would actually show a
     sibling's skeleton;
   - `'none'` — no `loading.tsx` covers it.

Two more failures keep the allowlist honest in the other direction: an entry
naming no existing page (stale), and an entry for a page that has its own
`loading.tsx` (redundant). The route list is derived from the filesystem;
the allowlist is the only hand-written list, and the test fails both ways
when it disagrees with the tree.

**The import ban (gate: worth its cost?).** Yes — it is one more assertion in
the same walk: no `loading.tsx` imports `@/components/ui/skeleton`. Without it
the rule in D1 is a convention a loading file can quietly break by drawing one
`h-32` block; with it the only way to put a shape on screen is through a
primitive. Cost: zero new tooling.

Proof that it bites (plan step): add a throwaway `(teacher)/zz-probe/page.tsx`,
watch the test go red naming it, remove it; likewise an allowlist entry with
the wrong kind, a stale entry, and a raw import.

### D5 — The geometry e2e

**The issue's mechanism was measured before relying on it** (a throwaway
spike, Next 16.3.4, `/students`, `/inbox`, `/settings`, both Playwright
projects):

| Mode | `page.route` holding the navigation fetch | In-page `fetch` wrapper (below) |
|---|---|---|
| production build (CI) | 30/30 **only after the target's loading-boundary prefetch has settled**; 2 of 7 failed when clicking before it landed | 30/30 |
| `next dev` (every local run) | **0/N** — dev never prefetches (`createPrefetchURL`, the viewport observer and `Link`'s hover handler are all dev-gated), so the boundary only arrives inside the navigation response, and holding that response hides it too | 30/30 |

So the issue's premise — that holding the RSC request shows the skeleton — holds
in production and fails in dev. **Gate: prod-only `page.route` with a dev
skip, or one wrapper that works in both?** Taking the wrapper. A test that
skips itself on every local run gives the author no signal until CI; the
wrapper gives the same signal in both places, through one code path.

The wrapper (installed with `addInitScript`) wraps `window.fetch`, and only
when armed, for the target path, and for a navigation fetch — `rsc: 1` with
neither `next-router-prefetch` nor `next-router-segment-prefetch` (the
`_rsc` query value is a hash and identifies nothing). It reads the response
and re-serves it as a stream that withholds part of it until `release()`:

- **dev:** the root row carries `"type":"page","pagePath":…,"children":"$<id>"`
  (a dev-only wrapper element); withholding the `<id>:` line suspends the
  page's boundary, so `loading.tsx` renders;
- **prod:** that marker is absent, so it withholds the whole body; the
  prefetched boundary renders. The spec waits for the target's
  loading-boundary prefetch first (`next-router-prefetch: 1` without
  `next-router-segment-prefetch`), listening for `requestfinished` **and**
  `requestfailed` — that prefetch usually ends `net::ERR_ABORTED` even when
  it worked — armed before `goto`. Dev vs prod is detected by
  `nextjs-portal` in the DOM.

**It depends on Next's internal response format, and fails loudly when that
changes:** if a Next upgrade moves the dev marker, the wrapper withholds
nothing, no `aria-busy` skeleton appears, and the spec goes red at that
assertion. It cannot pass vacuously, because every measurement is preceded by
an assertion that the skeleton is on screen.

**What it measures.** Two anchors, read from the skeleton and then from the
loaded page: `data-layout-anchor="header"` on the header frame (set inside
`PageHeader`'s and `ScheduleHeader`'s frames, so the skeleton inherits it), and
`data-layout-anchor="first-item"` on the first block below the header (set
per page and per `loading.tsx`, because what comes first is page-specific: the
schedule's first week section, the students page's announcement block, the
inbox list, the settings row list). Asserted: header top and height, and
first-item top, each within **2px**. Routes: the four tab roots, entered by
clicking the tab bar from `/schedule` (and, for `/schedule` itself, from
`/inbox`). The fixture teacher has onboarding complete and the install card
dismissed, since those blocks are conditional and the skeleton cannot know
about them — recorded in the spec file as what the check does not cover.
Each test asserts the skeleton was visible before measuring, so a route that
stopped showing one fails rather than comparing the page with itself.

### D6 — Documentation

A "Loading states" section in `docs/design-brief.md`: static sand, no shimmer;
skeletons compose primitives (D1); every route's loading state is a recorded
choice (D3), with a pointer to the coverage test and to the geometry e2e. The
`Skeleton` docblock stops claiming "matching the layout it replaces" and says
it is a content placeholder inside a primitive's frame, pointing at that
section.

## Out of scope

Motion or shimmer; delay-before-show tuning; any visual change to a real page;
student-side skeletons (D3).
