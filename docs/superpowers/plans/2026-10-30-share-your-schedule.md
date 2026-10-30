# Share Your Schedule Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A teacher turns on "Share your schedule" and gets a script widget for their own website and an `.ics` calendar feed, both keyed by a resettable public key and fed by one listing service that `/[slug]` also uses.

**Architecture:** One service (`src/services/public-schedule.ts`) decides what is public, in two windows (bookable, calendar). Two thin public routes serialize it — JSON under `/api/public/v1/` with CORS, and `/feed/<key>.ics` — behind an in-process cache and per-IP limits. The widget is one dependency-free TypeScript module compiled with `tsc` to `public/embed/v1.js`; the settings page imports the same module for its live preview.

**Tech Stack:** Next.js 16 App Router, TypeScript strict, Prisma/PostgreSQL, Vitest (unit/integration/components), Playwright.

**Spec:** `docs/superpowers/specs/2026-10-30-share-your-schedule-design.md` (mockup: `docs/superpowers/specs/2026-10-30-share-your-schedule-mockup.html`)

## Global Constraints

- Sharing is off when `Teacher.scheduleShareKey` is null; every public read also refuses a teacher with `deletedAt` set.
- `scheduleShareWeeks` is 1–4, default 4. `scheduleShareStudio` defaults to false and is the server-side gate for studio classes in both channels.
- No public channel ever carries: a private class (`isPrivate`), a `videoUrl`, an amount, spots left, teacher name/bio/photo, an address.
- JSON availability values are `"open" | "waitlist"`; pricing values `"tiered" | "donation"`; both `null` for studio classes.
- Every JSON response, including 404 and 429, carries `Access-Control-Allow-Origin: *`.
- JSON endpoint per-IP limits (starting values): 10 distinct keys per hour, 60 requests per minute. Feed: no distinct-key limit, per-IP flood limit 600/min.
- Response cache: ~60 s per key, bounded, on `globalThis` (`process-state-census.test.ts` enforces this).
- Widget: no runtime dependencies, `fetch` with `credentials: 'omit'`, sets no cookies/storage, renders text with `textContent` only, booking links `target="_blank" rel="noopener"` with announced "opens in a new tab".
- `/embed/v1.js` is an ES module loaded with `<script type="module">`, served with `Cache-Control: public, max-age=3600` and `Access-Control-Allow-Origin: *`, no SRI.
- Copy fixed by the spec: "Schedule by fair.yoga", "Add this schedule to your calendar", "Income-based", "Pay what you can", "Book ↗", "Waitlist ↗", the Reset and Turn-off texts in the spec's Teacher UI section.
- Schema changes go through `pnpm exec prisma migrate dev --name <name>`; CHECKs are hand-appended to the generated migration before it is applied.
- Stage exact paths; quote `(public)`, `(teacher)` paths.
- Every guard gets a break-it step: mutate, record the exact failure text in the commit body or ledger, restore, re-run green.

## Review Focus

1. **A teacher outside UTC across a DST change** — a class in the week clocks change must carry the right UTC offset in JSON `start` and the right UTC instant in the feed. Test in Task 6 and Task 7.
2. **Text that looks like HTML** — a class type or studio location of `<img src=x onerror=alert(1)>` must render as literal text in both widget modes, and commas/semicolons/newlines must be escaped in the feed. Tests in Task 7 and Task 8.
3. **The script included twice on one page** (two embeds, or a site builder that duplicates it) — must not throw on `customElements.define`; both elements render. Test in Task 8.
4. **Day grouping in the teacher's timezone** — a 23:30 class viewed from a visitor in another timezone sits under the teacher's date, not the visitor's. Test in Task 8.
5. **Slug change after the snippet is pasted** — JSON booking URLs follow the current slug. Test in Task 6.

---

### Task 1: Data model, reserved paths, erasure

