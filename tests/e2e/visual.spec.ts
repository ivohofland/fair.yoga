import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import path from 'path';
import { accountIdOfTeacher } from './account-helpers';
import { uniqueSuffix, seedSession, sessionCookie } from '../helpers';

/**
 * Visual regression: screenshot baselines for the design system's key
 * screens. The design has no motion and system fonts, so same-platform
 * renders are stable; rendered dates are frozen to a constant string
 * (see freezeDates) and remaining dynamic text (timestamps) is masked.
 *
 * Baselines are platform-suffixed (-darwin/-linux). When a platform has
 * no baselines (currently CI/linux), the suite skips itself rather than
 * failing — regenerate with:  npx playwright test visual --update-snapshots
 */

const snapshotDir = path.join(__dirname, 'visual.spec.ts-snapshots');
const hasBaselines =
  fs.existsSync(snapshotDir) &&
  fs.readdirSync(snapshotDir).some((f) => f.includes(process.platform));
// Outside CI a missing baseline should fail loudly (it writes the actual
// for review); in CI a baseline-less platform silently has no coverage.
test.skip(Boolean(process.env.CI) && !hasBaselines, 'no visual baselines for this platform');

const prisma = new PrismaClient();

const suffix = uniqueSuffix();
const slug = `e2e-visual-${suffix}`;

let teacherId: string;
let teacherToken: string;
let roomId: string;
let classId: string;
let studioTemplateId: string;

async function signIn(context: BrowserContext): Promise<void> {
  await context.addCookies([sessionCookie(teacherToken)]);
}

/** All caption/label text — relative dates and timestamps live there. */
function dynamicText(page: Page) {
  return [page.locator('.type-caption'), page.locator('.type-label')];
}

// Month/weekday name lists, factored out once both regexes below needed a
// third variant of them. Spelled out inline six times across two patterns,
// the abbreviated-vs-full distinction (see DATE_PATTERN's comment) was easy
// to lose track of — which is exactly how it got lost once already.
// DATE_SMELL's lists additionally drop "May": it's an ordinary English word,
// and DATE_SMELL scans real body text, not formatter output.
const WEEKDAYS = 'Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday';
const MONTHS_FULL = 'January|February|March|April|May|June|July|August|September|October|November|December';
const MONTHS_ABBR = 'Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec';
const MONTHS_FULL_NO_MAY = 'January|February|March|April|June|July|August|September|October|November|December';
const MONTHS_ABBR_NO_MAY = 'Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec';

