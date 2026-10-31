# Share your schedule — website embed and calendar feed (#916)

## Intent

Most independent teachers already have a website and keep a second, hand-made
copy of their schedule on it, which goes stale. This lets a teacher put their
live fair.yoga schedule on their own site, and gives students a calendar feed
they can subscribe to. fair.yoga stays in the background — "a utility, not a
marketplace": students find the teacher on the teacher's own site.

Two channels, one switch, one key:

- **Website embed** — a script widget (`<fair-yoga-schedule>`) the teacher
  pastes into their site. Schedule only; each bookable class links to the
  existing booking page in a new tab.
- **Calendar feed** — an `.ics` URL. Students subscribe in their calendar app;
  it is also the fallback for site builders that strip `<script>`.

## Goals

- A teacher can show their upcoming schedule on any website with one pasted
  snippet, and it stays current without them touching it again.
- Students can subscribe to a teacher's schedule in their calendar app.
- Nothing about a teacher is public through these channels until the teacher
  turns sharing on.
- A teacher's classes they teach for a studio can appear too, when the teacher
  chooses, with a link to the studio's own booking page.

## Non-goals (v1)

- **Filters** (class type, location). Dropped in the design conversation: both
  fields are free text on studio classes, so a name-matched filter silently
  loses classes after a rename, and a filter key would be another permanent
  public field. Added when a teacher asks.
- **Version pinning / SRI.** One auto-updating `v1.js`; a frozen per-release
  file with a published hash is a possible far-future addition.
- **An iframe.** Built only if teachers on locked-down builders ask and the
  feed does not meet their need.
- **A personal "my bookings" feed** for students. Different feature (private,
  one key per student).