**Files:**
- Modify: `prisma/schema.prisma` (`Teacher`, `StudioClassTemplate`, `StudioClass`)
- Create: `prisma/migrations/<timestamp>_schedule_share/migration.sql` (generated, plus hand-appended CHECK)
- Modify: `src/lib/reserved-slugs.ts` (add `'embed'`, `'feed'` under "Routes the app has today" — they become routes in Tasks 6–8)
- Modify: `src/services/gdpr.ts` (teacher erasure write near the `pageSlug: \`deleted-${teacherId}\`` update)
- Modify: `docs/data-model.md` (the five new fields, one line each, with why)
- Test: `tests/integration/schedule-share-schema.test.ts`, existing `src/lib/schemas.test.ts`, existing GDPR erasure test (find with `grep -rln "deleted-" tests/integration src/services/*.test.ts`)

**Interfaces:**
- Produces: `Teacher.scheduleShareKey String? @unique`, `Teacher.scheduleShareWeeks Int @default(4)`, `Teacher.scheduleShareStudio Boolean @default(false)`, `StudioClassTemplate.bookingUrl String?`, `StudioClass.bookingUrl String?`; DB constraint `Teacher_schedule_share_weeks_range` = `CHECK ("scheduleShareWeeks" BETWEEN 1 AND 4)`.

- [ ] **Step 1: Write failing tests**
  - `schedule-share-schema.test.ts`: updating a teacher's `scheduleShareWeeks` to `0` and to `5` rejects with an error naming `Teacher_schedule_share_weeks_range`; `4` succeeds; a fresh teacher reads `scheduleShareKey === null`, `scheduleShareWeeks === 4`, `scheduleShareStudio === false`.
  - `schemas.test.ts`: `pageSlugField` refuses `'embed'` and `'feed'` with "That address is reserved."
  - Erasure test: a teacher with `scheduleShareKey = 'k'` reads `scheduleShareKey === null` after erasure.
- [ ] **Step 2: Run, verify they fail** — `pnpm exec vitest run --project unit src/lib/schemas.test.ts` and `pnpm exec vitest run --project integration tests/integration/schedule-share-schema.test.ts`. Expected: FAIL (unknown field / slug accepted).
- [ ] **Step 3: Implement** — schema fields; `prisma migrate dev --create-only --name schedule_share`, append the CHECK, then `prisma migrate dev`; reserve the two slugs; erasure sets `scheduleShareKey: null` in the same update that renames `pageSlug`.
- [ ] **Step 4: Run, verify pass** (same commands, plus the erasure test file).
- [ ] **Step 5: Break it** — (a) in `psql` on the dev DB, `ALTER TABLE "Teacher" DROP CONSTRAINT "Teacher_schedule_share_weeks_range"`, run the schema test, record the failure, then restore with the migration's own `ADD CONSTRAINT` statement and confirm `pnpm run check-migrations` is clean; (b) remove `'feed'` from `RESERVED_SLUGS`, run `schemas.test.ts`, record, restore; (c) remove the `scheduleShareKey: null` line, run the erasure test, record, restore.
- [ ] **Step 6: Run `pnpm exec prisma migrate status` and `pnpm run check-migrations`** — expected clean.
- [ ] **Step 7: Commit** — `feat: schedule-share fields, studio bookingUrl, embed/feed reserved (#916)`

### Task 2: Studio `bookingUrl` — validation, API, stamping, forms

**Files:**
- Modify: `src/lib/schemas.ts` (four studio schemas at ~774–815; add `bookingUrlField` beside `videoUrlField`)
- Modify: `src/lib/payment-link.ts` (add `BOOKING_LINK_MESSAGES`, same shape as `VIDEO_LINK_MESSAGES`)
- Modify: `src/services/studio-class-generator.ts` (stamp `bookingUrl: template.bookingUrl` beside `location`)
- Modify: the studio template and studio class create/update routes under `src/app/api/studio-class-templates/` and `src/app/api/studio-classes/` and the services they call, so the field is persisted
- Modify: `src/components/settings/studio-template-form.tsx`, `src/components/studio-class/studio-class-edit-form.tsx`, and the `/studio-class/new` form (label "Booking page", optional, hint "Where students book this class with the studio")
- Test: `src/lib/schemas.test.ts`, `tests/integration/studio-api.test.ts`, the generator's test file (`grep -ln studio-class-generator src/services/*.test.ts`)

