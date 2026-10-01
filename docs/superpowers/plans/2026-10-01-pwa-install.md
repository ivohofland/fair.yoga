# PWA Install Implementation Plan (#723)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make fair.yoga installable (manifest, icons, `/start`), give `/login` a
path back to the handoff code after the installed app reloads, and offer the
install through a permanent Settings row plus a one-time teacher card.

**Architecture:** A Next metadata route serves the manifest. A pure
classifier (`src/lib/install-support.ts`) decides what this browser can do. A
store (`src/components/layout/install-store.ts`) captures
`beforeinstallprompt` once per page load and exposes the classifier's answer
through `useSyncExternalStore`, with `'unknown'` as the server snapshot so
install surfaces only appear after hydration. The card's dismissal is a new
`OnboardingStep` member, `install`, posted through the existing
`/api/account/onboarding` route.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript strict, Prisma +
PostgreSQL 16, Vitest (`unit`, `components` and `integration` projects),
Playwright (visual baselines), ImageMagick (`magick`, one-off icon render).

**Spec:** `docs/superpowers/specs/2026-10-01-pwa-install-design.md`

## Global Constraints

- Shell: prefix `PATH` with Node 24 before any `pnpm` command:
  `export PATH="$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node | grep '^v24' | tail -1)/bin:$PATH:/usr/sbin"`.
- TypeScript `strict`: no `any`, and no `as` cast where a type guard does the
  job.
- Comments follow CLAUDE.md *Comment Discipline*: annotate the code they sit
  on; no counts, no rosters, no history.
- Stage exact paths, never `git add -A` or `git add .`. Quote any path that
  contains `(public)`, `(teacher)` or `(student)`.
- Never restart or kill the dev server on `:3000`. Integration and e2e run
  against this worktree's own app: `pnpm run worktree:setup` once, then
  `pnpm run worktree:up`.
- Exact values from the spec:
  - `start_url` and `id`: `'/start'`; `scope: '/'`; `display: 'standalone'`
  - `theme_color` and `background_color`: `#F7F4EF`
  - icons: 192 and 512 `any`, and 512 `maskable`, under `public/icons/`
- Copy uses the typographic apostrophe (`’`) as the surrounding files do.
  Typography uses only the `type-*` styles. No new icons; no motion.
- Migrations: once applied, a migration file is immutable, comments
  included. Comments describe only their own SQL.
- Commit messages end with
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

1. **`beforeinstallprompt` fires before any component's effect runs** (a
   fast, cached load). The prompt must still be captured; the store attaches
   when its module loads, not in an effect. Pinned in Task 4 Step 7.
2. **A double tap on Install while Chrome's dialog is open.** `prompt()` may
   be called only once per event; the second tap must not call it again or
   throw. Pinned in Task 4 Step 1 (`promptInstall` while in flight).
3. **The installed app's Schedule mounts again in the same page session**
   (tabbing to Students and back). The self-retire post must go out once,
   not once per mount. Pinned in Task 6 Step 5.
4. **A two-hat account opens the installed app.** `/start` must land on
   `/schedule`, the teacher home, as `/` and both sign-in routes already do.
   Pinned in Task 2 Step 1.
5. **Playwright's Chromium fires `beforeinstallprompt`.** On the Pixel 5
   project (a coarse pointer) the card and row would then appear in the
   schedule and settings baselines on some runs. The visual spec swallows
   the event so the baselines are deterministic. Task 7 Step 1.

---

### Task 1: Manifest, icons and head tags

**Files:**
- Create: `src/app/manifest.ts`
- Create: `src/app/manifest.test.ts`
- Create: `public/icons/icon-192.png`, `public/icons/icon-512.png`, `public/icons/icon-maskable-512.png`
- Modify: `src/app/layout.tsx` (the `metadata` and `viewport` exports)
- Create: `tests/integration/pwa.test.ts`
- Modify: `docs/supply-chain.md` (runner-stage paragraph, the sentence beginning "This repo has never tracked a `public/`")
- Modify: `Dockerfile` (the three comment lines above `RUN mkdir -p public`)

**Interfaces:**
- Produces: `THEME_COLOR` (`'#F7F4EF'`), exported from `src/app/manifest.ts`;
  `/manifest.webmanifest`; `tests/integration/pwa.test.ts`, which Task 2
  extends.

- [ ] **Step 1: Write the failing unit test** in `src/app/manifest.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import manifest from './manifest';

function pngSize(file: string): string {
  const buf = readFileSync(file);
  // Bytes 1–3 of every PNG are "PNG"; the IHDR chunk's width and height are
  // big-endian at offsets 16 and 20.
  expect(buf.subarray(1, 4).toString('ascii')).toBe('PNG');
  return `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`;
}

describe('manifest', () => {
  const m = manifest();

  it('opens standalone at /start', () => {
    expect(m).toMatchObject({ id: '/start', start_url: '/start', scope: '/', display: 'standalone' });
  });

  it('uses the cream page token for both theme and background', () => {
    const css = readFileSync(path.join(process.cwd(), 'src/app/globals.css'), 'utf8');
    expect(css).toContain(`--color-cream: ${m.theme_color};`);
    expect(m.background_color).toBe(m.theme_color);
  });

  it('lists 192 and 512 any-purpose icons and a 512 maskable one', () => {
    expect((m.icons ?? []).map((i) => `${i.sizes} ${i.purpose}`)).toEqual([
      '192x192 any',
      '512x512 any',
      '512x512 maskable',
    ]);
  });

  it.each(m.icons ?? [])('ships $src at the size it claims', (icon) => {
    expect(pngSize(path.join(process.cwd(), 'public', icon.src))).toBe(icon.sizes);
  });
});
```

- [ ] **Step 2: Run it and see it fail.**
  Run `pnpm exec vitest run --project unit src/app/manifest.test.ts`.
  Expected: FAIL, the module `./manifest` cannot be resolved.

- [ ] **Step 3: Write `src/app/manifest.ts`:**

```ts
import type { MetadataRoute } from 'next';

/** `--color-cream` in globals.css, the page background: the status bar and
 *  the splash screen then read as the page itself. */
export const THEME_COLOR = '#F7F4EF';

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/start',
    name: 'fair.yoga',
    short_name: 'fair.yoga',
    description: 'Ethical pricing for independent yoga teachers',
    start_url: '/start',
    scope: '/',
    display: 'standalone',
    background_color: THEME_COLOR,
    theme_color: THEME_COLOR,
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
```

- [ ] **Step 4: Render the icons** from `src/app/icon.svg`. Its 64-unit
  viewBox rasterizes at 64 px at 72 dpi, so density = 72 × (target ÷ 64).
  The maskable icon draws the full icon at 75% on a full-bleed teal
  (`#1A5653`) field, keeping the glyph inside the central 80% safe circle.

```bash
mkdir -p public/icons
magick -background none -density 216 src/app/icon.svg -resize 192x192 -strip public/icons/icon-192.png
magick -background none -density 576 src/app/icon.svg -resize 512x512 -strip public/icons/icon-512.png
magick -size 512x512 xc:'#1A5653' \( -background none -density 432 src/app/icon.svg -resize 384x384 \) -gravity center -composite -strip public/icons/icon-maskable-512.png
```

  Open all three images and look at them. The glyph must be crisp and
  centred, and the maskable one's teal must be seamless with no visible inner
  square. Record these three commands for the PR body.

