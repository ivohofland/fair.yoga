# Push Onboarding Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A one-time card on the teacher's `/schedule` that offers to turn on push for this phone, shown only in the installed app on a phone whose browser has never been asked (#817).

**Architecture:** `PushDeviceControl`'s device-state effect moves into a hook, `usePushDevice`, which both the settings row and the new `PushCard` use, so the two cannot disagree about the device. The card adds three gates of its own on top of the hook's `off`: browser permission `default`, a coarse pointer, and not dismissed. Dismissal is a new `push` member of `OnboardingStep`, written through the existing `POST /api/account/onboarding`.

**Tech Stack:** Next.js 16 App Router, React client components, Prisma/PostgreSQL, Vitest (`components` and `integration` projects), Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-10-push-onboarding-card-design.md`

## Global Constraints

- TypeScript `strict`, no `any`.
- **Build in a worktree.** The main checkout's dev server on :3000 belongs to the user; never stop or restart it. Before starting, switch the main checkout back to `fix/app-stop-grace`, then create a worktree for `feat/push-onboarding-card` and run `pnpm install --frozen-lockfile`, `pnpm run worktree:setup` and `pnpm run worktree:up` there. Integration tests then read `INTEGRATION_BASE_URL` on their own. Task 2's migration regenerates the Prisma client, and the worktree's own server is what has to pick that up.
- Never `git add -A` or `git add .`. Stage exact paths, quoting any path with parentheses.
- Card copy, verbatim:
  - heading: `Get notifications on this phone`
  - body: `A heads-up when a student books or a class changes. Email still comes as it does now — you choose which messages in Settings.` ("Settings" links to `/settings/notifications`)
  - retry line: `Notifications weren't turned on. Try again.`
  - primary button: `Turn on`
  - dismiss button: `Dismiss`, aria-label `Dismiss the notifications card`
- No motion, no shadows. The card is styled exactly like `InstallCard`: `bg-sand-soft border border-border rounded-card p-5 mb-6`.
- Comments follow CLAUDE.md *Comment Discipline*: no counts, no member rosters, no history, and nothing that reaches past the file it sits in.

## Review Focus

1. **A teacher who turned push off in Settings** (permission `granted`, no subscription) must never see the card. Pinned by the card matrix in Task 3.
2. **An installed desktop window** (fine pointer) must never see the card, because a Dismiss there would retire it on the phone. Pinned by the card matrix in Task 3.
3. **A double tap on Turn on** must not fire two permission requests. The button is disabled while busy, pinned in Task 3.
4. **The schedule page opened offline** (served from the snapshot): `enablePush` fails, and the card shows the retry line rather than vanishing. This is the `failed` case in Task 3.
5. **A teacher with push already on** visits `/schedule`: no `POST /api/push/subscriptions` may result. Pinned by the `resync: false` test in Task 1.

---

### Task 1: Extract `usePushDevice` from `PushDeviceControl`

**Files:**
- Create: `src/components/settings/use-push-device.ts`
- Create: `src/components/settings/use-push-device.test.tsx`
- Modify: `src/components/settings/push-device-control.tsx` (the `Notice` type, the three `useState`s and the `useEffect` move out)
- Unchanged, and must stay green: `src/components/settings/push-device-control.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  export type PushNotice = null | 'enable-failed' | 'disable-failed' | 'unconfirmed';
  export interface PushDevice {
    /** null until the effect has resolved the device. */
    state: PushDeviceState | null;
    /** The permission read while resolving; null without `Notification` or before resolving. */
    permission: NotificationPermission | null;
    notice: PushNotice;
    setState: Dispatch<SetStateAction<PushDeviceState | null>>;
    setNotice: Dispatch<SetStateAction<PushNotice>>;
  }
  export function usePushDevice(vapidPublicKey: string | null, options: { resync: boolean }): PushDevice;
  ```

