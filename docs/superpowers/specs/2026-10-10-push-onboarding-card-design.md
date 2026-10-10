# Push onboarding card on the schedule (#817)

## Problem

`InstallCard` gets a teacher into the installed app and nothing follows it up.
Push works only in the installed app, so the first visit there is the moment to
offer it — and the only control today is `PushDeviceControl`, in Settings →
Notifications.

## What the issue got right, and what it did not

Measured against `main` at `bc29a27f`.

**Held:**

- `InstallCard` returns null on `installed` (`canOfferInstall`), and
  `classifyPushDevice` answers `needs-install` for anything but `installed`, so
  the two cards cannot render together.
- `onboardingSkipSchema` is `z.enum(OnboardingStep)`: adding the enum member is
  the whole route change.
- The settings page passes `readVapidConfig()?.publicKey ?? null`; the schedule
  page can do the same.
- `OnboardingStep` is read by `lib/onboarding.ts` (`StepKey` is an `Extract`
  of two named members), the route and `OnboardingSkipButton`. No exhaustive
  switch over it exists to break.

**Did not hold:**

1. **`off` is wider than "never asked".** `classifyPushDevice` answers `off`
   whenever permission is not `denied` and the device is not granted *and*
   subscribed. That includes a teacher who turned push **off** in Settings —
   `disablePush` unsubscribes, the permission stays `granted` — and a
   subscription just dropped for a stale VAPID key. Gating on `off` alone would
   re-offer, on the home screen, what the teacher just switched off.
2. **Sharing the effect as-is would add a request to every schedule load.**
   `PushDeviceControl`'s effect re-POSTs an existing subscription. On
   `/schedule`, every teacher with push on would POST on every visit, forever —
   the card never retires for them, since `on` is not stored.
3. **Closing Android's prompt is not denying it.** Permission stays `default`,
   so `enablePush` answers `failed` and the card shows its retry line.
4. **The e2e acceptance item cannot run as written.** No VAPID key is set in
   CI or the local `.env`, and Playwright reuses the dev server on :3000, so
   every e2e run resolves `unavailable` and the card never renders. Replaced by
   component and integration coverage (below); adding test VAPID keys to the e2e
   app would turn the push sweep on for the whole suite.

## Decisions

- **Eligibility:** `state === 'off'` **and** `Notification.permission === 'default'`
  — never asked on this device. A teacher who turned push off in Settings never
  sees the card; stale-key recovery stays in Settings.
- **Phones only:** gated on `useCoarsePointer()`, as `InstallCard` is.
  Dismissal is per teacher, so a "no" in a desktop window would otherwise retire
  the offer on the phone; the copy also says "this phone".
- **Re-sync is the settings row's alone:** the shared hook re-POSTs an existing
  subscription only when asked to.
- **Settings is unchanged and is always the way back.** Dismissing the card
  stores `push` in `skippedOnboarding`, which only the card reads.

## Design

### `usePushDevice` (new, `src/components/settings/use-push-device.ts`)

`usePushDevice(vapidPublicKey, { resync }): { state, permission, notice, setState, setNotice }`

`PushDeviceControl`'s effect moved verbatim — environment read, classification,
the stale-key `disablePush` (`on` → `off`), the `cancelled` guard, the
`unsupported` fallback on a throw — except that the `syncPushSubscription`
branch runs only when `resync` is true. `permission` is the
`NotificationPermission` read during resolution (`null` without `Notification`).
`state` is `null` until resolved.

`PushDeviceControl` calls it with `resync: true`; its test file passes
unchanged, which is what proves the extraction preserves behaviour.

### `PushCard` (new, `src/components/schedule/push-card.tsx`)

Props: `{ dismissed: boolean; vapidPublicKey: string | null }`.

Renders null unless `!dismissed && coarse && state === 'off' && permission === 'default'`
(so also null while `state` is null — nothing to flash). Styled as `InstallCard`
(sand-soft card, `type-subtitle` heading, `type-caption` line, primary `Button`
plus a quiet `OnboardingSkipButton`).

- **Turn on** → `enablePush(vapidPublicKey)` from the click handler, button
  disabled while busy. `on` or `blocked` → the card hides (local state; nothing
  stored — the device state answers it on the next load). `failed` → the card
  stays, with *"Notifications weren't turned on. Try again."* (`role="alert"`,
  the settings control's line), for as long as the page stays open. A failure
  after the browser granted permission does not bring the card back on the
  next visit — `granted` with no subscription is the turned-off-in-Settings
  signature — so Settings is the way back there; accepted rather than adding
  a per-device flag to re-offer a nudge after a rare failure.
- **Dismiss** → `<OnboardingSkipButton step="push">`.
- **Copy:** heading *Get notifications on this phone*; body *A heads-up when a
  student books or a class changes. Email still comes as it does now — you
  choose which messages in Settings.* with "Settings" linking to
  `/settings/notifications`.

### Schedule page

`<PushCard dismissed={teacher.skippedOnboarding.includes('push')} vapidPublicKey={readVapidConfig()?.publicKey ?? null} />`
directly below `InstallCard`.

### Migration

`ALTER TYPE "OnboardingStep" ADD VALUE 'push'`, via `prisma migrate dev`.

### Docs

`docs/information-architecture.md` gets a **Push card** paragraph beside the
Install card one.

## Tests

- **Hook** (components project): `resync: false` makes no POST for an `on`
  device; a stale key resolves `off` and calls `disablePush` either way;
  `permission` is reported.
- **Card** (components project): renders for exactly one combination — `off` +
  `default` + coarse + not dismissed — across every `PushDeviceState`, each
  permission, coarse/fine and dismissed; turn on → `on` hides, `blocked` hides,
  `failed` shows the retry line and keeps the button; Dismiss posts
  `{ step: 'push' }`.
- **Integration** (`tests/integration/teacher-signup-api.test.ts`): the route
  accepts `push` and stores it once on a double post.
- Each guard is broken once and its failure recorded (plan).

## Not in scope

**#818 (student counterpart) is unaffected** — the hook is reusable by it.