- [ ] **Step 5: Run the unit test and see it pass.**
  Same command as Step 2. Expected: PASS, 6 tests (3 named `it`s plus the
  3-row `it.each`).

- [ ] **Step 6: Head tags.** In `src/app/layout.tsx`, import `THEME_COLOR`
  from `./manifest` and:
  - add to `metadata`:
    `appleWebApp: { capable: true, title: 'fair.yoga', statusBarStyle: 'default' }`
  - add to `viewport`: `themeColor: THEME_COLOR`

  Above `appleWebApp`, add one comment line:
  `// 'default' keeps iOS content below the status bar in the installed app.`

- [ ] **Step 7: Write the failing integration test**
  `tests/integration/pwa.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { BASE_URL, freshIp } from '../helpers';

describe('GET /manifest.webmanifest', () => {
  it('serves the install manifest', async () => {
    const res = await fetch(`${BASE_URL}/manifest.webmanifest`, { headers: freshIp() });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/manifest+json');
    const body: unknown = await res.json();
    expect(body).toMatchObject({ start_url: '/start', display: 'standalone', theme_color: '#F7F4EF' });
  });
});

describe('the document head', () => {
  it('links the manifest and carries the theme colour', async () => {
    const res = await fetch(`${BASE_URL}/login`, { headers: freshIp() });
    const html = await res.text();
    expect(html).toContain('rel="manifest" href="/manifest.webmanifest"');
    expect(html).toMatch(/<meta name="theme-color" content="#F7F4EF"/);
    expect(html).toMatch(/<meta name="apple-mobile-web-app-title" content="fair.yoga"/);
  });
});
```

- [ ] **Step 8: Run it.** `pnpm run worktree:setup` (first time only), then
  `pnpm run worktree:up`, then
  `pnpm exec vitest run --project integration tests/integration/pwa.test.ts`.
  Expected: PASS, since Steps 3 and 6 already landed. To prove the test can
  fail, temporarily delete the `themeColor` line, re-run, and confirm that
  assertion fails. Restore it and re-run to PASS.

- [ ] **Step 9: Correct the two "no `public/`" claims.**
  - In `docs/supply-chain.md`, replace the sentence "This repo has never
    tracked a `public/` of its own — icons are Next's file-based
    `app/icon.svg` convention instead — so the `build` stage creates one
    empty before the copy; #543 has the history." with: "`public/` holds the
    web app manifest's install icons; the site icons are Next's file-based
    `app/icon.svg` convention. The `build` stage still creates `public/`
    before the copy, so the copy never depends on it; #543 has the
    history."
  - In `Dockerfile`, replace the three comment lines above
    `RUN mkdir -p public` with **exactly three** lines, because
    `docs/supply-chain.md` cites `Dockerfile` line numbers:

```dockerfile
# public/ is tracked (the install icons); the mkdir keeps the runner's
# COPY below independent of that — see docs/supply-chain.md for the
# runner stage's contents.
```

  Then confirm `git diff --stat Dockerfile` shows 3 insertions and 3
  deletions.

- [ ] **Step 10: Commit.**

```bash
git add src/app/manifest.ts src/app/manifest.test.ts src/app/layout.tsx public/icons/icon-192.png public/icons/icon-512.png public/icons/icon-maskable-512.png tests/integration/pwa.test.ts docs/supply-chain.md Dockerfile
git commit -m "feat(pwa): web app manifest, install icons and head tags (#723)"
```

---

### Task 2: `/start`

**Files:**
- Create: `src/app/(public)/start/page.tsx`
- Modify: `src/lib/schemas.ts` (`RESERVED_SLUGS`)
- Modify: `src/lib/schemas.test.ts` (the `it.each([...])('rejects the reserved slug %s'` list)
- Modify: `tests/integration/pwa.test.ts`

**Interfaces:**
- Consumes: `getSession()` from `@/lib/session` (its result has
  `teacherId: string | null` and `studentId: string | null`).
- Produces: the route `/start`, which Task 1's manifest already names.

- [ ] **Step 1: Write the failing integration tests.** Append to
  `tests/integration/pwa.test.ts`, merging the imports into the file's
  existing import lines:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BASE_URL, freshIp, cookie, seedSession, uniqueSuffix } from '../helpers';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();
const teacherEmail = `pwa-start-teacher-${suffix}@test.local`;
const studentEmail = `pwa-start-student-${suffix}@test.local`;
const dualEmail = `pwa-start-dual-${suffix}@test.local`;
// Keyed by literal addresses, never by an id beforeAll assigns: a failed
// beforeAll must not leave a cleanup filter that matches every row.
const emails = [teacherEmail, studentEmail, dualEmail];

let teacherToken = '';
let studentToken = '';
let dualToken = '';

beforeAll(async () => {
  const teacherAccount = await prisma.account.create({
    data: {
      email: teacherEmail,
      teachers: { create: { firstName: 'Pwa', lastName: 'Teacher', email: teacherEmail, bio: '', pageSlug: `pwa-start-t-${suffix}` } },
    },
  });
  teacherToken = await seedSession(prisma, teacherAccount.id);

  const studentAccount = await prisma.account.create({
    data: {
      email: studentEmail,
      students: { create: { firstName: 'Pwa', lastName: 'Student', email: studentEmail, claimedAt: new Date() } },
    },
  });
  studentToken = await seedSession(prisma, studentAccount.id);

  const dualAccount = await prisma.account.create({
    data: {
      email: dualEmail,
      teachers: { create: { firstName: 'Pwa', lastName: 'Dual', email: dualEmail, bio: '', pageSlug: `pwa-start-d-${suffix}` } },
      students: { create: { firstName: 'Pwa', lastName: 'Dual', email: dualEmail, claimedAt: new Date() } },
    },
  });
  dualToken = await seedSession(prisma, dualAccount.id);
});

afterAll(async () => {
  await prisma.session.deleteMany({ where: { account: { email: { in: emails } } } });
  await prisma.teacher.deleteMany({ where: { email: { in: emails } } });
  await prisma.student.deleteMany({ where: { email: { in: emails } } });
  await prisma.account.deleteMany({ where: { email: { in: emails } } });
  await prisma.$disconnect();
});

async function startDestination(token: string | null): Promise<string> {
  const res = await fetch(`${BASE_URL}/start`, {
    redirect: 'manual',
    headers: { ...(token ? cookie(token) : {}), ...freshIp() },
  });
  expect(res.status).toBe(307);
  return new URL(res.headers.get('location') ?? '', BASE_URL).pathname;
}

describe('GET /start', () => {
  it('sends a teacher to their schedule', async () => {
    expect(await startDestination(teacherToken)).toBe('/schedule');
  });

  it('sends a student-only account to their bookings', async () => {
    expect(await startDestination(studentToken)).toBe('/bookings');
  });

  it('sends a two-hat account to the teacher home', async () => {
    expect(await startDestination(dualToken)).toBe('/schedule');
  });

  it('sends a signed-out visitor to sign-in, not the public pitch', async () => {
    expect(await startDestination(null)).toBe('/login');
  });
});
```

  If `Session` has no `account` relation, filter its cleanup by `accountId`
  with ids read back from the accounts selected by `emails` instead.
  `Account` has `teachers Teacher[]` and `students Student[]`; `Student`
  requires `accountId` and `claimedAt` together.

- [ ] **Step 2: Run them and see them fail.**
  `pnpm exec vitest run --project integration tests/integration/pwa.test.ts`.
  Expected: the four `/start` tests fail on the status (404 or 200 from the
  `[slug]` page, not 307). If a real redirect ever arrives as something
  other than a 307 with a `Location` header (for example a 200 carrying a
  client-side redirect), stop and report it rather than loosening the
  assertion.

- [ ] **Step 3: Write `src/app/(public)/start/page.tsx`:**

```tsx
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';