- [ ] **Step 1: Write the failing hook test.** Create `src/components/settings/use-push-device.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { InstallSupport } from '@/lib/install-support';
import type { SyncResult } from '@/lib/push-client';

let support: InstallSupport = 'installed';
vi.mock('@/components/layout/install-store', () => ({
  useInstallSupport: () => support,
}));

const currentPushSubscriptionMock = vi.fn<() => Promise<PushSubscription | null>>();
const disablePushMock = vi.fn<() => Promise<'off' | 'failed'>>();
const syncPushSubscriptionMock = vi.fn<(subscription: PushSubscription) => Promise<SyncResult>>();
vi.mock('@/lib/push-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/push-client')>();
  return {
    ...actual,
    currentPushSubscription: () => currentPushSubscriptionMock(),
    disablePush: () => disablePushMock(),
    syncPushSubscription: (subscription: PushSubscription) => syncPushSubscriptionMock(subscription),
  };
});

import { usePushDevice } from './use-push-device';

function keyOf(fill: number): string {
  return btoa(String.fromCharCode(...new Uint8Array(65).fill(fill))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const CURRENT_KEY = keyOf(4);

function subscriptionWithKey(fill: number): PushSubscription {
  return {
    endpoint: 'https://push.example/x',
    options: { applicationServerKey: new Uint8Array(65).fill(fill).buffer, userVisibleOnly: true },
    unsubscribe: vi.fn(async () => true),
  } as unknown as PushSubscription;
}

function setCapabilities(permission: NotificationPermission | null): void {
  Object.defineProperty(navigator, 'serviceWorker', {
    value: { register: vi.fn(), getRegistration: vi.fn(async () => null) },
    configurable: true,
  });
  (window as unknown as Record<string, unknown>).PushManager = function PushManager() {};
  if (permission === null) delete (window as unknown as Record<string, unknown>).Notification;
  else (window as unknown as Record<string, unknown>).Notification = { permission };
}

describe('usePushDevice', () => {
  beforeEach(() => {
    support = 'installed';
    currentPushSubscriptionMock.mockReset();
    currentPushSubscriptionMock.mockResolvedValue(null);
    disablePushMock.mockReset();
    disablePushMock.mockResolvedValue('off');
    syncPushSubscriptionMock.mockReset();
    syncPushSubscriptionMock.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    delete (navigator as unknown as Record<string, unknown>).serviceWorker;
    delete (window as unknown as Record<string, unknown>).PushManager;
    delete (window as unknown as Record<string, unknown>).Notification;
  });

  it('starts unresolved, then reports off and the permission it read', async () => {
    setCapabilities('default');
    const { result } = renderHook(() => usePushDevice(CURRENT_KEY, { resync: false }));
    expect(result.current.state).toBeNull();
    await waitFor(() => expect(result.current.state).toBe('off'));
    expect(result.current.permission).toBe('default');
  });

  it('reports a null permission where the browser has no Notification', async () => {
    setCapabilities(null);
    const { result } = renderHook(() => usePushDevice(CURRENT_KEY, { resync: false }));
    await waitFor(() => expect(result.current.state).toBe('unsupported'));
    expect(result.current.permission).toBeNull();
  });

  it('does not re-record an on device when resync is false', async () => {
    setCapabilities('granted');
    currentPushSubscriptionMock.mockResolvedValue(subscriptionWithKey(4));
    const { result } = renderHook(() => usePushDevice(CURRENT_KEY, { resync: false }));
    await waitFor(() => expect(result.current.state).toBe('on'));
    expect(syncPushSubscriptionMock).not.toHaveBeenCalled();
  });

  it('re-records an on device when resync is true', async () => {
    setCapabilities('granted');
    currentPushSubscriptionMock.mockResolvedValue(subscriptionWithKey(4));
    const { result } = renderHook(() => usePushDevice(CURRENT_KEY, { resync: true }));
    await waitFor(() => expect(result.current.state).toBe('on'));
    expect(syncPushSubscriptionMock).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('drops a stale-key subscription and reports off (resync %s)', async (resync) => {
    setCapabilities('granted');
    currentPushSubscriptionMock.mockResolvedValue(subscriptionWithKey(9));
    const { result } = renderHook(() => usePushDevice(CURRENT_KEY, { resync }));
    await waitFor(() => expect(result.current.state).toBe('off'));
    expect(disablePushMock).toHaveBeenCalledTimes(1);
    expect(syncPushSubscriptionMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.**
Run: `pnpm exec vitest run --project components src/components/settings/use-push-device.test.tsx`
Expected: FAIL, because the module `./use-push-device` cannot be resolved.

- [ ] **Step 3: Create the hook.** Write `src/components/settings/use-push-device.ts`. The effect body is `PushDeviceControl`'s, moved as-is, with three changes:
  - the re-sync branch is gated on `resync`;
  - `permission` is captured;
  - the `logRequestFailure` tags stay `'push-device-control'`, so existing log consumers are unaffected.

```ts
'use client';