**Interfaces:**
- Produces: `bookingUrlField(): ZodType<string | null | undefined>` — trims, `''` → `null`, otherwise `parseHttpsLink(raw, BOOKING_URL_MAX)`; `BOOKING_URL_MAX = VIDEO_URL_MAX`.

- [ ] **Step 1: Write failing tests**
  - schemas: `createStudioClassTemplateSchema` accepts `bookingUrl: 'https://studio.example/book'`, maps `''` to `null`, rejects `'http://studio.example'` and `'javascript:alert(1)'` with the `not_https` / `invalid` messages.
  - generator: a template with `bookingUrl` set generates classes carrying it; changing the template's `bookingUrl` afterwards leaves already-generated classes' `bookingUrl` unchanged.
  - studio-api: PUT a past studio class with `{ bookingUrl }` is refused like any other gated field; PUT a future one persists it.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** the field, persistence, stamping and form inputs.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Break it** — remove the stamping line, run the generator test, record; restore. Swap `parseHttpsLink` for a plain `z.string().url()`, run schemas test (the `http://` and `javascript:` cases must fail), record; restore.
- [ ] **Step 6: Commit** — `feat: studio classes carry an optional booking URL (#916)`

### Task 3: The listing service

**Files:**
- Create: `src/services/public-schedule.ts`
- Test: `src/services/public-schedule.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type PublicScheduleMode =
    | { kind: 'bookable'; weeks: number | null }   // null = no upper bound (/[slug])
    | { kind: 'calendar'; weeks: number };
  export type PublicScheduleInput = {
    teacherId: string; timeZone: string; now: Date;
    mode: PublicScheduleMode; includeStudio: boolean;
  };
  export type PublicClassEntry = {
    kind: 'class'; id: string; calendarEntryId: string; updatedAt: Date;
    date: Date; startTime: Date; start: Date; durationMinutes: number; classType: string;
    location: PublicClassLocation; pricingMode: PricingMode;
    availability: 'open' | 'waitlist'; cancelled: boolean;
    economics: { roomCost: number; minRate: number; targetRate: number;
      minStudents: number; maxStudents: number; vatPercent: number; currency: Currency;
      registrations: { id: string; tierAtBooking: number; status: RegistrationStatus; studentId: string }[] };
  };
  export type PublicStudioEntry = {
    kind: 'studio'; id: string; calendarEntryId: string; updatedAt: Date;
    date: Date; startTime: Date; start: Date; durationMinutes: number; classType: string;
    location: string; bookingUrl: string | null; cancelled: boolean;
  };
  export type PublicScheduleEntry = PublicClassEntry | PublicStudioEntry;
  export function listPublicSchedule(db: PrismaClient, input: PublicScheduleInput): Promise<PublicScheduleEntry[]>;
  ```
  `economics` exists only so `/[slug]` can keep its price line; the JSON and feed serializers never read it. Sorted by `start` ascending.

Rules (spec, The listing service): class rows `isPrivate: false`, `omit: { videoUrl: true }`, location via `publicClassLocation`. **bookable**: `status: 'open'`, `cancelledAt: null`, `start > now`, date `< today + weeks*7` when `weeks` is set. **calendar**: status in `open | in_progress | completed`, date `>= teacher's today` and `< today + weeks*7`, cancelled included with `cancelled: true`. Studio rows only when `includeStudio`, same windows (studio has no status). Availability: charged registrations excluding `late_cancel` `>= maxStudents` → `'waitlist'`.

- [ ] **Step 1: Write failing tests** (one fixture teacher; `now` injected), asserting by id membership:
  - private class absent in both modes;
  - cancelled class absent in bookable, present with `cancelled: true` in calendar;
  - class started 10 minutes before `now`, still `open`: absent in bookable, present in calendar; a `completed` class earlier today present in calendar only;
  - class dated today + 28 days absent with `weeks: 4`, present with `weeks: null`;
  - studio class absent with `includeStudio: false`, present (with `bookingUrl`) with `true`;
  - full class reads `'waitlist'`; a class whose only extra registration is `late_cancel` reads `'open'`;
  - no returned object has a `videoUrl` key at any depth (walk the object).
