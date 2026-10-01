# PWA install: manifest, `/start`, install hint (#723)

Part of tracking issue #727. #724 (push), #725 (read-only offline) and #726
(offline check-in) build on this and are out of scope here.

## 1. What the issue assumed, and what holds

Measured in this worktree off `origin/main` at `25b01b0a`.

| Issue's premise | Measured |
|---|---|
| No manifest, no install hint, no standalone detection in `src/` | **Holds.** No `src/app/manifest.*`; `grep -rniE "beforeinstallprompt\|display-mode" src` has no hits; `grep -rli standalone src` finds 9 files, none about display mode (timezone option lists, the profile form that renders them, and prose in services and tests). |
| `apple-icon.png` and `icon.svg` exist | **Holds, but neither is an install icon.** `apple-icon.png` is 180×180, `icon.svg` is 64×64. Chromium's install criteria want 192 and 512 PNGs; no maskable icon exists. |
| Safe-area insets are handled | **Bottom only.** `tab-bar.tsx` pads `env(safe-area-inset-bottom)`; nothing reads `safe-area-inset-top`. §3.1 keeps content below the iOS status bar by status-bar style instead. |
| A fixed `/schedule` is wrong for students, so `start_url` must route by profile | **Holds, and half exists.** `(public)/page.tsx` already sends a signed-in teacher to `/schedule` and a student-only account to `/bookings`. A signed-out visitor gets the public pitch, which is the wrong first screen in an installed app. |
| A magic link tapped in Mail lands its session in Safari, and the fix may need a new emailed one-time code with its own rate limits and brute-force bound | **The fix already exists: the magic-link device handoff, #214** (`docs/superpowers/specs/2026-09-03-magic-link-device-handoff-design.md`, `src/lib/auth/handoff.ts`). Every link is bound to a hash of the requesting browser's `fair_yoga_origin` nonce. A link opened anywhere else (Safari, whose cookie jar is not the installed app's) consumes nothing and shows a 6-digit code; the app redeems it via `POST /api/auth/magic-link/claim`, behind a per-IP limit and a per-token attempt budget (`HANDOFF_MAX_ATTEMPTS`). The installed-app case is that design's second-device case. **No new auth surface is built here.** |

The handoff leaves one gap specific to an installed app (§3.3): the code field
on `/login` exists only in React state after "Send", and iOS may evict a
backgrounded home-screen app while the person is in Mail.

A copied cookie jar would not defeat the handoff. If iOS copied Safari's
cookies into the app at install time, both would hold one nonce. A
successful sign-in clears the nonce (`clearOriginNonceCookie`), so a shared
value survives only an install made while a Safari request was still
unconsumed. In that window one link signs Safari in. The next request from
the app is bound to the app's copy, which Safari no longer holds, and goes
through the code path. The device test (§6) confirms which case iOS is in.

## 2. Decisions

| Question | Decision | Why |
|---|---|---|
| Where the install hint lives | A permanent row in Settings (teacher Settings index, student `/account`), plus a one-time card for teachers built on the onboarding-card system | The row is always findable; the card is the one deliberate nudge. |
| When the card shows | On a phone where install is possible, until dismissed, **whatever Getting started's state**; above Getting started when both show | A teacher who set up on desktop on days 1–2 sees it on their first phone visit on day 3, finished checklist or not. |
| Where dismissal is stored | `Teacher.skippedOnboarding`, new `OnboardingStep` member `install` | Server-side, so it follows the teacher across devices and across iOS's separate cookie jars; `localStorage` would come back in every new context. |
| `start_url` | New `/start` route | A signed-out person in the app lands on sign-in, not the pitch. |
| `theme_color` | Cream `#F7F4EF` (same as `background_color`) | Status bar blends into the page; the teal icon carries the brand. |
| Handoff code after a relaunch | An always-present "Have a code from the email link?" line on `/login` | No storage or timer; adds no attack surface, since a code redeems only with the requesting browser's nonce cookie. |
| Students | Row only, no card | Teacher-side onboarding system; the user asked for teachers. |
| Passkey-before-install ordering | Dropped | The handoff makes the first in-app sign-in work without a passkey. |

## 3. Design

### 3.1 Manifest, icons, head tags

- `src/app/manifest.ts` (Next metadata route, served at `/manifest.webmanifest`):
  `name` and `short_name` `fair.yoga`; `id: '/start'`; `start_url: '/start'`;
  `scope: '/'`; `display: 'standalone'`; `background_color` and `theme_color`
  `#F7F4EF`; `icons` listing 192 and 512 `purpose: 'any'` PNGs and a 512
  `purpose: 'maskable'` PNG.
- Icon files in `public/icons/`, rendered once from `src/app/icon.svg` and
  committed: no build step and no new dependency. The maskable variant keeps
  the glyph inside the central 80% safe circle on a full-bleed teal field.
  The rendering command goes in the PR body.