import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { useInstallSupport } from '@/components/layout/install-store';
import { logRequestFailure } from '@/lib/client-errors';
import {
  classifyPushDevice,
  currentPushSubscription,
  disablePush,
  subscriptionUsesKey,
  syncPushSubscription,
  type PushDeviceEnv,
  type PushDeviceState,
} from '@/lib/push-client';

/** A line under a push control, set by the last thing that did not go as asked. */
export type PushNotice = null | 'enable-failed' | 'disable-failed' | 'unconfirmed';

export interface PushDevice {
  /** null until the effect below has resolved the device. */
  state: PushDeviceState | null;
  /** The permission read while resolving; null without `Notification` or before resolving. */
  permission: NotificationPermission | null;
  notice: PushNotice;
  setState: Dispatch<SetStateAction<PushDeviceState | null>>;
  setNotice: Dispatch<SetStateAction<PushNotice>>;
}

/**
 * This device's push state, resolved once per mount and again when the
 * install state or key changes. `resync` re-records a subscription that is
 * already on for the account signed in now; without it, resolving an `on`
 * device makes no request.
 */
export function usePushDevice(vapidPublicKey: string | null, { resync }: { resync: boolean }): PushDevice {
  const install = useInstallSupport();
  const [state, setState] = useState<PushDeviceState | null>(null);
  const [permission, setPermission] = useState<NotificationPermission | null>(null);
  const [notice, setNotice] = useState<PushNotice>(null);

  useEffect(() => {
    let cancelled = false;
    async function resolve(): Promise<void> {
      const hasServiceWorker = 'serviceWorker' in navigator;
      const hasPushManager = 'PushManager' in window;
      const hasNotification = 'Notification' in window;
      let subscription: PushSubscription | null = null;
      if (hasServiceWorker && hasPushManager) {
        try {
          subscription = await currentPushSubscription();
        } catch (err) {
          logRequestFailure('push-device-control', { step: 'read' }, err);
          subscription = null;
        }
      }
      if (cancelled) return;
      const readPermission = hasNotification ? Notification.permission : null;
      const env: PushDeviceEnv = {
        vapidConfigured: vapidPublicKey !== null,
        install,
        hasServiceWorker,
        hasPushManager,
        hasNotification,
        permission: readPermission,
        subscribed: subscription !== null,
      };
      let resolved = classifyPushDevice(env);
      let resolvedNotice: PushNotice = null;
      // The browser's subscription says nothing about which account the
      // server delivers it to, or whether the server still holds it — the
      // previous account on a shared phone, or a row deleted since — so a
      // caller that asks to resync has a subscription that may still be
      // good re-recorded for the account signed in now.
      if (resolved === 'on' && subscription && vapidPublicKey) {
        if (subscriptionUsesKey(subscription, vapidPublicKey) === 'mismatch') {
          // Made with a key the server no longer signs with: it can receive
          // nothing, and a new one needs the user's tap.
          logRequestFailure('push-device-control', { step: 'stale-key' }, new Error('subscription made with another VAPID key'));
          await disablePush();
          resolved = 'off';
        } else if (resync && !(await syncPushSubscription(subscription)).ok) {
          // Still subscribed in the browser, and possibly still held by the
          // server; the next visit re-records it.
          resolvedNotice = 'unconfirmed';
        }
        if (cancelled) return;
      }
      setNotice(resolvedNotice);
      setPermission(readPermission);
      setState(resolved);
    }
    resolve().catch((err: unknown) => {
      logRequestFailure('push-device-control', { step: 'resolve' }, err);
      if (!cancelled) setState('unsupported');
    });
    return () => {
      cancelled = true;
    };
  }, [install, vapidPublicKey, resync]);

  return { state, permission, notice, setState, setNotice };
}
```

- [ ] **Step 4: Make `PushDeviceControl` consume it.** In `src/components/settings/push-device-control.tsx`:
  - Delete the local `Notice` type, the `state`/`notice` `useState`s and the whole `useEffect`.
  - Replace them with `const { state, notice, setState, setNotice } = usePushDevice(vapidPublicKey, { resync: true });`.
  - Keep `const install = useInstallSupport();`, because the `needs-install` branch still reads it.
  - Keep `busy` local.
  - Trim the imports to what is still used: `useState` from react; `enablePush`, `disablePush` and `type PushDeviceState` only if still referenced. Let the compiler tell you.
  - Keep `handleEnable` and `handleDisable` unchanged; they already call `setNotice` and `setState`.

- [ ] **Step 5: Run both test files.**
Run: `pnpm exec vitest run --project components src/components/settings/use-push-device.test.tsx src/components/settings/push-device-control.test.tsx`
Expected: PASS, with **no edit** to `push-device-control.test.tsx` (`git diff --stat` on it shows nothing).

- [ ] **Step 6: Prove the resync gate bites.** Delete `resync && ` from the hook's `else if`, then rerun the hook test. Expected: `does not re-record an on device when resync is false` FAILS (`expected "spy" to not be called … but it was called 1 times`). Record the exact text in your report, restore the code, rerun, and confirm PASS.

- [ ] **Step 7: Typecheck and lint.**
Run: `pnpm exec tsc --noEmit && pnpm exec eslint src/components/settings/use-push-device.ts src/components/settings/use-push-device.test.tsx src/components/settings/push-device-control.tsx`
Expected: no errors.

- [ ] **Step 8: Commit.**
```bash
git add src/components/settings/use-push-device.ts src/components/settings/use-push-device.test.tsx src/components/settings/push-device-control.tsx
git commit -m "refactor: the push device state resolves in usePushDevice, re-recording only when asked"
```

---

### Task 2: `push` joins `OnboardingStep`

**Files:**
- Modify: `prisma/schema.prisma` (`enum OnboardingStep`)
- Create: `prisma/migrations/<timestamp>_onboarding_step_push/migration.sql` (generated)
- Modify: `tests/integration/teacher-signup-api.test.ts` (one new `it`, beside `records install while the checklist is still unsettled`)

**Interfaces:**
- Produces: `OnboardingStep` from `@prisma/client` includes `'push'`. `POST /api/account/onboarding` accepts `{ step: 'push' }` with no route change, because `onboardingSkipSchema` is `z.enum(OnboardingStep)`.

- [ ] **Step 1: Write the failing integration test.** Add it directly after the `install` test, reusing that test's fixtures (`onboardingToken`, `onboardingTeacherId`, `cookie`, `freshIp`, `BASE_URL`):

```ts
  /**
   * `push` (#817) dismisses the push card on the schedule. Like `install`,
   * it carries no settlement gate; a double post stores it once.
   */
  it('records push once, however often it is posted', async () => {
    for (let i = 0; i < 2; i += 1) {
      const res = await fetch(`${BASE_URL}/api/account/onboarding`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...cookie(onboardingToken), ...freshIp() },
        body: JSON.stringify({ step: 'push' }),
      });
      expect(res.status).toBe(200);
    }

    const teacher = await prisma.teacher.findUnique({
      where: { id: onboardingTeacherId },
      select: { skippedOnboarding: true },
    });
    expect(teacher?.skippedOnboarding.filter((s) => s === 'push')).toHaveLength(1);
  });