- [ ] **Step 2: Run, verify fail** — `pnpm exec vitest run --project unit src/services/public-schedule.test.ts`.
- [ ] **Step 3: Implement.** Compute `start` with `classStartInstant`, today with `startOfLocalDay`.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Break it**, one at a time, record each failure, restore: drop `isPrivate: false`; drop `cancelledAt: null` from bookable; drop the `start > now` filter; drop the `includeStudio` check; remove `omit: { videoUrl: true }` and `publicClassLocation` (spread the row instead).
- [ ] **Step 6: Commit** — `feat: one public listing service, bookable and calendar windows (#916)`

### Task 4: `/[slug]` uses the service

**Files:**
- Modify: `src/app/(public)/[slug]/page.tsx` (replace the `class.findMany` at :59 with `listPublicSchedule(prisma, { mode: { kind: 'bookable', weeks: null }, includeStudio: false, … })`, filter to `kind === 'class'`, read `economics` for `resolvePriceLine`)
- Test: `tests/integration/public-teacher-page.test.ts` (create; or extend an existing `/[slug]` test if `grep -rln "book/" tests/integration` finds one)

**Interfaces:** Consumes `listPublicSchedule` (Task 3).

- [ ] **Step 1: Failing test** — GET `/<slug>` HTML does not contain the class type of a class whose start passed 10 minutes ago (still `open`); does contain an upcoming one.
- [ ] **Step 2: Verify fail. Step 3: Implement. Step 4: Verify pass** (warm the route with one curl first).
- [ ] **Step 5: Break it** — pass `mode: { kind: 'calendar', weeks: 4 }`; the started class reappears; record; restore.
- [ ] **Step 6: Commit** — `refactor: /[slug] lists through the public schedule service (#916)`

### Task 5: Turning sharing on/off, reset, settings

**Files:**
- Create: `src/services/schedule-share.ts`
- Create: `src/app/api/account/schedule-share/route.ts` (`GET`, `POST` turn on, `PATCH` settings, `DELETE` turn off)
- Create: `src/app/api/account/schedule-share/reset/route.ts` (`POST`)
- Modify: `src/lib/schemas.ts` (`updateScheduleShareSchema = z.object({ weeks: z.number().int().min(1).max(4).optional(), includeStudio: z.boolean().optional() }).strict()`)
- Test: `src/services/schedule-share.test.ts`, `tests/integration/schedule-share-api.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ScheduleShareState = { key: string | null; weeks: number; includeStudio: boolean };
  export function mintScheduleShareKey(): string; // 16 random bytes, base64url
  export function getScheduleShare(db, teacherId): Promise<ScheduleShareState>;
  export function enableScheduleShare(db, teacherId): Promise<{ state: ScheduleShareState; changed: boolean }>;
  export function disableScheduleShare(db, teacherId): Promise<{ state: ScheduleShareState; changed: boolean }>;
  export function resetScheduleShareKey(db, teacherId): Promise<ScheduleShareState>; // refuses when off
  export function updateScheduleShare(db, teacherId, patch: { weeks?: number; includeStudio?: boolean }): Promise<ScheduleShareState>;
  export function teacherByShareKey(db, key: string): Promise<{ id: string; pageSlug: string; firstName: string; defaultTimezone: string; scheduleShareWeeks: number; scheduleShareStudio: boolean } | null>; // null for unknown key or deletedAt
  ```
  Routes: `requireTeacher`; enable/disable answer `respondUnchanged` when `changed` is false; reset when off answers 409 with a new registered code `SCHEDULE_SHARE_OFF` in `src/lib/api-error-codes.ts`.

- [ ] **Step 1: Failing tests** — enable sets a key matching `/^[A-Za-z0-9_-]{22}$/`; enable twice returns the same key, second `changed: false`; disable nulls the key; enable after disable yields a **different** key; reset yields a different key and the old one no longer resolves via `teacherByShareKey`; reset when off refuses with `SCHEDULE_SHARE_OFF`; `teacherByShareKey` returns null for an erased teacher whose key is still set (write it directly); PATCH `weeks: 5` → 400. API test: a student session gets 403 on every verb.
- [ ] **Step 2: Verify fail. Step 3: Implement. Step 4: Verify pass.**
- [ ] **Step 5: Break it** — remove the `deletedAt` check in `teacherByShareKey`; reuse the old key on enable-after-disable; record both; restore.
- [ ] **Step 6: Commit** — `feat: turn schedule sharing on and off, reset its key (#916)`