/**
 * The installed app's start URL (`src/app/manifest.ts`). A signed-out
 * person lands on sign-in rather than the public pitch `/` shows; a
 * signed-in one goes home, the teacher home first for a two-hat account.
 * Deliberately outside `src/proxy.ts`'s matcher, which would turn the
 * signed-out case into `/login?redirect=/start`.
 */
export default async function StartPage(): Promise<never> {
  const session = await getSession();
  if (session?.teacherId) redirect('/schedule');
  if (session?.studentId) redirect('/bookings');
  redirect('/login');
}
```

- [ ] **Step 4: Run them and see them pass.** Same command. Expected: PASS.

- [ ] **Step 5: Reserve the slug, test first.** In `src/lib/schemas.test.ts`,
  add `'start'` to the
  `it.each(['signup', 'login', 'schedule', 'api'])('rejects the reserved slug %s'`
  list. Run
  `pnpm exec vitest run --project unit src/lib/schemas.test.ts`: the new
  case FAILS. Add `'start'` to `RESERVED_SLUGS` in `src/lib/schemas.ts` and
  re-run: PASS.

- [ ] **Step 6: Mutation check, the teacher-first order.** Swap the two `if`
  lines in `start/page.tsx` so the student check runs first. Re-run the
  integration file: `sends a two-hat account to the teacher home` FAILS,
  receiving `/bookings`. Record the failure line, restore, re-run to PASS,
  and confirm `git status` shows no stray edit.

- [ ] **Step 7: Commit.**

```bash
git add "src/app/(public)/start/page.tsx" src/lib/schemas.ts src/lib/schemas.test.ts tests/integration/pwa.test.ts
git commit -m "feat(pwa): /start routes the installed app by profile (#723)"
```

---

### Task 3: "Have a code?" on `/login`

**Files:**
- Modify: `src/app/(public)/login/page.tsx` (the idle state, around the "New here?" paragraph)
- Modify: `src/app/(public)/login/page.test.tsx`
- Modify: `docs/technical-architecture.md` (Authentication Flow → Magic Link, after the numbered code block)

**Interfaces:**
- Consumes: `HandoffCodeEntry` from `@/components/auth/handoff-code-entry`
  (no required props; renders a field labelled `Code`).

- [ ] **Step 1: Write the failing component test.** Add to the `LoginPage`
  describe in `page.test.tsx`:

```tsx
  it('reveals the handoff code entry without sending a link first', () => {
    render(<LoginPage />);
    expect(screen.queryByLabelText('Code')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Enter it' }));

    expect(screen.getByLabelText('Code')).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run it and see it fail.**
  `pnpm exec vitest run --project components "src/app/(public)/login/page.test.tsx"`.
  Expected: FAIL, no button named `Enter it`.

- [ ] **Step 3: Implement.** In `login/page.tsx`:
  - add `const [showCode, setShowCode] = useState(false);` beside the
    existing state
  - in the idle branch, directly before the
    `{/* For anyone who bookmarked /login before they had an account. */}`
    comment, insert the block below
  - change the "New here?" paragraph's `mt-6` to `mt-2`, so the two caption
    lines read as one footer

```tsx
          {/* A link opened in another browser shows a code. This reaches the
              field even when this page was reloaded in the meantime, as an
              installed app can be while the person is in Mail. */}
          {showCode ? (
            <HandoffCodeEntry />
          ) : (
            <p className="mt-6 type-caption">
              Have a code from the email link?{' '}
              <button type="button" className="text-teal" onClick={() => setShowCode(true)}>
                Enter it
              </button>
            </p>
          )}
```

  `HandoffCodeEntry` carries its own `mt-4`. If the "New here?" line then
  sits too tight under the code field, give it `mt-6` only when `showCode`
  is true; check by eye in Task 7.

- [ ] **Step 4: Run it and see it pass.** Same command; the whole file must
  pass.

- [ ] **Step 5: Docs.** In `docs/technical-architecture.md`, directly after
  the closing fence of the Magic Link numbered block (the one ending
  "5. Redirect to dashboard (teacher) or bookings (student), once a session
  exists"), add:

```markdown
An installed home-screen app keeps its own cookie jar, separate from the
browser's, so a link tapped in Mail opens in the browser and takes the code
branch; the app redeems the code like any second browser (#723). `/login`
offers the code field without a fresh request ("Have a code from the email
link?"), because iOS may reload a backgrounded installed app while the
person is reading their mail.
```

- [ ] **Step 6: Commit.**

```bash
git add "src/app/(public)/login/page.tsx" "src/app/(public)/login/page.test.tsx" docs/technical-architecture.md
git commit -m "feat(login): reach the handoff code field after a reload (#723)"
```

  `pnpm run verify` flags the `login` visual baseline as stale from here
  until Task 7. That is expected; Task 7 regenerates it.

---

### Task 4: Install support detection

**Files:**
- Create: `src/lib/install-support.ts`
- Create: `src/lib/install-support.test.ts`
- Create: `src/components/layout/install-store.ts`
- Create: `src/components/layout/install-store.test.ts`
- Create: `src/components/layout/install-listener.tsx`
- Create: `src/components/layout/install-listener.test.tsx`
- Modify: `src/app/layout.tsx` (mount `<InstallListener />` inside `<body>`)

**Interfaces:**
- Produces (`src/lib/install-support.ts`):
  - `type InstallSupport = 'unknown' | 'installed' | 'ios-safari' | 'prompt' | 'manual' | 'unsupported'`
  - `interface InstallEnv { userAgent: string; maxTouchPoints: number; displayModeStandalone: boolean; navigatorStandalone: boolean; promptHeld: boolean; promptUsed: boolean; appInstalled: boolean }`
  - `function classifyInstall(env: InstallEnv): Exclude<InstallSupport, 'unknown'>`
- Produces (`src/components/layout/install-store.ts`):
  - `interface InstallWindow` (the slice of `Window` the store reads)
  - `interface InstallStore { subscribe(listener: () => void): () => void; getSnapshot(): Exclude<InstallSupport, 'unknown'>; promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> }`
  - `function createInstallStore(win: InstallWindow): InstallStore`
  - `const installStore: InstallStore | null` (null on the server)
  - `function useInstallSupport(): InstallSupport`
  - `function useCoarsePointer(): boolean`
- Produces (`src/components/layout/install-listener.tsx`): `InstallListener`
  (renders nothing).

- [ ] **Step 1: Write the failing classifier tests**
  (`src/lib/install-support.test.ts`):

```ts
import { describe, it, expect } from 'vitest';
import { classifyInstall, type InstallEnv } from './install-support';

const UA = {
  iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  ipadDesktopSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  iosChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1',
  iosFirefox: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/127.0 Mobile/15E148 Safari/605.1.15',
  iosEdge: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 EdgiOS/125.0.2535.87 Mobile/15E148 Safari/605.1.15',
  iosGoogleApp: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) GSA/322.0.648915268 Mobile/15E148 Safari/604.1',
  iosInstagram: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 334.0.4.32.98 (iPhone15,2; iOS 17_5; en_US; en)',
  // Made up: a browser no denylist names, so only the Version/ rule excludes it.
  iosUnlisted: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari/604.1 ExampleBrowser/1.0',
  androidChrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  desktopChrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
} as const;

function env(overrides: Partial<InstallEnv>): InstallEnv {
  return {
    userAgent: UA.desktopChrome,
    maxTouchPoints: 0,
    displayModeStandalone: false,
    navigatorStandalone: false,
    promptHeld: false,
    promptUsed: false,
    appInstalled: false,
    ...overrides,
  };
}

describe('classifyInstall', () => {
  it.each([
    ['iPhone Safari', env({ userAgent: UA.iphoneSafari, maxTouchPoints: 5 }), 'ios-safari'],
    ['iPad Safari with the desktop user agent', env({ userAgent: UA.ipadDesktopSafari, maxTouchPoints: 5 }), 'ios-safari'],
    ['Chrome on iOS', env({ userAgent: UA.iosChrome, maxTouchPoints: 5 }), 'unsupported'],
    ['Firefox on iOS', env({ userAgent: UA.iosFirefox, maxTouchPoints: 5 }), 'unsupported'],
    ['Edge on iOS', env({ userAgent: UA.iosEdge, maxTouchPoints: 5 }), 'unsupported'],
    ['the Google app on iOS', env({ userAgent: UA.iosGoogleApp, maxTouchPoints: 5 }), 'unsupported'],
    ['an Instagram webview', env({ userAgent: UA.iosInstagram, maxTouchPoints: 5 }), 'unsupported'],
    ['an unlisted iOS browser that omits Version/', env({ userAgent: UA.iosUnlisted, maxTouchPoints: 5 }), 'unsupported'],
    ['Safari on a Mac', env({ userAgent: UA.macSafari, maxTouchPoints: 0 }), 'unsupported'],
    ['Android Chrome holding a prompt', env({ userAgent: UA.androidChrome, promptHeld: true }), 'prompt'],
    ['Android Chrome with no prompt yet', env({ userAgent: UA.androidChrome }), 'unsupported'],
    ['Android Chrome after its prompt was used', env({ userAgent: UA.androidChrome, promptUsed: true }), 'manual'],
    ['a fresh prompt after a used one', env({ userAgent: UA.androidChrome, promptUsed: true, promptHeld: true }), 'prompt'],
    ['desktop Chrome holding a prompt', env({ promptHeld: true }), 'prompt'],
    ['standalone by display-mode', env({ userAgent: UA.androidChrome, displayModeStandalone: true, promptHeld: true }), 'installed'],
    ['standalone by navigator.standalone', env({ userAgent: UA.iphoneSafari, maxTouchPoints: 5, navigatorStandalone: true }), 'installed'],
    ['a tab after appinstalled fired', env({ userAgent: UA.androidChrome, appInstalled: true }), 'installed'],
  ] as const)('%s → %s', (_label, input, expected) => {
    expect(classifyInstall(input)).toBe(expected);
  });
});
```

  Then add the store's failing tests (`src/components/layout/install-store.test.ts`,
  node environment; Node provides `EventTarget` and `Event`):

```ts
import { describe, it, expect, vi } from 'vitest';
import { createInstallStore, type InstallWindow } from './install-store';

function fakeWindow(userAgent = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36'): InstallWindow & EventTarget {
  return Object.assign(new EventTarget(), {
    navigator: { userAgent, maxTouchPoints: 5 },
    matchMedia: (): { matches: boolean } => ({ matches: false }),
  });
}

function promptEvent(outcome: 'accepted' | 'dismissed') {
  return Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
    prompt: vi.fn().mockResolvedValue(undefined),
    userChoice: Promise.resolve({ outcome, platform: 'web' }),
  });
}

describe('createInstallStore', () => {
  it('holds a beforeinstallprompt, cancels its default and notifies', () => {
    const win = fakeWindow();
    const store = createInstallStore(win);
    const listener = vi.fn();
    store.subscribe(listener);

    const event = promptEvent('accepted');
    win.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(store.getSnapshot()).toBe('prompt');
    expect(listener).toHaveBeenCalled();
  });

  it('ignores an event without a prompt method', () => {
    const win = fakeWindow();
    const store = createInstallStore(win);
    win.dispatchEvent(new Event('beforeinstallprompt', { cancelable: true }));
    expect(store.getSnapshot()).toBe('unsupported');
  });

  it('answers manual after a dismissed prompt, so a visible surface stays', async () => {
    const win = fakeWindow();
    const store = createInstallStore(win);
    win.dispatchEvent(promptEvent('dismissed'));

    expect(await store.promptInstall()).toBe('dismissed');
    expect(store.getSnapshot()).toBe('manual');
  });

  it('calls prompt() once when tapped twice while the dialog is open', async () => {
    const win = fakeWindow();
    const store = createInstallStore(win);
    const event = promptEvent('accepted');
    win.dispatchEvent(event);

    const first = store.promptInstall();
    const second = store.promptInstall();

    expect(await second).toBe('unavailable');
    expect(await first).toBe('accepted');
    expect(event.prompt).toHaveBeenCalledTimes(1);
  });

  it('answers installed once appinstalled fires', () => {
    const win = fakeWindow();
    const store = createInstallStore(win);
    win.dispatchEvent(new Event('appinstalled'));
    expect(store.getSnapshot()).toBe('installed');
  });

  it('answers unavailable when nothing is held', async () => {
    const store = createInstallStore(fakeWindow());
    expect(await store.promptInstall()).toBe('unavailable');
  });
});
```

- [ ] **Step 2: Run both and see them fail.**
  `pnpm exec vitest run --project unit src/lib/install-support.test.ts src/components/layout/install-store.test.ts`.
  Expected: FAIL, the modules cannot be resolved.

- [ ] **Step 3: Write `src/lib/install-support.ts`:**

```ts
/**
 * What this browser can do about installing fair.yoga. `unknown` is the
 * server's answer and the first client render's: nothing renders for it.
 */
export type InstallSupport = 'unknown' | 'installed' | 'ios-safari' | 'prompt' | 'manual' | 'unsupported';

export interface InstallEnv {
  userAgent: string;
  maxTouchPoints: number;
  /** `(display-mode: standalone)` matches. */
  displayModeStandalone: boolean;
  /** iOS's own flag for a home-screen launch. */
  navigatorStandalone: boolean;
  /** A `beforeinstallprompt` is captured and unused. */
  promptHeld: boolean;
  /** A captured prompt was spent; Chromium allows one `prompt()` per event. */
  promptUsed: boolean;
  /** `appinstalled` fired in this page. */
  appInstalled: boolean;
}

/** iPadOS Safari sends a Mac user agent; a touch screen gives it away. */
function isIos(env: InstallEnv): boolean {
  return /iPhone|iPad|iPod/.test(env.userAgent) || (/Macintosh/.test(env.userAgent) && env.maxTouchPoints > 1);
}

/** Browsers and webviews on iOS that are not Safari. Each either lacks the
 *  Share → Add to Home Screen route or puts it somewhere these steps do not
 *  describe. */
const NOT_SAFARI = /CriOS|FxiOS|EdgiOS|OPiOS|OPT\/|GSA\/|DuckDuckGo|YaBrowser|FBAN|FBAV|Instagram|Line\/|Snapchat|LinkedInApp|Pinterest/;

function isIosSafari(env: InstallEnv): boolean {
  return /Version\/[\d.]+.*Safari\//.test(env.userAgent) && !NOT_SAFARI.test(env.userAgent);
}

export function classifyInstall(env: InstallEnv): Exclude<InstallSupport, 'unknown'> {
  if (env.displayModeStandalone || env.navigatorStandalone || env.appInstalled) return 'installed';
  if (isIos(env)) return isIosSafari(env) ? 'ios-safari' : 'unsupported';
  if (env.promptHeld) return 'prompt';
  if (env.promptUsed) return 'manual';
  return 'unsupported';
}
```

- [ ] **Step 4: Write `src/components/layout/install-store.ts`:**

```ts
import { useSyncExternalStore } from 'react';
import { classifyInstall, type InstallSupport } from '@/lib/install-support';

/** The slice of `Window` the store reads; `window` satisfies it, and a test
 *  can hand in an `EventTarget` with these two members. */
export interface InstallWindow {
  addEventListener(type: string, listener: (event: Event) => void): void;
  navigator: { userAgent: string; maxTouchPoints: number; standalone?: boolean };
  matchMedia?: (query: string) => { matches: boolean };
}

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

function isBeforeInstallPrompt(event: Event): event is BeforeInstallPromptEvent {
  return 'prompt' in event && typeof event.prompt === 'function' && 'userChoice' in event;
}

export interface InstallStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): Exclude<InstallSupport, 'unknown'>;
  promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'>;
}

function matches(win: InstallWindow, query: string): boolean {
  return win.matchMedia ? win.matchMedia(query).matches : false;
}

export function createInstallStore(win: InstallWindow): InstallStore {
  let deferred: BeforeInstallPromptEvent | null = null;
  let promptUsed = false;
  let prompting = false;
  let appInstalled = false;
  const listeners = new Set<() => void>();
  const emit = (): void => listeners.forEach((listener) => listener());

  win.addEventListener('beforeinstallprompt', (event) => {
    if (!isBeforeInstallPrompt(event)) return;
    // Suppresses Chromium's own mini-infobar: the install card and row are
    // the only prompts.
    event.preventDefault();
    deferred = event;
    emit();
  });
  win.addEventListener('appinstalled', () => {
    deferred = null;
    appInstalled = true;
    emit();
  });

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot() {
      return classifyInstall({
        userAgent: win.navigator.userAgent,
        maxTouchPoints: win.navigator.maxTouchPoints,
        displayModeStandalone: matches(win, '(display-mode: standalone)'),
        navigatorStandalone: win.navigator.standalone === true,
        promptHeld: deferred !== null,
        promptUsed,
        appInstalled,
      });
    },
    async promptInstall() {
      if (deferred === null || prompting) return 'unavailable';
      const event = deferred;
      prompting = true;
      try {
        await event.prompt();
        const { outcome } = await event.userChoice;
        return outcome;
      } finally {
        deferred = null;
        promptUsed = true;
        prompting = false;
        emit();
      }
    },
  };
}

/** Created when this module first loads in a browser, not in an effect:
 *  `beforeinstallprompt` can fire before any component has mounted.
 *  `InstallListener` is what loads it on every page. */
export const installStore: InstallStore | null =
  typeof window === 'undefined' ? null : createInstallStore(window);

const noSubscription = (): (() => void) => () => {};

export function useInstallSupport(): InstallSupport {
  return useSyncExternalStore<InstallSupport>(
    installStore ? installStore.subscribe : noSubscription,
    () => (installStore ? installStore.getSnapshot() : 'unknown'),
    () => 'unknown',
  );
}

function subscribeCoarse(onChange: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const query = window.matchMedia('(pointer: coarse)');
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/** A phone or tablet. `false` on the server and the first client render. */
export function useCoarsePointer(): boolean {
  return useSyncExternalStore(
    subscribeCoarse,
    () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(pointer: coarse)').matches : false),
    () => false,
  );
}
```

  `subscribe` and `getSnapshot` are closures, not methods using `this`, so
  passing `installStore.subscribe` unbound is safe.

- [ ] **Step 5: Run both and see them pass.** Same command as Step 2.
  Expected: PASS.

- [ ] **Step 6: Write `src/components/layout/install-listener.tsx`** and
  mount it in `src/app/layout.tsx` as the first child of `<body>`:

```tsx
'use client';

import { installStore } from './install-store';

/**
 * Renders nothing. Importing the store from the root layout loads its
 * module, and with it the `beforeinstallprompt` listener, on every page —
 * before the Settings row or the Schedule card that read it may exist.
 */
export function InstallListener(): null {
  void installStore;
  return null;
}
```

- [ ] **Step 7: Review Focus 1, capture before any effect.** Write
  `src/components/layout/install-listener.test.tsx` (components project,
  jsdom):

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

describe('installStore', () => {
  it('captures a prompt that fired before any component rendered', async () => {
    vi.resetModules();
    const { useInstallSupport } = await import('./install-store');
    window.dispatchEvent(
      Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
        prompt: vi.fn().mockResolvedValue(undefined),
        userChoice: Promise.resolve({ outcome: 'accepted' as const, platform: 'web' }),
      }),
    );

    function Probe() {
      return <span>{useInstallSupport()}</span>;
    }
    render(<Probe />);

    expect(screen.getByText('prompt')).toBeInTheDocument();
  });
});
```

  Run `pnpm exec vitest run --project components src/components/layout/install-listener.test.tsx`.
  Expected: PASS.

  If the render reports an invalid hook call after `vi.resetModules()` (two
  copies of React), stop and report rather than restructuring the test.

  Mutation: replace the `installStore` initializer with `null`. That is what
  creating the store in an effect amounts to before any effect has run. The
  test FAILS, rendering `unknown`. Record the line, then restore the
  initializer **by hand**; `git checkout` would also discard this task's
  other uncommitted files. Confirm with `git diff src/components/layout/install-store.ts`.

- [ ] **Step 8: Mutation checks on the classifier.** One at a time: break it,
  run the unit file, record the failing case, restore.

  Two guards exclude non-Safari iOS browsers: the `Version/…Safari/`
  requirement, and the `NOT_SAFARI` denylist. Chrome, Firefox, the Google
  app and webviews omit `Version/`, so for them the denylist is a second
  line, and removing one of their markers **alone is inert by design**.
  Confirm that once for `CriOS|` (the suite stays green), then mutate the
  guard each case depends on alone:
  - Remove `EdgiOS|`: `Edge on iOS` fails (its user agent carries `Version/`).
  - Replace `/Version\/[\d.]+.*Safari\//` with `/Safari\//`:
    `an unlisted iOS browser that omits Version/` fails.
  - Remove `|| env.navigatorStandalone`: `standalone by navigator.standalone` fails.
  - Remove `&& env.maxTouchPoints > 1`: `Safari on a Mac` fails.
  - Delete `if (env.promptUsed) return 'manual';`: `after its prompt was used` fails.

  Finish with `git status` showing only this task's intended files.

- [ ] **Step 9: Commit.**

```bash
git add src/lib/install-support.ts src/lib/install-support.test.ts src/components/layout/install-store.ts src/components/layout/install-store.test.ts src/components/layout/install-listener.tsx src/components/layout/install-listener.test.tsx src/app/layout.tsx
git commit -m "feat(pwa): detect what this browser can do about installing (#723)"
```

---

### Task 5: The install steps and the permanent rows

**Files:**
- Create: `src/components/account/install-steps.tsx`
- Create: `src/components/account/install-app-row.tsx`
- Create: `src/components/account/install-app-row.test.tsx`
- Modify: `src/app/(teacher)/settings/page.tsx` (inside the list `<div>`, after the bookings link)
- Modify: `src/app/(student)/account/page.tsx` (inside the `SETTINGS_ITEMS` list `<div>`, after the map)
- Modify: `docs/information-architecture.md` (the Settings tree)

**Interfaces:**
- Consumes: `useInstallSupport`, `installStore` from
  `@/components/layout/install-store`.
- Produces: `InstallSteps({ variant }: { variant: 'ios' | 'manual' })`,
  used by Task 6; `InstallAppRow()`.

- [ ] **Step 1: Write the failing row tests**
  (`src/components/account/install-app-row.test.tsx`):

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { InstallSupport } from '@/lib/install-support';

let support: InstallSupport = 'unknown';
const promptInstall = vi.fn();
vi.mock('@/components/layout/install-store', () => ({
  useInstallSupport: () => support,
  installStore: { promptInstall: (...args: unknown[]) => promptInstall(...args) },
}));

import { InstallAppRow } from './install-app-row';

describe('InstallAppRow', () => {
  beforeEach(() => {
    promptInstall.mockReset();
  });

  it.each(['unknown', 'installed', 'unsupported'] as const)('renders nothing when support is %s', (value) => {
    support = value;
    const { container } = render(<InstallAppRow />);
    expect(container).toBeEmptyDOMElement();
  });

  it('expands the iOS steps in place', () => {
    support = 'ios-safari';
    render(<InstallAppRow />);
    const row = screen.getByRole('button', { name: 'Add to Home Screen' });
    expect(row).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(row);

    expect(row).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/Add to Home Screen\. You may need to scroll/)).toBeInTheDocument();
  });

  it('opens the browser prompt when one is held', () => {
    support = 'prompt';
    promptInstall.mockResolvedValue('accepted');
    render(<InstallAppRow />);
    fireEvent.click(screen.getByRole('button', { name: 'Add to Home Screen' }));
    expect(promptInstall).toHaveBeenCalledTimes(1);
  });

  it('shows the browser-menu route once the prompt is spent', () => {
    support = 'manual';
    render(<InstallAppRow />);
    fireEvent.click(screen.getByRole('button', { name: 'Add to Home Screen' }));
    expect(promptInstall).not.toHaveBeenCalled();
    expect(screen.getByText(/browser’s menu/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run them and see them fail.**
  `pnpm exec vitest run --project components src/components/account/install-app-row.test.tsx`.
  Expected: FAIL, the module cannot be resolved.

- [ ] **Step 3: Write `src/components/account/install-steps.tsx`:**

```tsx
/**
 * How to add fair.yoga to the Home Screen, in words. No arrow pointing at a
 * toolbar: where Safari's Share button sits differs by layout and device.
 * `manual` is Chromium after its one-shot prompt was used.
 */
export function InstallSteps({ variant }: { variant: 'ios' | 'manual' }) {
  if (variant === 'manual') {
    return (
      <p className="type-body">
        Open your browser’s menu (⋮) and choose Install app, or Add to Home screen.
      </p>
    );
  }
  return (
    <ol className="type-body list-decimal pl-5 space-y-1">
      <li>Tap Share in Safari’s toolbar. If you don’t see it, tap ⋯ first.</li>
      <li>Choose Add to Home Screen. You may need to scroll.</li>
      <li>Tap Add.</li>
    </ol>
  );
}
```

- [ ] **Step 4: Write `src/components/account/install-app-row.tsx`:**

```tsx
'use client';

import { useState } from 'react';
import { Icon } from '@/components/ui/icon';
import { installStore, useInstallSupport } from '@/components/layout/install-store';
import { InstallSteps } from './install-steps';

/**
 * The permanent way in: a Settings row wherever this browser can install the
 * app. Records nothing and has no dismissal.
 */
export function InstallAppRow() {
  const support = useInstallSupport();
  const [open, setOpen] = useState(false);

  if (support !== 'ios-safari' && support !== 'prompt' && support !== 'manual') return null;

  function handleClick(): void {
    if (support === 'prompt' && installStore) {
      void installStore.promptInstall();
      return;
    }
    setOpen((value) => !value);
  }

  return (
    <div className="border-b border-border last:border-b-0">
      <button
        type="button"
        onClick={handleClick}
        aria-expanded={support === 'prompt' ? undefined : open}
        className="flex items-center gap-3 w-full min-h-14 py-2 text-left"
      >
        <span className="flex-1 text-base text-ink">Add to Home Screen</span>
        <Icon name="chevron-right" size={20} className="text-brown-light" />
      </button>
      {open && (
        <div className="pb-4">
          <InstallSteps variant={support === 'ios-safari' ? 'ios' : 'manual'} />
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Run them and see them pass.** Same command as Step 2.

- [ ] **Step 6: Mount the rows.**
  - `src/app/(teacher)/settings/page.tsx`: import `InstallAppRow` and render
    `<InstallAppRow />` as the last child of the list `<div>`, after the
    `session?.studentId` bookings link.
  - `src/app/(student)/account/page.tsx`: import it and render
    `<InstallAppRow />` as the last child of the `<div>` that maps
    `SETTINGS_ITEMS`.

  Run `pnpm exec vitest run --project components "src/app/(student)/account/page.test.tsx"`.
  It must still pass: in jsdom the hook answers `unsupported`, so the row
  renders nothing there.

- [ ] **Step 7: Docs.** In `docs/information-architecture.md`'s Settings
  tree, insert before `└── Personal page preview`:

```
├── Add to Home Screen
│   └── Only where this browser can install the app: iOS Safari gets the steps, Chromium its own prompt. Students have the same row on Account
│
```

- [ ] **Step 8: Mutation check.** In `install-app-row.tsx`, delete
  `support !== 'manual' &&` from the guard. Re-run Step 2's command:
  `shows the browser-menu route once the prompt is spent` FAILS. Record it,
  restore, and re-run to PASS.

- [ ] **Step 9: Commit.**

```bash
git add src/components/account/install-steps.tsx src/components/account/install-app-row.tsx src/components/account/install-app-row.test.tsx "src/app/(teacher)/settings/page.tsx" "src/app/(student)/account/page.tsx" docs/information-architecture.md
git commit -m "feat(pwa): an Add to Home Screen row in Settings and Account (#723)"
```

---

### Task 6: The one-time install card

**Files:**
- Modify: `prisma/schema.prisma` (`enum OnboardingStep`)
- Create: `prisma/migrations/20261001140000_onboarding_step_install/migration.sql`
- Create: `src/components/schedule/install-card.tsx`
- Create: `src/components/schedule/install-card.test.tsx`
- Modify: `src/app/(teacher)/schedule/page.tsx` (render the card above `GettingStarted`)
- Modify: `tests/integration/teacher-signup-api.test.ts` (the `POST /api/account/onboarding` describe)
- Modify: `docs/information-architecture.md` (Onboarding flow)
- Modify: `docs/teacher-screens.md` (1.3)

**Interfaces:**
- Consumes: `useInstallSupport`, `useCoarsePointer`, `installStore` (Task 4);
  `InstallSteps` (Task 5); `OnboardingSkipButton({ step, ariaLabel, className, children })`
  from `./onboarding-skip-button`; `Button` from `@/components/ui/button`.
- Produces: `InstallCard({ dismissed }: { dismissed: boolean })`.

- [ ] **Step 1: Write the failing integration test.** In
  `tests/integration/teacher-signup-api.test.ts`, inside
  `describe('POST /api/account/onboarding'`, directly after the
  `refuses to dismiss the completion card while the checklist is unsettled`
  test:

```ts
  /**
   * `install` (#723) dismisses the install card, which shows whatever the
   * checklist's state, so its dismissal carries no settlement gate. The
   * fixture is still unsettled here (empty bio, no room, no class).
   */
  it('records install while the checklist is still unsettled', async () => {
    const res = await fetch(`${BASE_URL}/api/account/onboarding`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(onboardingToken), ...freshIp() },
      body: JSON.stringify({ step: 'install' }),
    });
    expect(res.status).toBe(200);

    const teacher = await prisma.teacher.findUnique({
      where: { id: onboardingTeacherId },
      select: { skippedOnboarding: true },
    });
    expect(teacher?.skippedOnboarding).toContain('install');
    expect(teacher?.skippedOnboarding).not.toContain('share');
  });
```

- [ ] **Step 2: Run it and see it fail.**
  `pnpm exec vitest run --project integration tests/integration/teacher-signup-api.test.ts`.
  Expected: the new test FAILS with 400, since `install` is not an
  `OnboardingStep`.

- [ ] **Step 3: The enum and its migration.** Add `install` as the last
  member of `enum OnboardingStep` in `prisma/schema.prisma`. Write
  `prisma/migrations/20261001140000_onboarding_step_install/migration.sql`
  by hand, since `prisma migrate dev` refuses a non-interactive shell:

```sql
-- AlterEnum
ALTER TYPE "OnboardingStep" ADD VALUE 'install';
```

  Cross-check it against
  `pnpm exec prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script`,
  run **before** applying, which must print the same statement. Then run
  `pnpm exec prisma generate` and `pnpm run worktree:down`, then
  `pnpm run worktree:up` (it applies pending migrations to this worktree's
  database and restarts its server on the new client). Run
  `pnpm run check-migrations`: PASS.

- [ ] **Step 4: Run the integration test and see it pass.** Same command as
  Step 2; the whole file must pass.

  Mutation: in `src/app/api/account/onboarding/route.ts`, change
  `if (parsed.data.step === 'share')` to
  `if (parsed.data.step === 'share' || parsed.data.step === 'install')`.
  The new test FAILS with 409. Record it, restore, and re-run to PASS.

- [ ] **Step 5: Write the failing card tests**
  (`src/components/schedule/install-card.test.tsx`):

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { InstallSupport } from '@/lib/install-support';
import { routerRefresh } from '../../../tests/setup/components';

let support: InstallSupport = 'unknown';
let coarse = true;
const promptInstall = vi.fn();
vi.mock('@/components/layout/install-store', () => ({
  useInstallSupport: () => support,
  useCoarsePointer: () => coarse,
  installStore: { promptInstall: (...args: unknown[]) => promptInstall(...args) },
}));

type CardModule = typeof import('./install-card');
let InstallCard: CardModule['InstallCard'];
const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<{ ok: boolean }>>();

function postedSteps(): string[] {
  return fetchMock.mock.calls.map(([, init]) => {
    const body: unknown = JSON.parse(String(init?.body));
    return typeof body === 'object' && body !== null && 'step' in body ? String(body.step) : '';
  });
}

describe('InstallCard', () => {
  beforeEach(async () => {
    // The card keeps a once-per-page guard at module scope; a fresh module
    // per test keeps one test's post from silencing the next.
    vi.resetModules();
    ({ InstallCard } = await import('./install-card'));
    support = 'unknown';
    coarse = true;
    promptInstall.mockReset();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders nothing once dismissed, whatever the browser', () => {
    support = 'ios-safari';
    const { container } = render(<InstallCard dismissed />);
    expect(container).toBeEmptyDOMElement();
  });

  it.each(['unknown', 'unsupported'] as const)('renders nothing when support is %s', (value) => {
    support = value;
    const { container } = render(<InstallCard dismissed={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('stays off a desktop browser that holds a prompt', () => {
    support = 'prompt';
    coarse = false;
    const { container } = render(<InstallCard dismissed={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the iOS steps, and Done records the dismissal', async () => {
    support = 'ios-safari';
    render(<InstallCard dismissed={false} />);
    expect(screen.getByRole('heading', { name: 'Use fair.yoga as an app' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show me how' }));
    expect(screen.getByText('Tap Add.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Done/ }));
    await waitFor(() => expect(postedSteps()).toEqual(['install']));
    expect(routerRefresh).toHaveBeenCalled();
  });

  it('records the dismissal when the browser prompt is accepted', async () => {
    support = 'prompt';
    promptInstall.mockResolvedValue('accepted');
    render(<InstallCard dismissed={false} />);

    fireEvent.click(screen.getByRole('button', { name: 'Install' }));

    await waitFor(() => expect(postedSteps()).toEqual(['install']));
    expect(routerRefresh).toHaveBeenCalled();
  });

  it('records nothing when the browser prompt is cancelled', async () => {
    support = 'prompt';
    promptInstall.mockResolvedValue('dismissed');
    render(<InstallCard dismissed={false} />);

    fireEvent.click(screen.getByRole('button', { name: 'Install' }));

    await waitFor(() => expect(promptInstall).toHaveBeenCalled());
    // Let the awaited outcome settle before asserting nothing was posted.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows the browser-menu route once the prompt is spent', () => {
    support = 'manual';
    render(<InstallCard dismissed={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show me how' }));
    expect(screen.getByText(/browser’s menu/)).toBeInTheDocument();
  });

  it('Dismiss records the dismissal', async () => {
    support = 'ios-safari';
    render(<InstallCard dismissed={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss the install card' }));
    await waitFor(() => expect(postedSteps()).toEqual(['install']));
  });

  it('retires itself once, quietly, inside the installed app', async () => {
    support = 'installed';
    const first = render(<InstallCard dismissed={false} />);
    expect(first.container).toBeEmptyDOMElement();
    first.unmount();
    render(<InstallCard dismissed={false} />);

    await waitFor(() => expect(postedSteps()).toEqual(['install']));
    expect(routerRefresh).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 6: Run them and see them fail.**
  `pnpm exec vitest run --project components src/components/schedule/install-card.test.tsx`.
  Expected: FAIL, the module cannot be resolved.

- [ ] **Step 7: Write `src/components/schedule/install-card.tsx`:**

```tsx
'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { InstallSteps } from '@/components/account/install-steps';
import { installStore, useCoarsePointer, useInstallSupport } from '@/components/layout/install-store';
import { logRequestFailure } from '@/lib/client-errors';
import { OnboardingSkipButton } from './onboarding-skip-button';

let recording: Promise<boolean> | null = null;

/** Posts the `install` dismissal at most once per page load: the Schedule can
 *  mount many times in one session of the installed app. A failed post is
 *  not retried until the next load. */
function recordInstallOnce(): Promise<boolean> {
  recording ??= fetch('/api/account/onboarding', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ step: 'install' }),
  }).then(
    (res) => {
      if (!res.ok) console.error('[install-card] refused', { status: res.status });
      return res.ok;
    },
    (err: unknown) => {
      logRequestFailure('install-card', { step: 'install' }, err);
      return false;
    },
  );
  return recording;
}

/**
 * The one-time nudge to install, above Getting started on the Schedule. Shows
 * on a phone that can install, whatever the checklist's state, until
 * dismissed — by Dismiss, by Done after the steps, by an accepted install
 * prompt, or by opening the Schedule inside the installed app.
 */
export function InstallCard({ dismissed }: { dismissed: boolean }) {
  const support = useInstallSupport();
  const coarse = useCoarsePointer();
  const router = useRouter();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!dismissed && support === 'installed') void recordInstallOnce();
  }, [dismissed, support]);

  if (dismissed) return null;
  const visible = support === 'ios-safari' || ((support === 'prompt' || support === 'manual') && coarse);
  if (!visible) return null;

  async function handlePrimary(): Promise<void> {
    if (support !== 'prompt' || !installStore) {
      setOpen(true);
      return;
    }
    const outcome = await installStore.promptInstall();
    if (outcome === 'accepted' && (await recordInstallOnce())) router.refresh();
  }

  return (
    <div className="bg-sand-soft border border-border rounded-card p-5 mb-6">
      <h2 className="type-subtitle">Use fair.yoga as an app</h2>
      <p className="type-caption mt-0.5 mb-4">
        Open it from your Home Screen, full screen, one tap away.
      </p>
      {open ? (
        <>
          <InstallSteps variant={support === 'ios-safari' ? 'ios' : 'manual'} />
          <div className="mt-4">
            <OnboardingSkipButton
              step="install"
              ariaLabel="Done adding fair.yoga to your Home Screen"
              className="type-label text-teal px-3 min-h-11"
            >
              Done
            </OnboardingSkipButton>
          </div>
        </>
      ) : (
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <Button onClick={() => void handlePrimary()}>
            {support === 'prompt' ? 'Install' : 'Show me how'}
          </Button>
          <OnboardingSkipButton
            step="install"
            ariaLabel="Dismiss the install card"
            className="type-label text-brown-light px-3 min-h-11 shrink-0"
          >
            Dismiss
          </OnboardingSkipButton>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 8: Run them and see them pass.** Same command as Step 6.

- [ ] **Step 9: Mount the card.** In `src/app/(teacher)/schedule/page.tsx`,
  import `InstallCard` and render it directly above the
  `{!isOnboardingComplete(onboardingInput) && (` block:

```tsx
      <InstallCard dismissed={teacher.skippedOnboarding.includes('install')} />
```

  `skippedOnboarding` is already selected by that page's teacher query.

- [ ] **Step 10: Mutation checks.** One at a time: break it, run Step 6's
  command, record the failing test, restore.
  - Delete `if (dismissed) return null;`: `renders nothing once dismissed` fails.
  - Replace `&& coarse` with nothing: `stays off a desktop browser` fails.
  - Replace `recording ??=` with `recording =`: `retires itself once` fails
    (two posts).
  - Add `router.refresh()` after `void recordInstallOnce()` in the effect:
    `retires itself once, quietly` fails.

- [ ] **Step 11: Docs.**
  - `docs/information-architecture.md`, Onboarding flow: after the
    paragraph beginning "Each row takes the teacher to the real screen",
    add:

```markdown
**Install card.** Above the checklist, on a phone where the browser can install the app, a one-time card offers to add fair.yoga to the Home Screen. It does not wait for the checklist — a teacher who set up on a laptop meets it on their first phone visit — and it retires for good on Dismiss, on Done after the iOS steps, on an accepted install prompt, or when the Schedule first opens inside the installed app. Its dismissal is the `install` member of `OnboardingStep`, stored on the teacher, so it holds across devices.
```

  - `docs/teacher-screens.md` 1.3: add a bullet before the `*Leads to:*`
    line:

```markdown
- Above the checklist, on a phone that can install the app, a one-time install card (Show me how / Install, Dismiss). It does not wait for the checklist, and retires on Dismiss, on Done, on an accepted install, or when the Schedule opens in the installed app
```

- [ ] **Step 12: Commit.**

```bash
git add prisma/schema.prisma prisma/migrations/20261001140000_onboarding_step_install/migration.sql src/components/schedule/install-card.tsx src/components/schedule/install-card.test.tsx "src/app/(teacher)/schedule/page.tsx" tests/integration/teacher-signup-api.test.ts docs/information-architecture.md docs/teacher-screens.md
git commit -m "feat(pwa): a one-time install card above Getting started (#723)"
```

---

### Task 7: Visual baselines

**Files:**
- Modify: `tests/e2e/visual.spec.ts` (inside `test.describe('Visual regression'`)
- Modify: `tests/e2e/visual.spec.ts-snapshots/login-chromium-darwin.png`, `login-Mobile-Chrome-darwin.png`
- Possibly modify: `tests/e2e/visual-baseline-attestations.json` (via the attest script)

**Interfaces:**
- Consumes: the `beforeinstallprompt` listener from Task 4.

- [ ] **Step 1: Review Focus 5, deterministic baselines.** Inside
  `test.describe('Visual regression', () => {`, after
  `test.describe.configure({ mode: 'serial' });`, add:

```ts
  // Whether this Chromium fires beforeinstallprompt is not ours to pin: when
  // it does, the install card and row would appear on some runs. A capture
  // listener registered first stops the page's own from ever seeing it.
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.addEventListener('beforeinstallprompt', (event) => event.stopImmediatePropagation(), { capture: true });
    });
  });
```

- [ ] **Step 2: Regenerate.** With `pnpm run worktree:up` running, run
  `pnpm exec playwright test visual --update-snapshots`. Then run
  `git status tests/e2e/visual.spec.ts-snapshots`:
  - `login-*.png` must change (Task 3's caption line). Open both and check
    the footer reads as one caption group.
  - `schedule-*.png` and `settings-*.png` should be unchanged: neither the
    card nor the row may render in either project. If either changed, open
    it. A visible card or row means Step 1 did not hold, so stop and report.
    Any other difference is unexplained, so stop and report too.

- [ ] **Step 3: Attest the unchanged routes.** `schedule` and `settings`
  changed source without changing pixels. Run
  `pnpm run attest-visual-baseline schedule "the install card renders only on the client, for a browser that can install"`
  and
  `pnpm run attest-visual-baseline settings "the install row renders only on the client, for a browser that can install"`.
  Then run `pnpm run check-visual-baseline-freshness`: PASS.

- [ ] **Step 4: Full verification.** Run `pnpm run verify` (typecheck,
  lint, the whole vitest suite, lockfile, migrations, baseline freshness).
  Expected: PASS. Then run `pnpm run build`, which catches a server-only
  module leaking into a client component.

- [ ] **Step 5: Commit.**

```bash
git add tests/e2e/visual.spec.ts tests/e2e/visual.spec.ts-snapshots/login-chromium-darwin.png tests/e2e/visual.spec.ts-snapshots/login-Mobile-Chrome-darwin.png tests/e2e/visual-baseline-attestations.json
git commit -m "test(visual): login baseline, install surfaces held out of the rest (#723)"
```

  Stage `visual-baseline-attestations.json` only if Step 3 changed it.