```

- [ ] **Step 2: Run it and confirm it fails.**
Run: `pnpm exec vitest run --project integration tests/integration/teacher-signup-api.test.ts -t "records push once"`
Expected: FAIL. The first response is `400`, because the schema refuses `push` (tsc may also flag `'push'` as not an `OnboardingStep` in the `filter` comparison; either counts as RED).

- [ ] **Step 3: Add the enum member and migrate.** In `prisma/schema.prisma`, add `push` as the last member of `enum OnboardingStep` (after `install`). Then:
Run: `pnpm exec prisma migrate dev --name onboarding_step_push`
Expected: a new migration whose `migration.sql` is `ALTER TYPE "OnboardingStep" ADD VALUE 'push';`, and a regenerated client. Do not hand-edit the generated SQL.

- [ ] **Step 4: Warm the route, then rerun.** The worktree's dev server must pick up the regenerated client. Run `curl -s -o /dev/null -w '%{http_code}\n' -X POST "$INTEGRATION_BASE_URL/api/account/onboarding"` (expect 401), then:
Run: `pnpm exec vitest run --project integration tests/integration/teacher-signup-api.test.ts`
Expected: PASS, the whole file. If the new test still answers 400, the worktree server is holding the old client. Restart the **worktree's** server (`pnpm run worktree:down && pnpm run worktree:up`), never :3000.

- [ ] **Step 5: Validate the schema and check for drift.**
Run: `pnpm exec prisma validate && pnpm exec prisma migrate status`
Expected: valid; the database schema is up to date.

- [ ] **Step 6: Commit.**
```bash
git add prisma/schema.prisma prisma/migrations/*_onboarding_step_push tests/integration/teacher-signup-api.test.ts
git commit -m "feat: push joins OnboardingStep, so the push card's dismissal can be recorded"
```

---

### Task 3: `PushCard` on the schedule

Depends on Task 1 (`usePushDevice`) and Task 2 (`'push'` in `OnboardingStep`, which `OnboardingSkipButton`'s `step` prop is typed by).

**Files:**
- Create: `src/components/schedule/push-card.tsx`
- Create: `src/components/schedule/push-card.test.tsx`
- Modify: `src/app/(teacher)/schedule/(overview)/page.tsx` (import, render below `InstallCard`)
- Modify: `docs/information-architecture.md` (a **Push card** paragraph after the **Install card** paragraph, ~line 253)

**Interfaces:**
- Consumes: `usePushDevice(vapidPublicKey, { resync: false })` (Task 1); `enablePush(vapidPublicKey): Promise<'on' | 'blocked' | 'failed'>` from `@/lib/push-client`; `useCoarsePointer(): boolean` from `@/components/layout/install-store`; `OnboardingSkipButton` (`step`, `ariaLabel`, `className`, children); `readVapidConfig()` from `@/lib/push/config`.
- Produces: `export function PushCard(props: { dismissed: boolean; vapidPublicKey: string | null }): JSX.Element | null`

- [ ] **Step 1: Write the failing card test.** Create `src/components/schedule/push-card.test.tsx`. The hook is mocked, because Task 1 tests it; the card tests own only the card's gates and actions.

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { PushDeviceState } from '@/lib/push-client';
import { routerRefresh } from '../../../tests/setup/components';

let coarse = true;
vi.mock('@/components/layout/install-store', () => ({
  useCoarsePointer: () => coarse,
}));

let device: { state: PushDeviceState | null; permission: NotificationPermission | null } = { state: 'off', permission: 'default' };
vi.mock('@/components/settings/use-push-device', () => ({
  usePushDevice: () => ({ ...device, notice: null, setState: vi.fn(), setNotice: vi.fn() }),
}));

const enablePushMock = vi.fn<(vapidPublicKey: string) => Promise<'on' | 'blocked' | 'failed'>>();
vi.mock('@/lib/push-client', () => ({
  enablePush: (key: string) => enablePushMock(key),
}));

import { PushCard } from './push-card';

/** Every `PushDeviceState`, tethered so a new member must be added here. */
const STATES = Object.keys({
  unsupported: true,
  'needs-install': true,
  off: true,
  on: true,
  blocked: true,
  unavailable: true,
} satisfies Record<PushDeviceState, true>) as PushDeviceState[];
const PERMISSIONS: (NotificationPermission | null)[] = ['default', 'granted', 'denied', null];