// The seeded class sits on "Tuesday of next week", so rendered dates drift
// as real time advances — and even masked date labels drift, because a
// mask's box follows the text's pixel width. Freeze every rendered date to
// one synthetic constant before screenshotting. Covers the three shapes
// #96 renders across the app: "Tuesday, 21 Jul" (formatDayHeader — weekday,
// day-first, abbreviated month, no year), "21 Jul 2026" (formatDateWithYear
// — day-first, abbreviated month, year, *no* weekday), and bare "21 Jul"
// (formatDateShort — day-first, abbreviated month, no year, no weekday; no
// screenshotted screen renders this today, but #96 made it one of three
// primary formatters, so the freezer has to recognize it regardless).
//
// The two weekday-less alternatives accept *abbreviated* months only, never
// full names — deliberately, not an oversight: formatDateWithYear and
// formatDateShort only ever emit abbreviations (`format.ts` keeps the
// abbreviated `MONTHS` private and separate from the exported `FULL_MONTHS`
// for exactly this reason). Restricting these two alternatives to
// abbreviations is what protects the schedule's "Week of 4 August" week
// heading (`class-list.tsx`'s local `weekLabel`, untouched by #96) in eleven
// months of twelve — today it's dormant because the seed date always reads
// "This/Next/Last week", never the "Week of …" fallback (see beforeAll) —
// but even if that ever changed, the heading must stay *unmatched* here so
// it stays visible to DATE_SMELL below, not silently frozen away.
//
// The exception is May: `MONTHS_ABBR` includes "May" because it is also its
// own three-letter abbreviation, so a genuine "Week of 4 May" heading *is*
// matched and frozen here ("Someday, Mmm 0"), unprotected. Do not "fix" this
// by excluding May from the weekday-less alternatives — a real
// `formatDateShort` output of "12 May" would then escape freezing, and
// DATE_SMELL drops "May" too (see above), so it would drift a baseline
// silently instead of failing the run. That trade — one month's week
// heading goes unprotected rather than a real date escaping — is deliberate.
//
// A trailing `\b` after the abbreviation stops it matching as a bare prefix
// of a full month word (e.g. "Aug" inside "August"), which would otherwise
// strand the remainder ("ust") as leftover text instead of declining to
// match at all.
//
// Alternatives are ordered most-specific first — weekday-prefixed (which
// legitimately accepts both full and abbreviated months, and both a
// month-first and a day-first shape — old-format fixtures may still need
// the former), then weekday-less-with-year, then bare. That ordering
// guarantees the weekday is never stranded: once the weekday-prefixed
// alternative starts consuming a match, nothing hands off mid-string to a
// less-specific one. It does not, by itself, guarantee a year is never
// stranded — the weekday-prefixed alternative's day-first branch needs its
// own optional year tail, matching its month-first sibling's, or
// "Friday, 12 Jun 2026" matches only "Friday, 12 Jun" and leaves " 2026"
// stranded behind it.
const DATE_PATTERN = new RegExp(
  `(?:${WEEKDAYS}), (?:(?:${MONTHS_FULL}|${MONTHS_ABBR}) \\d{1,2}(?:, \\d{4})?|\\d{1,2} (?:${MONTHS_FULL}|${MONTHS_ABBR})(?: \\d{4})?)` +
    `|\\d{1,2} (?:${MONTHS_ABBR})\\b \\d{4}` +
    `|\\d{1,2} (?:${MONTHS_ABBR})\\b`,
);

// Looser than DATE_PATTERN on purpose: any weekday/month token that
// survives freezing — a format DATE_PATTERN doesn't know, a "Week of …"
// header, a late revert — should fail the run, not drift the baseline.
// The day-first alternative mirrors DATE_PATTERN's bare "21 Jul" shape
// (formatDateShort); without it, a lone day-first date could escape
// freezing and drift a baseline silently instead of failing the run.
const DATE_SMELL = new RegExp(
  `\\b(?:${WEEKDAYS}|${MONTHS_FULL_NO_MAY})\\b` +
    `|\\b(?:${MONTHS_ABBR_NO_MAY}) \\d` +
    `|\\d{1,2} (?:${MONTHS_FULL_NO_MAY}|${MONTHS_ABBR_NO_MAY})`,
);

// Runs in the browser via page.evaluate (hence the pattern arriving as a
// source string); returns true if it rewrote anything.
function rewriteDates(source: string): boolean {
  const pattern = new RegExp(source, 'g');
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let found = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent ?? '';
    const frozen = text.replace(pattern, 'Someday, Mmm 0');
    if (frozen !== text) {
      node.textContent = frozen;
      found = true;
    }
  }
  return found;
}

// Runs in the browser via page.evaluate. `Element.innerText` includes every
// <option> in a closed <select> — selected or not — even though a
// screenshot only ever rasterizes the one currently showing. Hiding an
// <option> directly does not remove it from `innerText`; hiding the
// <select> itself does, the same as it would for any other element, and
// restoring `display` afterward reproduces the original text exactly.
// Scoped to <select> elements themselves, not to any text they contain, so
// a bare weekday elsewhere on the page is unaffected and still reaches the
// check below.
function bodyTextForSmellCheck(): string {
  const hidden = Array.from(document.querySelectorAll('select')).map((select) => ({
    select,
    previousDisplay: select.style.display,
  }));
  hidden.forEach(({ select }) => {
    select.style.display = 'none';
  });
  const text = document.body.innerText;
  hidden.forEach(({ select, previousDisplay }) => {
    select.style.display = previousDisplay;
  });
  return text;
}