### Task 6: Cache, limits, and the JSON endpoint

**Files:**
- Create: `src/lib/public-schedule-cache.ts` — `getCachedSchedule<T>(cacheKey: string, now: number, load: () => Promise<T>): Promise<T>`; TTL 60 000 ms, capacity 2 000, LRU, on `globalThis.__fairYogaPublicScheduleCache`.
- Create: `src/lib/distinct-key-limit.ts` — `checkDistinctKeyLimit(ip: string, key: string, now: number): { allowed: boolean; retryAfterSeconds: number }`; 10 distinct keys / 3 600 000 ms per IP; bounded IP capacity 5 000, on `globalThis.__fairYogaDistinctKeyLimits`; a key already seen by that IP in the window never counts again.
- Modify: `src/lib/rate-limit.ts` — prefixes `'public-schedule:ip'` (60/min) and `'schedule-feed:ip'` (600/min) in `RateLimitPrefix`, `PREFIX_CAPACITIES`, and `IpRateLimitPrefix`.
- Create: `src/lib/public-schedule-json.ts` — `toPublicScheduleJson(entries: PublicScheduleEntry[], teacher: { pageSlug: string; timeZone: string }, origin: string): PublicScheduleJson` with the exact v1 type from the spec (`timezone`, `classes[]` of `id, kind, start, durationMinutes, classType, location{format,name}, availability, pricing, bookingUrl`). `start` is ISO 8601 with the teacher's offset (via `formatInstantInZone` or a sibling helper in `src/lib/timezone.ts`); in-person `name` = `formatRoomLocation(roomName, venueName)`; online `name: null`; studio `format: 'in_person'`, `name` = its location; class `bookingUrl` = `${origin}/${pageSlug}/book/${id}`.
- Create: `src/app/api/public/v1/schedule/[key]/route.ts` — GET: IP limit → distinct-key limit → `teacherByShareKey` → cached `listPublicSchedule` (bookable, `weeks: scheduleShareWeeks`, `includeStudio: scheduleShareStudio`) → JSON with `Cache-Control: public, max-age=60`. A helper `withCors(res)` sets `Access-Control-Allow-Origin: *` on every exit path, 404 and 429 included.
- Modify: `docs/technical-architecture.md` — a "Public API (v1)" subsection: the endpoint, its permanence rule (add fields, never remove/rename), the limits and cache.
- Test: `src/lib/public-schedule-json.test.ts`, `src/lib/distinct-key-limit.test.ts`, `src/lib/public-schedule-cache.test.ts`, `tests/integration/public-schedule-api.test.ts`