const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<{ ok: boolean }>>();

describe('PushCard', () => {
  beforeEach(() => {
    coarse = true;
    device = { state: 'off', permission: 'default' };
    enablePushMock.mockReset();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('renders only for an off, never-asked phone that has not dismissed it', () => {
    const cases = [null, ...STATES].flatMap((state) =>
      PERMISSIONS.flatMap((permission) =>
        [true, false].flatMap((isCoarse) => [true, false].map((dismissed) => ({ state, permission, isCoarse, dismissed }))),
      ),
    );
    it.each(cases)('state=$state permission=$permission coarse=$isCoarse dismissed=$dismissed', ({ state, permission, isCoarse, dismissed }) => {
      device = { state, permission };
      coarse = isCoarse;
      const { container } = render(<PushCard dismissed={dismissed} vapidPublicKey="KEY" />);
      const shown = state === 'off' && permission === 'default' && isCoarse && !dismissed;
      if (shown) expect(screen.getByRole('heading', { name: 'Get notifications on this phone' })).toBeInTheDocument();
      else expect(container).toBeEmptyDOMElement();
    });
  });

  it('renders nothing without a VAPID key, whatever the device reports', () => {
    const { container } = render(<PushCard dismissed={false} vapidPublicKey={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('links the message choice to the notification settings', () => {
    render(<PushCard dismissed={false} vapidPublicKey="KEY" />);
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings/notifications');
  });

  it.each(['on', 'blocked'] as const)('disappears once turning on answers %s', async (outcome) => {
    enablePushMock.mockResolvedValue(outcome);
    const { container } = render(<PushCard dismissed={false} vapidPublicKey="KEY" />);
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(enablePushMock).toHaveBeenCalledWith('KEY');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stays, with a retry line, when turning on fails', async () => {
    enablePushMock.mockResolvedValue('failed');
    render(<PushCard dismissed={false} vapidPublicKey="KEY" />);
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Notifications weren't turned on. Try again.");
    expect(screen.getByRole('button', { name: 'Turn on' })).toBeEnabled();
  });

  it('asks once on a double tap', async () => {
    let finish: (value: 'on') => void = () => {};
    enablePushMock.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    render(<PushCard dismissed={false} vapidPublicKey="KEY" />);
    const button = screen.getByRole('button', { name: 'Turn on' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(button).toBeDisabled();
    expect(enablePushMock).toHaveBeenCalledTimes(1);
    finish('on');
    await waitFor(() => expect(enablePushMock).toHaveBeenCalledTimes(1));
  });

  it('records push as dismissed and refreshes on Dismiss', async () => {
    render(<PushCard dismissed={false} vapidPublicKey="KEY" />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss the notifications card' }));
    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/account/onboarding');
    expect(JSON.parse(String(init?.body))).toEqual({ step: 'push' });
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.**
Run: `pnpm exec vitest run --project components src/components/schedule/push-card.test.tsx`
Expected: FAIL, because `./push-card` cannot be resolved.

- [ ] **Step 3: Implement the card.** Create `src/components/schedule/push-card.tsx`:

```tsx
'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { useCoarsePointer } from '@/components/layout/install-store';
import { usePushDevice } from '@/components/settings/use-push-device';
import { enablePush } from '@/lib/push-client';
import { OnboardingSkipButton } from './onboarding-skip-button';

/**
 * A one-time offer to turn on push, for a phone in the installed app whose
 * browser has never been asked. `permission === 'default'` is what separates
 * that phone from one where push was turned off on purpose: turning it off
 * drops the subscription but leaves the permission granted. Gated on a
 * coarse pointer because dismissal is per teacher, and a "no" in a desktop
 * window would otherwise retire the offer on the phone too.
 */
export function PushCard({ dismissed, vapidPublicKey }: { dismissed: boolean; vapidPublicKey: string | null }) {
  const coarse = useCoarsePointer();
  const { state, permission } = usePushDevice(vapidPublicKey, { resync: false });
  const [answered, setAnswered] = useState(false);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  // Set synchronously: a second tap can land before the re-render that
  // disables the button, and a second permission request must not follow.
  const inFlight = useRef(false);

  if (dismissed || answered || !coarse || vapidPublicKey === null) return null;
  if (state !== 'off' || permission !== 'default') return null;
  const key = vapidPublicKey;

  // The permission prompt needs the tap's gesture, so this runs from the
  // click and never on load. `on` and `blocked` both end the offer; neither
  // is stored, since the device state answers it on the next load.
  async function handleEnable(): Promise<void> {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setFailed(false);
    const outcome = await enablePush(key);
    if (outcome === 'failed') {
      inFlight.current = false;
      setFailed(true);
      setBusy(false);
      return;
    }
    setAnswered(true);
  }

  return (
    <div className="bg-sand-soft border border-border rounded-card p-5 mb-6">
      <h2 className="type-subtitle">Get notifications on this phone</h2>
      <p className="type-caption mt-0.5 mb-4">
        A heads-up when a student books or a class changes. Email still comes as it does now — you choose which
        messages in{' '}
        <Link href="/settings/notifications" className="text-teal">
          Settings
        </Link>
        .
      </p>
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <Button onClick={() => void handleEnable()} disabled={busy}>
          Turn on
        </Button>
        <OnboardingSkipButton
          step="push"
          ariaLabel="Dismiss the notifications card"
          className="type-label text-brown-light hover:text-brown px-3 min-h-11 shrink-0"
        >
          Dismiss
        </OnboardingSkipButton>
      </div>
      {failed && (
        <p role="alert" className="type-caption text-danger mt-3">
          Notifications weren&apos;t turned on. Try again.
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run the card test.**
Run: `pnpm exec vitest run --project components src/components/schedule/push-card.test.tsx`
Expected: PASS.

- [ ] **Step 5: Prove each gate bites.** Break each one separately, rerun the card test, record the failing test name and assertion text, then restore it:
  - (a) remove `|| permission !== 'default'`: the matrix case `state=off permission=granted coarse=true dismissed=false` FAILS;
  - (b) remove `|| !coarse`: the `coarse=false` / `off` / `default` / not-dismissed case FAILS;
  - (c) change the `failed` branch to `setAnswered(true)`: `stays, with a retry line` FAILS;
  - (d) delete the `if (inFlight.current) return;` line: `asks once on a double tap` FAILS (`toHaveBeenCalledTimes(1)`, received 2).

  After restoring, rerun and confirm PASS.

- [ ] **Step 6: Wire the schedule page.** In `src/app/(teacher)/schedule/(overview)/page.tsx`:
  - add `import { PushCard } from '@/components/schedule/push-card';` and `import { readVapidConfig } from '@/lib/push/config';`;
  - directly after the `<InstallCard … />` line, add:

```tsx
      <PushCard
        dismissed={teacher.skippedOnboarding.includes('push')}
        vapidPublicKey={readVapidConfig()?.publicKey ?? null}
      />
```

- [ ] **Step 7: Document it.** In `docs/information-architecture.md`, after the **Install card.** paragraph, add:

```markdown
**Push card.** Below the install card, inside the installed app on a phone whose browser has never been asked for notification permission, a one-time card offers to turn on push for this phone. Turn on asks the browser from the tap; once it is on, or the person declines in the browser's dialog, the card is gone without anything stored, because the device itself answers it. A failure leaves the card with a retry line. Dismiss retires it for good: its dismissal is the `push` member of `OnboardingStep`, stored on the teacher like `install`. A phone where push was turned off in Settings → Notifications has already granted permission, so the card never offers it again there; Settings → Notifications is where push is turned on or off afterwards.
```

- [ ] **Step 8: Typecheck, lint, build.**
Run: `pnpm exec tsc --noEmit && pnpm exec eslint src/components/schedule/push-card.tsx src/components/schedule/push-card.test.tsx 'src/app/(teacher)/schedule/(overview)/page.tsx' && pnpm run build`
Expected: all clean. The build is what catches a server/client import leak on the page.

- [ ] **Step 9: Commit.**
```bash
git add src/components/schedule/push-card.tsx src/components/schedule/push-card.test.tsx 'src/app/(teacher)/schedule/(overview)/page.tsx' docs/information-architecture.md
git commit -m "feat: a one-time card on the schedule offers to turn on notifications in the installed app (#817)"
```

---

## After the tasks

- Run `pnpm run verify` in the worktree (typecheck, lint, every vitest project against the worktree's app). Record the per-project counts for the PR body.
- Whole-branch review (3 tasks), one fix wave, one scoped re-review.
- PR body: what the spec corrected in the issue; that the e2e acceptance item was replaced, and why; the integration file touched (`tests/integration/teacher-signup-api.test.ts`); **#818 is unaffected**.