async function freezeDates(page: Page): Promise<void> {
  // React's hydration pass reverts DOM rewrites it didn't render (and, in
  // dev, pops the error-overlay badge), so a single rewrite races it.
  // Rewrite until the result survives three consecutive checks.
  let stable = 0;
  for (let i = 0; i < 40 && stable < 3; i++) {
    const rewrote = await page.evaluate(rewriteDates, DATE_PATTERN.source);
    stable = rewrote ? 0 : stable + 1;
    await page.waitForTimeout(150);
  }
  // Any date-shaped text that escapes the freeze would silently drift the
  // baseline weeks from now — fail loudly today instead.
  expect(await page.evaluate(bodyTextForSmellCheck)).not.toMatch(DATE_SMELL);
}

/**
 * Teacher pages: resolve once the LiveUpdates effect opens the SSE stream.
 * Effects run only after hydration, so the request doubles as a reliable
 * "hydration finished" signal. Must be armed before page.goto.
 *
 * `waitForResponse` resolves on response HEADERS, so this says the
 * stream OPENED — never that it stayed open. Do not read it, or a
 * trace, as evidence about the stream's lifetime: a trace's `time`
 * for an unfinished SSE response is the wait for headers, nothing
 * more (`receive: -1`). In the measured trace an open stream reported
 * `time: 18.7ms` — that number is what issue #41 read as the stream
 * dying. Full measurement:
 * docs/superpowers/specs/2026-08-08-sse-stream-liveness-design.md
 *
 * The property this cannot check is checked by
 * `tests/integration/notifications-stream.test.ts`.
 */
function hydrationSignal(page: Page): Promise<unknown> {
  return page.waitForResponse((r) => r.url().includes('/api/notifications/stream'));
}

const hideDevOverlay = path.join(__dirname, 'visual-hide-dev-overlay.css');