**Interfaces:** Consumes Tasks 3, 5. Produces `PublicScheduleJson`, `toPublicScheduleJson`, `getCachedSchedule`, `withCors` (export from the route's sibling `src/lib/cors.ts` so Task 7 reuses it).

- [ ] **Step 1: Failing tests**
  - JSON serializer: object keys of a class item equal exactly `['availability','bookingUrl','classType','durationMinutes','id','kind','location','pricing','start']` (sorted); no key named `videoUrl`, `price`, `amount`, `spotsLeft`, `teacher`; a teacher in `America/New_York` with a class on 2026-11-02 19:00 local reads `start: '2026-11-02T19:00:00-05:00'` and one on 2026-10-30 reads `-04:00` (Review Focus 1); after changing `pageSlug`, `bookingUrl` uses the new slug (Review Focus 5).
  - distinct limit: 10 different keys allowed, 11th refused; the same key 50 times counts once; after 3 600 001 ms the window frees.
  - cache: `load` called once for two calls within 60 s, twice after 60 001 ms; capacity eviction drops the least recently used.
  - API: unknown key → 404 with ACAO `*`; sharing off → 404; old key after reset → 404; erased teacher → 404; 200 has ACAO `*` and `Cache-Control: public, max-age=60`; private/started/cancelled classes absent; studio present only with `scheduleShareStudio`; 11 distinct keys from one `freshIp()` → 11th 429 **with** ACAO `*`.
- [ ] **Step 2: Verify fail. Step 3: Implement. Step 4: Verify pass** — unit files and `pnpm exec vitest run --project integration tests/integration/public-schedule-api.test.ts`; also `pnpm exec vitest run --project unit src/lib/process-state-census.test.ts` passes.
- [ ] **Step 5: Break it** — remove `withCors` from the 429 path (API test fails); make the distinct limiter count every hit (same-key test fails); move a holder off `globalThis` to a module `Map` (census fails); record each; restore.
- [ ] **Step 6: Commit** — `feat: public schedule JSON endpoint with CORS, cache and per-IP limits (#916)`

### Task 7: The calendar feed, and its link on `/[slug]`

**Files:**
- Create: `src/lib/ics.ts` — `buildIcs(input: { calendarName: string; events: IcsEvent[]; now: Date }): string`; `IcsEvent = { uid: string; start: Date; durationMinutes: number; summary: string; location: string | null; description: string; url: string | null; cancelled: boolean; sequence: number; lastModified: Date }`. CRLF line endings, lines folded at 75 octets, TEXT escaping of `\ ; , newline`, times as UTC `YYYYMMDDTHHMMSSZ`, `STATUS:CANCELLED` when cancelled, `METHOD:PUBLISH`, `X-WR-CALNAME`.
- Create: `src/app/feed/[file]/route.ts` — `file` must match `/^([A-Za-z0-9_-]+)\.ics$/` else 404; per-IP `'schedule-feed:ip'` limit only (no distinct-key limit); `teacherByShareKey`; cached `listPublicSchedule` in **calendar** mode; `Content-Type: text/calendar; charset=utf-8`, `Cache-Control: public, max-age=60`. UID `<calendarEntryId>@fair.yoga`; `SEQUENCE` = seconds of `updatedAt` since epoch (monotonic per edit); summary = class type; description = pricing label ("Income-based" / "Pay what you can") for classes, empty for studio; url = booking URL (class: current-slug booking page; studio: `bookingUrl`).
- Modify: `src/proxy.ts` matcher — exclude `feed/` and `embed/` (not pages; no nonce needed).
- Modify: `src/app/(public)/[slug]/page.tsx` — when the teacher's `scheduleShareKey` is set, a quiet link under the list: "Subscribe to {firstName}'s schedule" → `webcal://<host>/feed/<key>.ics`.
- Test: `src/lib/ics.test.ts`, `tests/integration/schedule-feed.test.ts`, extend `tests/integration/public-teacher-page.test.ts`

**Interfaces:** Consumes Tasks 3, 5, 6 (`getCachedSchedule`, rate-limit prefix). Produces `buildIcs`, `IcsEvent`.

- [ ] **Step 1: Failing tests**
  - ics: every line ends `\r\n`; a 200-char summary is folded so no line exceeds 75 octets and unfolding restores it; `Hatha; slow, deep\nflow` is escaped `Hatha\; slow\, deep\nflow` (Review Focus 2); a cancelled event carries `STATUS:CANCELLED`; a Europe/Amsterdam 19:00 class on 2026-10-26 (after DST end) reads `DTSTART:20261026T180000Z` (Review Focus 1).
  - feed: 200 with `text/calendar`; a class cancelled for tomorrow appears with `STATUS:CANCELLED`; a class that started an hour ago today appears; a private class never appears; no `videoUrl` value appears in the body; 20 different keys from one IP all answer 200 (no distinct limit); `bad.txt` → 404; sharing off → 404.
  - `/[slug]`: link present iff key set, and the href contains the key.
- [ ] **Step 2: Verify fail. Step 3: Implement. Step 4: Verify pass** (warm `/feed/x.ics` first).
- [ ] **Step 5: Break it** — feed in bookable mode (started/cancelled tests fail); add the distinct-key limit to the feed (20-key test fails); drop escaping (escape test fails); record; restore.
- [ ] **Step 6: Commit** — `feat: .ics calendar feed, linked from the teacher's page (#916)`

### Task 8: The widget

**Files:**
- Create: `src/embed/schedule-widget.ts` — the whole widget, **no imports**, written as an ES module. Exports `defineScheduleElement(opts: { origin: string }): void` (idempotent: returns if `customElements.get('fair-yoga-schedule')`), and `renderSchedule(root: ParentNode, data: PublicScheduleJson, opts: { theme: 'themed' | 'unstyled'; feedUrl: string }): void`. Declares its own copy of the `PublicScheduleJson` type (it cannot import); a type test in Step 1 ties the two together. It does **not** self-define on import, so tests and the settings preview pass their own origin.
- Create: `tsconfig.embed.json` (`files: ["src/embed/schedule-widget.ts"]`, `target: "es2020"`, `module: "es2020"`) and a build script `"build:embed"` that runs `tsc -p tsconfig.embed.json` and writes `public/embed/v1.js` = the compiled module + one appended bootstrap line `defineScheduleElement({ origin: new URL(import.meta.url).origin });`. **No new dependency.**
- **Why a module:** the snippet loads it with `<script type="module" src="…/embed/v1.js">` — deferred by default, and `import.meta.url` gives the fair.yoga origin (`document.currentScript` is null in modules). Module scripts are fetched in CORS mode, so `/embed/v1.js` must send `Access-Control-Allow-Origin: *`.
- Create: `public/embed/v1.js` (committed build output)
- Modify: `next.config.ts` headers — `/embed/:path*` → `Cache-Control: public, max-age=3600` and `Access-Control-Allow-Origin: *`
- Modify: `src/lib/schemas.test.ts` or the reserved-slug test if it enumerates `public/` entries — `embed` is now a real `public/` entry and must be reserved (Task 1 did).
- Modify: `docs/supply-chain.md` — an entry for the widget: served to every teacher's site, built from this repo with `tsc` only, no runtime dependencies, no SRI by decision.
- Test: `src/embed/schedule-widget.test.tsx` (components project, jsdom), `src/embed/build.test.ts` (unit: re-runs the build into a temp dir and asserts byte equality with the committed `public/embed/v1.js`), `tests/e2e/schedule-embed.spec.ts`

Behavior (spec, The widget): attributes `key`, `theme` (`themed` default | `unstyled`), `color-scheme` (`light|dark|auto`, themed only). Themed renders into an open shadow root with its own CSS (mockup A/B values, `--fy-accent`, `--fy-font`), dark via `color-scheme` or `prefers-color-scheme` under `auto`. Unstyled renders `<ol class="fy-schedule">` day groups / `<li class="fy-class">` into the light DOM, no `<style>`. Day headings come from the date part of each `start` string (teacher-local), never from `new Date(start)` in the visitor's zone. Footer: "Schedule by fair.yoga" (link to origin) + "Add this schedule to your calendar" (`webcal://…/feed/<key>.ics`). On fetch failure the element's original children (the snippet's fallback link) stay untouched; render replaces them only on success. Empty list: one line, "No upcoming classes right now."

- [ ] **Step 1: Failing tests**
  - render (both themes): rows show time, class type, location, duration, pricing label; class with `availability: 'waitlist'` shows "Waitlist ↗"; studio with `bookingUrl` shows "Book ↗" linking to it, studio without shows no link; every link has `target="_blank"`, `rel` containing `noopener`, and visually hidden "(opens in a new tab)".
  - a class type `<img src=x onerror=alert(1)>` produces no `img` element and the literal text is present (Review Focus 2).
  - `start: '2026-11-03T23:30:00+01:00'` groups under Tue 3 Nov even with `process.env.TZ`-independent assertion (Review Focus 4).
  - element: `fetch` is called once with `credentials: 'omit'` and URL `<origin>/api/public/v1/schedule/<key>`; after render `document.cookie === ''` and `localStorage.length === 0`; a rejected fetch leaves the original fallback `<a>` in place; `defineScheduleElement` called twice does not throw and two elements both render (Review Focus 3); `color-scheme="dark"` with `theme="unstyled"` adds no style element.
  - type tie: `src/embed/schedule-widget.test.tsx` asserts at compile time that the widget's local type and `PublicScheduleJson` are mutually assignable.
  - build: committed `public/embed/v1.js` equals a fresh build.
  - e2e: a page served from a **different origin** than `BASE_URL` (route a fake host with `page.route`, e.g. `https://teacher.example/`, fulfilling the snippet HTML) renders rows — which proves the CORS headers on both the script and the JSON — and `context.cookies()` is empty afterwards.
- [ ] **Step 2: Verify fail** — `pnpm exec vitest run --project components src/embed/schedule-widget.test.tsx`.
- [ ] **Step 3: Implement**, then `pnpm run build:embed`.
- [ ] **Step 4: Verify pass** — components, `pnpm exec vitest run --project unit src/embed/build.test.ts`, `pnpm exec playwright test tests/e2e/schedule-embed.spec.ts`.
- [ ] **Step 5: Break it** — `credentials: 'include'`; `innerHTML` for class type; remove the `customElements.get` guard; group days via `new Date(start).toLocaleDateString()` with the test env in a far zone; edit the widget source without rebuilding (build test fails). Record each; restore.
- [ ] **Step 6: Commit** — `feat: <fair-yoga-schedule> widget, dependency-free (#916)`

### Task 9: Settings → Share your schedule

**Files:**
- Create: `src/app/(teacher)/settings/share/page.tsx` (server: loads `getScheduleShare`, slug, origin)
- Create: `src/components/settings/share-schedule.tsx` (client)
- Create: `src/lib/embed-snippet.ts` — `buildEmbedSnippet(o: { origin: string; key: string; slug: string; theme: 'themed' | 'unstyled'; colorScheme: 'light' | 'dark' | 'auto' }): string`
- Modify: `src/app/(teacher)/settings/(overview)/page.tsx` — "Share your schedule" entry beside "Studio classes"
- Test: `src/lib/embed-snippet.test.ts`, `src/components/settings/share-schedule.test.tsx`, `tests/e2e/share-schedule.spec.ts`

**Interfaces:** Consumes Task 5 routes, Task 8 `defineScheduleElement` (imported directly for the live preview — same-origin fetch, no script tag, so the page CSP needs no change).

Layout and copy: the mockup's v2 cards, titled **Share your schedule**. Off: one sentence and "Turn on". On: "Your schedule" (Weeks ahead 1–4 segmented; Show studio classes toggle) — saved via PATCH; "Look" (Style fair.yoga / Your site's; Colours Light / Dark / Auto, hidden for Your site's) — local state only; Preview; Your code + Copy; Calendar feed (`https://` URL) + Copy; "Reset embed key…" and "Turn off sharing…", each opening the existing `Sheet` with the spec's exact copy; "Keep sharing" focused by default, "Turn off" danger-styled.

- [ ] **Step 1: Failing tests**
  - snippet: themed/auto output equals the exact string (`<script type="module" src="<origin>/embed/v1.js"></script>`, element with `key`, `theme`, `color-scheme`, inner fallback `<a href="<origin>/<slug>">See my schedule</a>`); unstyled output has no `color-scheme` attribute.
  - component: Colours row absent when "Your site's" selected; Turn-off sheet shows all three bullet texts verbatim; Reset sheet shows the spec's reset text and "Students subscribed to your calendar feed will stop getting updates."
  - e2e: a teacher turns sharing on, copies code (clipboard contains the key), toggles studio classes (persisted on reload), turns sharing off through the sheet (feed URL now 404).
- [ ] **Step 2: Verify fail. Step 3: Implement. Step 4: Verify pass.**
- [ ] **Step 5: Break it** — always emit `color-scheme`; render Colours unconditionally; record; restore.
- [ ] **Step 6: Run `pnpm run verify`** — expected green (typecheck, lint, all vitest projects, migration and lockfile checks). Then `pnpm run build` (CI-only checks: client import of a server-only module would surface here).
- [ ] **Step 7: Commit** — `feat: Settings → Share your schedule (#916)`

---

## Task order

1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9. Load-bearing: 3 before 4/6/7 (they consume its types); 5 before 6/7 (`teacherByShareKey`); 6 before 7 (cache, CORS helper); 8 before 9 (the preview imports the widget). 2 is independent of 3–9 but touches the schema from 1.