- The repo has had no `public/` until now. `docs/supply-chain.md` (the
  runner-stage paragraph) and the comment on `RUN mkdir -p public` in
  `Dockerfile` both state that, and both are corrected. The `mkdir -p` itself
  stays, since it is harmless.
- `src/app/layout.tsx`: `viewport.themeColor: '#F7F4EF'`;
  `metadata.appleWebApp: { capable: true, title: 'fair.yoga', statusBarStyle: 'default' }`.
  With `default`, iOS lays content out below the status bar, so the
  "nothing under the status bar" criterion needs no `safe-area-inset-top`
  padding. §6 checks it on a device.
- CSP needs no change: no `manifest-src` directive, so it falls back to
  `default-src 'self'`.

### 3.2 `/start`

`src/app/(public)/start/page.tsx` is a server component that only redirects,
with the precedence `/` and both sign-in routes already use:

- a session with a teacher profile goes to `/schedule`
- a session with only a student profile goes to `/bookings`
- no session goes to `/login`

It stays **out** of `src/proxy.ts`'s matcher; there a signed-out visit would
become `/login?redirect=/start`. `'start'` joins `RESERVED_SLUGS`
(`src/lib/schemas.ts`), because a static route outranks the `[slug]` teacher
page. Nothing is in production, so no existing slug collides.

### 3.3 Sign-in inside the app

No change to the handoff. One addition to `/login`'s idle state: a caption
line, **"Have a code from the email link? Enter it"**, that reveals the
existing `HandoffCodeEntry` in place. It sits beside the existing "New here?"
line.

### 3.4 Install support detection

`src/lib/install-support.ts`:

- `classifyInstall(env): InstallSupport` is **pure**, so a table test can
  cover it. `InstallSupport` is
  `'unknown' | 'installed' | 'ios-safari' | 'prompt' | 'manual' | 'unsupported'`,
  and `env` carries user agent, `maxTouchPoints`, standalone media match,
  `navigator.standalone`, whether a deferred prompt is held, whether one was
  already used, and whether `appinstalled` fired.
  - `installed`: `(display-mode: standalone)` matches,
    `navigator.standalone === true`, or `appinstalled` fired. Checked first.
  - `ios-safari`: iOS or iPadOS (a `Macintosh` user agent with
    `maxTouchPoints > 1` is an iPad) **and** real Safari. Excluded: Chrome
    (`CriOS`), Firefox (`FxiOS`), Edge (`EdgiOS`), Opera (`OPiOS`), the
    Google app (`GSA`), and in-app webviews, which carry no `Safari/` token
    or carry their own marker (`FBAN`/`FBAV`, `Instagram`, `Line`).
  - `prompt`: a captured `beforeinstallprompt` is held.
  - `manual`: a held prompt was used and nothing new arrived since.
  - otherwise `unsupported`.