test.describe('Visual regression', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    await prisma.$connect();
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Visual',
        lastName: 'Teacher',
        email: `e2e-visual-${suffix}@test.local`,
        account: { create: { email: `e2e-visual-${suffix}@test.local` } },
        bio: 'Calm vinyasa in a warm room.',
        pageSlug: slug,
      },
    });
    teacherId = teacher.id;
    teacherToken = await seedSession(prisma, await accountIdOfTeacher(prisma, teacherId));

    const room = await prisma.room.create({
      data: {
        venueName: 'Visual Studio',
        address: `${suffix} Visual St`,
        city: 'Amsterdam',
        postcode: '1234VS',
        floor: '1',
        roomName: 'Main',
        maxCapacity: 20,
        createdById: teacherId,
      },
    });
    roomId = room.id;
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId, roomId, capacityOverride: 12, rentalRate: 30 },
    });

    // Tuesday of next week: always inside the window, and the schedule's
    // week header reads the stable "Next week" on any run day (a farther
    // date would render a changing "Week of …" heading, which is not
    // masked — headers share type-subtitle with card titles).
    const soon = new Date();
    soon.setUTCDate(soon.getUTCDate() + (8 - (soon.getUTCDay() || 7)) + 1);
    const cls = await prisma.class.create({
      data: {
        teacherId,
        teacherRoomId: teacherRoom.id,
        classType: 'Visual Vinyasa',
        date: new Date(Date.UTC(soon.getUTCFullYear(), soon.getUTCMonth(), soon.getUTCDate())),
        startTime: '09:00',
        durationMinutes: 60,
        roomCost: 20,
        minRate: 15,
        targetRate: 25,
        minStudents: 2,
        maxStudents: 10,
        status: 'open',
      },
    });
    classId = cls.id;

    await prisma.notification.create({
      data: {
        recipientType: 'teacher',
        recipientId: teacherId,
        type: 'booking_confirmed',
        title: 'New booking',
        body: 'Someone booked Visual Vinyasa.',
        relatedClassId: classId,
      },
    });

    // Paused, deliberately: `!isActive` is what draws BOTH controls, and a
    // paused template generates nothing, so `schedule.png` is untouched.
    // Wednesday 18:00 — a different (dayOfWeek, startTime) from the fixture
    // class at Tuesday 09:00, so nothing can brush #296's slot guards.
    const studioTemplate = await prisma.studioClassTemplate.create({
      data: {
        teacherId,
        classType: 'Visual Studio Flow',
        dayOfWeek: 2, // 0 = Monday in this schema, so 2 is Wednesday
        startTime: '18:00',
        durationMinutes: 75,
        location: 'Visual Community Studio',
        hourlyRate: 42,
        isActive: false,
      },
    });
    studioTemplateId = studioTemplate.id;
  });

  test.afterAll(async () => {
    await prisma.notification.deleteMany({ where: { relatedClassId: classId } });
    await prisma.studioClassTemplate.deleteMany({ where: { teacherId } });
    await prisma.class.deleteMany({ where: { teacherId } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    await prisma.room.delete({ where: { id: roomId } });
    await prisma.session.deleteMany({ where: { accountId: await accountIdOfTeacher(prisma, teacherId) } });
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.$disconnect();
  });

  test('login', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByLabel('Email')).toBeVisible();
    await freezeDates(page);
    await expect(page).toHaveScreenshot('login.png', { fullPage: true, stylePath: hideDevOverlay });
  });

  test('public teacher page', async ({ page }) => {
    await page.goto(`/${slug}`);
    await expect(page.getByText('Visual Vinyasa')).toBeVisible();
    await freezeDates(page);
    await expect(page).toHaveScreenshot('public-page.png', {
      fullPage: true,
      mask: dynamicText(page),
      stylePath: hideDevOverlay,
    });
  });

  test('teacher schedule', async ({ page, context }) => {
    await signIn(context);
    const hydrated = hydrationSignal(page);
    await page.goto('/');
    await expect(page.getByText('Visual Vinyasa')).toBeVisible();
    await hydrated;
    await freezeDates(page);
    await expect(page).toHaveScreenshot('schedule.png', {
      fullPage: true,
      mask: dynamicText(page),
      stylePath: hideDevOverlay,
    });
  });

  test('class detail (open)', async ({ page, context }) => {
    await signIn(context);
    const hydrated = hydrationSignal(page);
    await page.goto(`/class/${classId}`);
    await expect(page.getByText('Open for registration')).toBeVisible();
    await hydrated;
    await freezeDates(page);
    await expect(page).toHaveScreenshot('class-detail-open.png', {
      fullPage: true,
      mask: dynamicText(page),
      stylePath: hideDevOverlay,
    });
  });

  test('inbox with unread', async ({ page, context }) => {
    await signIn(context);
    const hydrated = hydrationSignal(page);
    await page.goto('/inbox');
    await expect(page.getByText('New booking')).toBeVisible();
    await hydrated;
    await freezeDates(page);
    await expect(page).toHaveScreenshot('inbox.png', {
      fullPage: true,
      mask: dynamicText(page),
      stylePath: hideDevOverlay,
    });
  });

  test('settings index', async ({ page, context }) => {
    await signIn(context);
    const hydrated = hydrationSignal(page);
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await hydrated;
    await freezeDates(page);
    await expect(page).toHaveScreenshot('settings.png', { fullPage: true, stylePath: hideDevOverlay });
  });

  test('studio template detail (paused)', async ({ page, context }) => {
    await signIn(context);
    const hydrated = hydrationSignal(page);
    await page.goto(`/settings/studio-classes/${studioTemplateId}`);
    await expect(page.getByText('Resume studio class')).toBeVisible();
    await hydrated;
    await freezeDates(page);
    await expect(page).toHaveScreenshot('studio-template.png', {
      fullPage: true,
      stylePath: hideDevOverlay,
    });
  });
});