- **A feed link on `/bookings`.**
- **schema.org `Event` JSON-LD.** *(Builder's/design call, not discussed.)* The
  public JSON carries no structured address field (a studio class's location is the teacher's own free text), and `Event` without a location address is of
  little use; leave it out of v1 rather than ship it half-filled.
- **Showing studio classes on `/[slug]`.** `/[slug]` stays the page of classes
  booked through fair.yoga.

## Anti-goals

- The app becoming frameable. `X-Frame-Options: DENY` and
  `frame-ancestors 'none'` stay exactly as they are.
- Cookies, tracking, or third-party loads from the widget. A teacher must need
  no cookie banner because of it — tested, not intended.
- A public response rich enough to be worth scraping.
- A private class (#910), a video link (#911), or a price appearing in any
  public channel.
- Scarcity nudges ("3 spots left") — the project rules out attention-economy
  patterns.

## What the issue got right, and what it got wrong

Measured on `main` at `4b1d14fb`.

**Held:**

- The app is unframeable: `X-Frame-Options: DENY` in `next.config.ts:7` and in
  both server blocks of `deploy/nginx.conf.example`; `frame-ancestors 'none'`
  in `src/lib/csp.ts` (page and API policies).
- The public listing is one query, `prisma.class.findMany` in
  `src/app/(public)/[slug]/page.tsx:59`, already filtering `isPrivate: false`
  and `cancelledAt: null`. The #910 spec records that no ICS feed, embed or
  sitemap exists. Extracting this query into one service is the right base.
- Nothing sets `Cross-Origin-Resource-Policy`, so a cross-origin `<script src>`
  load of the widget works without header changes.

**Wrong or incomplete:**

1. *"No price, because prices are calculated after the class."* `/[slug]`
   already shows an honest per-tier estimate (`ClassPriceLine` /
   `resolvePriceLine`). The decision (no amount) stands, for other reasons:
   the estimate moves with every booking while the embed is cached, a price
   field in a permanent public API binds every future pricing change, and the
   estimate needs the tier explainer that lives on the booking page.
2. *`s-maxage` + `stale-while-revalidate`.* Those govern a shared cache, and
   there is none: no CDN, and nginx's `location /` does not cache. As written
   they would do nothing for the VPS. The cache is in-process instead (below).
3. *Booking link `/[slug]/book`.* The booking page is per class:
   `/[slug]/book/[classId]`.
4. *Studio opt-in "per template".* A manually logged studio class has no
   template and could never opt in. Superseded anyway — see Studio classes.
5. *Feed at `/[slug]/schedule.ics`.* Slugs are editable
   (`src/app/api/teachers/[id]/route.ts:55`) and no slug history exists, so a
   slug-keyed feed silently stops updating in every subscriber's calendar when
   the teacher renames. Keyed by a stable public key instead.
6. *The rate limiter.* One already exists (`src/lib/rate-limit.ts`:
   in-memory sliding log on `globalThis`, per-prefix buckets, IP-keyed via
   `clientIp`). It counts hits per key; the per-IP *distinct-teacher* limit
   below needs a small addition beside it.
7. *Not in the issue:* `/[slug]` lists a class whose start has passed until the
   status sweep moves it off `open` (`addToWaitlist` documents the same gap,
   `src/services/waitlist.ts:397`), and booking it then fails. The shared
   service lists only classes not yet started, which fixes `/[slug]` too.
8. *Not in the issue:* `embed` and `feed` are top-level paths and are not in
   `RESERVED_SLUGS` (`src/lib/reserved-slugs.ts`). A static segment beats
   `(public)/[slug]`, so both must be reserved, and the reserved-slug deploy
   gate (`scripts/check-reserved-slugs.ts`) will refuse a deploy while any
   teacher holds either.

## Design

### One switch, one key — "Share your schedule"

- New `Teacher.scheduleShareKey`: nullable, unique, a random URL-safe string
  (≥128 bits from `node:crypto`). **Null means sharing is off**, and then
  neither channel exists for that teacher — the endpoints answer 404, exactly
  as for an unknown key.
- Turning sharing on generates the key. Turning it off nulls it. Turning it
  back on generates a **new** key (old pasted snippets stay dead). *(Builder's
  call: whether off→on reuses is not discussed; new is the safer reading of
  "off".)*
- **Reset key** replaces the key in one step. It exists for sites the teacher
  can no longer edit; the old key, old snippets and old feed URL all die.
- Teacher erasure nulls the key (in the same place `pageSlug` is renamed), and
  every public read also refuses a `deletedAt` teacher — never rely on the key
  alone, the same rule `/[slug]` follows.
- The key is not secret — it sits in the page source of the teacher's site —
  but it is unguessable, which is what the distinct-teacher rate limit relies
  on (a scraper's only source of keys is the sites themselves).

### Settings saved on the server

On `Teacher`, applying to **both** channels:

- `scheduleShareWeeks` — 1–4, default 4 (DB `CHECK`). The window the embed and
  feed list. Capped at 4 because recurring classes are generated four weeks
  ahead; a longer window would show only one-offs past week 4 and make the
  schedule look empty. (A one-off further out appears on `/[slug]` but not in
  the embed until it is inside the window — accepted.)
- `scheduleShareStudio` — boolean, default false. Whether studio classes are
  included. **This is the privacy gate**: when false, the server never returns
  a studio class through either channel, whatever the request asks.

### Studio classes

- Shown in the embed and the feed only, when `scheduleShareStudio` is on. Never
  on `/[slug]`.
- New optional `bookingUrl` on `StudioClassTemplate` and `StudioClass`,
  https-only, validated with the existing `parseHttpsLink`
  (`src/lib/payment-link.ts`) the way `videoUrl` is. It is a template field
  like any other: stamped onto each `StudioClass` at generation
  (`src/services/studio-class-generator.ts`), editable per class, and a
  template edit reaches only classes generated afterwards ("a template is a
  stamp", #194). A past studio class is an income record and its `bookingUrl`
  is not writable — the existing editability gate already refuses any field
  but `studentCount`/`cancelledAt` there (#276).
- In the embed: "at <location>" with a "Book ↗" link to `bookingUrl` when set,
  no link when not. No availability, no pricing label.

### The listing service

`src/services/` gains the one public listing function (name is the builder's).
Typed input: teacher id, window, which families, whether to include cancelled.
Typed output: entries of both families. `/[slug]`, the JSON endpoint and the
feed all call it, so `isPrivate` and every future visibility rule apply to all
channels at once.

Rules it owns:

- Regular classes: `isPrivate: false`, live entry (`cancelledAt: null`) unless
  the caller asks for cancelled ones. `videoUrl` is never read (`omit`), and
  locations go through `publicClassLocation`, whose type cannot hold a link.
- **Two windows, one function** *(design call, after the builder check)*:
  - *Bookable* (`/[slug]`, embed): `status: 'open'`, **start not yet passed**.
  - *Calendar* (feed): from the start of the teacher's today, any of `open`,
    `in_progress`, `completed` — a class that started this morning stays in
    subscribers' calendars rather than vanishing at its start time. Cancelled
    entries likewise stay until their date has passed.

  The window is part of the typed input (a discriminated mode, not two
  functions), so the visibility rules — `isPrivate`, liveness, the studio gate —
  still live in exactly one place.
- Studio classes: only when asked (the routes pass `scheduleShareStudio`; `/[slug]`
  never asks).
- Availability uses the same seat count `/[slug]` does today (charged
  registrations excluding `late_cancel`, against `maxStudents`).

`/[slug]` keeps its own presentation (price lines, the signed-in student's
booked/waitlist marks); only the query moves.

### Cancelled classes

- **Embed and `/[slug]`:** hidden.
- **Feed:** kept, with `STATUS:CANCELLED`, until their date has passed — a
  subscribed calendar then shows the class struck through rather than silently
  deleting it.

### Public JSON — `GET /api/public/v1/schedule/[key]`

Deliberately lean; every field is permanent (additions are fine in v1,
removals and renames are not).

```jsonc
{
  "timezone": "Europe/Amsterdam",
  "classes": [{
    "id": "…",                                  // class / studio class id
    "kind": "class",                            // "class" | "studio"
    "start": "2026-11-03T19:00:00+01:00",       // teacher's local time, with offset
    "durationMinutes": 75,
    "classType": "Vinyasa",
    "location": { "format": "in_person", "name": "Studio 2 at De Pijp" },
    "availability": "open",                     // "open" | "waitlist"; null for studio
    "pricing": "tiered",                        // "tiered" | "donation"; null for studio
    "bookingUrl": "https://fair.yoga/anna/book/…" // studio: its bookingUrl or null
  }]
}
```

`location` *(design call, after the builder check)*: `format` is
`"in_person" | "online"`. In person, `name` is the same label `/[slug]` shows —
`formatRoomLocation(roomName, venueName)` (`src/lib/format.ts`), i.e.
"Studio 2 at De Pijp", or the venue alone when the room has no name. Online,
`name` is `null`. A studio class is `in_person` with `name` = its free-text
`location`; `kind: "studio"` already says it is a studio class, so `format`
gains no third value.

Decided out: amounts, spots left, teacher name, bio, photo, structured address field (a studio class's location is the teacher's own free text).
"waitlist" rather than "full": a full class always takes waitlist sign-ups
until it starts (`addToWaitlist` refuses only cancelled, not-open, started, or
not-full), and the listing excludes started classes.

Booking URLs are built from the teacher's **current** slug, so a slug change
never breaks a pasted embed. Times render in the teacher's timezone for every
visitor (a local schedule).

Response: `Access-Control-Allow-Origin: *`, GET only, no credentials honoured,
`Cache-Control: public, max-age=60`. Refusals (404, 429) carry the CORS header
too, or the browser hides them from the widget.

### Feed — `GET /feed/[key].ics`

- Same service in its *calendar* window (see The listing service): same weeks
  and studio setting, events from the start of the teacher's today including
  classes already started or completed, and cancelled entries marked
  `STATUS:CANCELLED` until their date passes.
- `UID` stable per calendar entry; times in UTC; `URL` = booking URL; the
  pricing label in `DESCRIPTION`; no amounts, no video link.
  `SEQUENCE`/`DTSTAMP` such that a moved class updates in place. *(Details are
  the builder's.)*
- The calendar name is "{firstName}'s schedule". An exception to "no teacher
  name on public channels": the name is already on `/[slug]`, which links the
  feed, and a neutral name would make several subscribed teachers
  indistinguishable in a calendar app. *(Build-time ruling.)*
- `webcal://` for one-click subscribe links; the settings page shows the
  `https://` form for copying. *(Builder's call.)*

### Cache and rate limits

- **In-process response cache**, ~60 s per key, bounded size, LRU — on
  `globalThis` per the process-wide-state rule (CLAUDE.md; the census test
  enforces it). Busting on writes is not required; 60 s staleness is accepted.
- **JSON endpoint, per IP:** at most ~10 **distinct teacher keys** per hour,
  and ~60 requests per minute. A visitor views one teacher; a scraper walks
  many. Both generous because many people share an IP (mobile carriers,
  offices, schools). The distinct-key count is a small addition beside
  `rate-limit.ts`, also on `globalThis`, bounded.
- **Feed: no distinct-teacher limit.** Calendar services (Google, Apple) fetch
  every subscriber's feeds from a few shared addresses; a distinct-teacher cap
  would cut off every Google Calendar subscriber at once. The feed gets the
  cache and only a high per-IP flood limit. *(Builder's call on numbers.)*

The numbers above are starting values, not decided limits.

### The widget — `/embed/v1.js`

- One small TypeScript file, no runtime dependencies, compiled to a single
  script. *(Builder's call how; preferably with the existing `typescript`
  compiler rather than a new build dependency — see `docs/supply-chain.md`.)*
  Served with a short cache (~1 h), no SRI, always the latest v1. Loaded as
  `<script type="module">` (deferred by default; `import.meta.url` gives the
  fair.yoga origin), so `/embed/v1.js` also sends
  `Access-Control-Allow-Origin: *` — module scripts are fetched in CORS mode.
  *(Planning call.)*
- `<fair-yoga-schedule key="…" theme="themed|unstyled" color-scheme="light|dark|auto">`.
- `fetch` with `credentials: 'omit'`; sets no cookies or storage; loads nothing
  else. A test proves it.
- **themed** — fair.yoga look inside a shadow DOM; a small fixed set of custom
  properties (`--fy-accent`, `--fy-font`) can be overridden. `color-scheme`
  applies here only. The look is the mockup's (A light, B dark): **plain rows,
  not the app's class cards** — no progress bar, no status badges — sand-soft
  row with a 1px border, teal tabular time, Georgia day headings, a bordered
  "Book ↗" (gold-tint "Waitlist ↗"), studio rows dashed and transparent. The
  app has no dark tokens; the widget defines its own small dark set (the
  mockup's values are a starting point). It ships its own CSS — it cannot
  import `globals.css`.
- **unstyled** — semantic list markup with stable class names in the light DOM,
  no CSS of ours; the host site styles it. `color-scheme` is ignored (and
  documented as such) since a teacher can hand-edit the snippet.
- Rows: day headings; time, class type, location, duration, pricing label
  ("Income-based" / "Pay what you can"); a "Book ↗" or "Waitlist ↗" link
  (`target="_blank" rel="noopener noreferrer"`, with announced "opens in a new tab").
  Booking always opens fair.yoga in a new tab — magic links and passkeys cannot
  work inside someone else's page.
- **Footer:** a subtle "Schedule by fair.yoga" (the wordmark — Georgia, teal
  dot — muted, linking to fair.yoga; plain text in unstyled) and an "Add this
  schedule to your calendar" link to the feed.
- The snippet carries a `<noscript>`-style fallback link inside the element to
  `/[slug]`. *(Known gap: that link is slug-based and breaks on a slug change;
  accepted for v1.)*
- On a fetch failure — sharing turned off, key reset, network error — the
  widget leaves the element's own fallback link in place (the snippet's "See my
  schedule" link to `/[slug]`), so a dead key degrades to that link and not to
  an empty box. The JSON's 404 carries no slug, which is why the link must come
  from the snippet. An empty schedule renders a calm one-line note. *(Builder's
  call on copy.)*

### `/[slug]`

- Uses the shared service (no visible change except started classes dropping
  off).
- When sharing is on: a quiet "Subscribe to <first name>'s schedule" link to
  the feed under the class list. The page shows only fair.yoga classes; the
  feed it links to may also contain studio classes. Accepted: the page and the
  feed are separate channels the teacher chose.

### Teacher UI — Settings → Share your schedule

Approved mockup (v2): `2026-10-30-share-your-schedule-mockup.html`, next to
this spec — open it in a browser. It predates two decisions: the page title
there is "Website embed" (now **Share your schedule**), and the Reset copy is
the older line (use the copy below). New settings page, linked from the
Settings index.

- **Off:** what it is, and a "Turn on" button.
- **On:**
  - Card **"Your schedule"** — "Saved for all your embeds and your calendar
    feed": Weeks ahead (1–4), Show studio classes.
  - Card **"Look"** — "Only changes the code below": Style (fair.yoga / Your
    site's); Colours (Light / Dark / Auto), **hidden** when "Your site's" is
    picked.
  - Card **Preview** — live; for "Your site's" a bare list with "On your site
    this takes your own fonts and colours."
  - Card **Your code** — the snippet, updating with the Look options; Copy.
  - Card **Calendar feed** — the URL; Copy.
  - **Reset embed key…** — "Takes your schedule off sites you can't edit
    anymore, like an old website or a page someone copied your code to. Your
    own site needs the new code afterwards, and the calendar feed link changes,
    so students who subscribed will need the new link." Confirm step repeats:
    "Students subscribed to your calendar feed will stop getting updates."
  - **Turn off sharing…** — behind a confirm step that spells out all three
    consequences before anything happens:
    > **Turn off sharing?**
    > - Your schedule disappears from every website where you pasted the code.
    >   Visitors see only a link to your fair.yoga page.
    > - Students subscribed to your calendar feed stop getting updates.
    > - If you turn sharing on again, you get new code and a new feed link —
    >   the old ones won't come back.
    >
    > [Keep sharing] [Turn off]

    "Keep sharing" is the default focus; "Turn off" is the danger-styled
    button (danger outline/text, per the design system).
- Studio class template form and studio class form gain an optional
  "Booking page" URL field.

## Constraints

- Single 2 GB VPS, single process: in-process cache and limits, no new
  services.
- `docs/supply-chain.md` covers the widget: every teacher's site loads it.
- Schema changes by migration; the `scheduleShareWeeks` CHECK is hand-authored
  (`prisma/migrations/20260721061528_student_claim_link_check/` pattern).
- Reserve `embed` and `feed` in `RESERVED_SLUGS`; the deploy gate checks no
  teacher holds them.
- Refusal codes registered in `src/lib/api-error-codes.ts` where a 409 is
  involved; turning sharing on when already on answers `respondUnchanged`.

## Must be tested

- A private class, a cancelled class (JSON/`/[slug]`), a started class, and a
  studio class with `scheduleShareStudio` off never appear in a public channel.
- No `videoUrl` and no amount appear in either channel.
- Cancelled entries appear in the feed with `STATUS:CANCELLED` until their date.
- Sharing off, unknown key, reset (old key) and erased teacher all 404.
- CORS header present on 200, 404 and 429.
- Distinct-teacher limit trips on the JSON endpoint and not on the feed.
- The widget sends no credentials and sets no cookies/storage.
- `bookingUrl` stamps from template to generated class, rejects non-https.
- `embed` and `feed` are refused as slugs.