- A store in `src/components/layout/install-store.ts` holds the deferred
  prompt event, created once when the module loads in a browser.
  `InstallListener`, a client component mounted once in the root layout,
  exists so that module loads on every page. The store attaches
  `beforeinstallprompt` (calling `preventDefault()`, which suppresses
  Chromium's own mini-infobar so the card is the only prompt) and
  `appinstalled`.
- `useInstallSupport()` reads through `useSyncExternalStore` with
  `'unknown'` as the server snapshot. `'unknown'` renders nothing, so
  install surfaces only appear after hydration and never flicker out.
- A deferred prompt can be used once. After the person cancels Chrome's
  dialog the store answers `manual` rather than dropping to `unsupported`,
  so a visible row or card does not vanish. Its next tap shows the manual
  route: open the browser menu (⋮) and choose Install app.

### 3.5 The one-time card (teachers)

- `InstallCard` (`src/components/schedule/install-card.tsx`) is rendered by
  `schedule/page.tsx` above `GettingStarted`, in the same sand-soft card
  shell. The page passes
  `dismissed = teacher.skippedOnboarding.includes('install')` and renders
  nothing server-side when it is set.
- Client rule: render when support is `ios-safari`, or `prompt` or `manual`
  while `matchMedia('(pointer: coarse)')` matches. An iOS Safari install is always
  on a touch device; the coarse check keeps the card off desktop Chrome.
- Copy: title **"Use fair.yoga as an app"**; caption "Open it from your Home
  Screen, full screen, one tap away."
  - iOS: **"Show me how"** expands `InstallSteps` inline. The panel ends
    with **Done**, which records `install`.
  - Prompt: **"Install"** calls `prompt()`. An `accepted` outcome hides the
    card immediately — a failed dismissal post never leaves someone who just
    installed looking at manual steps — and still posts `install` best-effort,
    refreshing only once that post succeeds. A `dismissed` outcome leaves the
    card, whose next tap shows the manual route. An `unavailable` outcome
    (`prompt()` itself threw) opens the manual steps immediately, so the tap
    that failed still shows something.
  - **Dismiss**: `OnboardingSkipButton step="install"`.
- Self-retire: on a phone (a coarse pointer) only — a desktop standalone
  window, or a desktop tab right after `appinstalled`, is `installed` too but
  self-retiring there would hide the card on the teacher's actual phone,
  since dismissal is per teacher, not per device. When the Schedule mounts on
  a phone with support `installed` and `dismissed` false, it posts `install`
  once, without waiting on the answer and without a refresh; a failed post
  only means the next standalone launch tries again. The copy of the card
  still open in Safari then disappears on its next load. No UI is shown for
  this.

### 3.6 Persistence

- Migration: `ALTER TYPE "OnboardingStep" ADD VALUE 'install'`, via
  `prisma migrate dev`. The enum's schema comment ("Steps a teacher may
  dismiss") already fits.
- `POST /api/account/onboarding`: `onboardingSkipSchema` is
  `z.enum(OnboardingStep)`, so it accepts `install` with no edit. The route's
  settlement gate is already `if (step === 'share')`, so `install` is
  recorded whatever the checklist's state. A test pins both directions.
- `isOnboardingComplete` and `resolveSteps` are unaffected; `install` is not
  a checklist row and does not retire Getting started.

### 3.7 The permanent rows

`InstallAppRow` (`src/components/account/install-app-row.tsx`) is a client
island, styled as the surrounding ≥56px rows:

- Teacher: end of the Settings index list, before Sign out.
- Student: end of `/account`'s settings list.
- It reads **"Add to Home Screen"** and renders when support is
  `ios-safari`, `prompt` or `manual` (desktop Chrome included). iOS expands `InstallSteps` inline;
  `prompt` calls `prompt()`, then the manual route as in §3.4.
- No dismissal; it records nothing.

`InstallSteps` (`src/components/account/install-steps.tsx`) is the one home
of the iOS step copy: *Tap Share in Safari's toolbar*, then *Add to Home
Screen*, then *Add*. It is described in words, not with an arrow pointing at
a toolbar position, which differs by Safari layout and device.

## 4. Docs that change with it

- `docs/information-architecture.md`, Onboarding flow: the install card and
  its rule.
- `docs/teacher-screens.md` 1.3: the install card beside the checklist.
- `docs/supply-chain.md` runner-stage paragraph, and the `Dockerfile`
  comment: `public/` now exists (§3.1).
- `docs/technical-architecture.md`, Magic Link: one line saying that an
  installed app's own cookie jar is the handoff's second-browser case.

## 5. Testing

- **Unit** (`install-support.test.ts`): a `classifyInstall` table covering
  - iPhone Safari, and iPad Safari with the desktop user agent
  - Chrome, Firefox, Edge and the Google app on iOS, and an Instagram webview
  - Android Chrome with and without a held prompt
  - desktop Chrome with a prompt
  - standalone by media query, and by `navigator.standalone`
- **Unit**: the manifest's fields; every icon it lists exists under `public/`
  with the PNG dimensions it claims.
- **Component**:
  - `InstallCard`: dismissed renders nothing; `unknown` renders nothing;
    iOS expand then Done posts `install`; prompt accepted posts, cancelled
    does not; Dismiss posts; standalone self-retire posts once.
  - `InstallAppRow`: renders per support; the manual route after a used
    prompt.
  - `/login`: the "Have a code" line reveals the code entry.
- **Integration**:
  - `POST /api/account/onboarding` records `install` on an unsettled
    checklist, and still refuses an unsettled `share` with
    `ONBOARDING_NOT_SETTLED`
  - `/start` redirects all three ways
  - `/manifest.webmanifest` serves the fields
  - `pageSlugField` refuses `start`
- **Mutation, per guard** (break, record the error, restore):
  - widen the settlement gate to include `install`
  - drop the coarse-pointer check
  - drop the standalone check
  - drop the `Version/` requirement, and drop the one denylist marker
    (`EdgiOS`) whose browser carries `Version/`. The other markers back up
    the `Version/` rule, so dropping one alone is inert by design.
  - ignore the server `dismissed` flag
  - drop `start` from `RESERVED_SLUGS`

## 6. Device test (the issue's acceptance)

Run on a real iPhone and a real Android phone against an HTTPS build. Record
the results in the PR body.

1. **iOS sign-in via handoff.** Install from Safari, open the app, and sign
   out. Request a link in the app, tap it in Mail, and check that Safari
   shows a 6-digit code. Type it into the app: the app is signed in and
   Safari is not. Repeat with the app force-quit in between, using the
   "Have a code?" line.
2. **iOS passkey.** In the app, sign in with a passkey created in Safari.
3. **iOS first launch.** Note whether the freshly installed app starts
   signed in. This tells whether iOS copied Safari's cookies (§1).
4. **iOS chrome and safe areas.** Correct icon and name; no browser chrome;
   content below the status bar; tab bar above the home indicator.
5. **Android.** The card's Install button installs; icon, name and splash
   are correct; no browser chrome.
6. **Hint gating.** No card or row inside either installed app, or in Chrome
   for iOS.
