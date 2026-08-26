import { test, expect } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import { accountIdOfTeacher } from './account-helpers';
import { uniqueSuffix, seedSession, sessionCookie } from '../helpers';
import { timeToHHmm } from '@/lib/time-of-day';

/**
 * The recurring-class lifecycle, end to end: template created through
 * the settings UI → creation itself fills the rolling four-week window
 * → instances are real open classes on the schedule. Also pins cron
 * idempotency: re-firing over the already-filled window creates nothing.
 */

const prisma = new PrismaClient();

/** CRON_SECRET from the environment (CI) or .env (local). */
function cronSecret(): string {
  if (process.env.CRON_SECRET) return process.env.CRON_SECRET;
  const env = fs.readFileSync('.env', 'utf8');
  const match = /^CRON_SECRET=(.*)$/m.exec(env);
  if (!match) throw new Error('CRON_SECRET not found in environment or .env');
  return match[1]!.trim().replace(/^"|"$/g, '');
}

const suffix = uniqueSuffix();

// Three days from now, so the template's weekday never lands on the run
// day itself. On the run day the counts turn time-of-day-dependent: the
// generator skips today's occurrence once its start time has passed — a
// fixed weekday made this suite fail every time CI ran on that weekday.
// (A second source of that time-of-day dependence used to sit here: the
// template sync skipped today's instance too. #194 deleted it, so the
// generator is now the only one, and the reason to stay off the run day
// is unchanged.)
const templateDate = new Date();
templateDate.setUTCDate(templateDate.getUTCDate() + 3);
const templateJsDay = templateDate.getUTCDay();
const templateDayName = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][
  templateJsDay
]!;

let teacherId: string;
let teacherToken: string;
let roomId: string;
let templateId: string;

test.describe('Recurring classes', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    await prisma.$connect();
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Recurring',
        lastName: 'Teacher',
        email: `e2e-recurring-${suffix}@test.local`,
        account: { create: { email: `e2e-recurring-${suffix}@test.local` } },
        bio: 'Recurring e2e fixtures',
        pageSlug: `e2e-recurring-${suffix}`,
      },
    });
    teacherId = teacher.id;
    teacherToken = await seedSession(prisma, await accountIdOfTeacher(prisma, teacherId));

    const room = await prisma.room.create({
      data: {
        venueName: 'Recurring Studio',
        address: `${suffix} Recurring St`,
        city: 'Amsterdam',
        postcode: '1234RC',
        floor: '1',
        roomName: 'Main',
        maxCapacity: 20,
        createdById: teacherId,
      },
    });
    roomId = room.id;
    await prisma.teacherRoom.create({
      data: { teacherId, roomId, capacityOverride: 12, rentalRate: 25 },
    });
  });

  test.afterAll(async () => {
    await prisma.calendarEntry.deleteMany({ where: { teacherId } });
    // `ClassTemplate` is `onDelete: Cascade` from `ScheduleRule` (issue 298),
    // so deleting the rules removes the templates with them.
    await prisma.scheduleRule.deleteMany({ where: { teacherId } });
    // Again, after the templates are gone. This spec fires the *global*
    // generate-classes cron (see below) — `generateClassInstances` takes no
    // teacher scope — so a concurrently-running group can top this teacher's
    // template back up in the window between the two deletes above. The
    // template delete then succeeds (`Class.template` is SetNull) and the
    // regenerated classes survive to make the `teacherRoom` delete below fail
    // with P2003 (`Class.teacherRoom` has no onDelete, so Restrict), stranding
    // the room, session and teacher rows under a cleanup error. `workers: 1`
    // closes the window today; this closes the hole (#290).
    await prisma.calendarEntry.deleteMany({ where: { teacherId } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    await prisma.room.delete({ where: { id: roomId } });
    await prisma.session.deleteMany({ where: { accountId: await accountIdOfTeacher(prisma, teacherId) } });
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.$disconnect();
  });

  test.beforeEach(async ({ context }) => {
    await context.addCookies([sessionCookie(teacherToken)]);
  });

  test('creates a template through settings', async ({ page }) => {
    await page.goto('/settings/recurring/new');

    await page.getByLabel('Class type').fill('Recurring Flow');
    await page.getByLabel('Room', { exact: true }).selectOption({ index: 1 });
    await page.getByLabel('Day').selectOption(templateDayName);
    await page.getByLabel('Start time').fill('08:15');
    await page.getByLabel('Min students').fill('1');
    await page.getByLabel('Max students').fill('8');
    await page.getByRole('button', { name: 'Create', exact: true }).click();

    await page.waitForURL('**/settings/recurring', { timeout: 10_000 });
    await expect(page.getByText('Recurring Flow')).toBeVisible();
    await expect(page.getByText(`${templateDayName} 08:15`)).toBeVisible();

    const template = await prisma.classTemplate.findFirstOrThrow({
      where: { scheduleRule: { teacherId, classType: 'Recurring Flow' } },
      include: { scheduleRule: true },
    });
    templateId = template.id;
    expect(template.scheduleRule.isActive).toBe(true);

    // No cron has fired: creation itself filled the four-week window,
    // and the schedule shows it immediately.
    expect(await prisma.class.count({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: templateId } } } } } })).toBe(4);
    await page.goto('/');
    await expect(page.getByText('Recurring Flow').first()).toBeVisible();
  });

  // Creation already filled the window; the cron's job is topping up
  // later weeks and never duplicating what exists.
  test('the generation cron is idempotent over the already-filled window', async () => {
    const fire = () =>
      fetch('http://localhost:3000/api/cron/generate-classes', {
        method: 'POST',
        headers: { Authorization: `Bearer ${cronSecret()}` },
      });

    const first = await fire();
    expect(first.status).toBe(200);

    const instances = await prisma.class.findMany({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: templateId } } } } }, orderBy: { calendarEntry: { date: 'asc' } }, include: { calendarEntry: true } });
    expect(instances.length).toBe(4);
    for (const instance of instances) {
      expect(instance.status).toBe('open');
      expect(timeToHHmm(instance.calendarEntry.startTime)).toBe('08:15');
      expect(instance.calendarEntry.date.getUTCDay()).toBe(templateJsDay);
      expect(instance.calendarEntry.date.getTime()).toBeGreaterThan(Date.now() - 24 * 3600 * 1000);
    }

    // Re-firing must not duplicate — unique (scheduleRuleId, date) on the entry.
    const second = await fire();
    expect(second.status).toBe(200);
    expect(await prisma.class.count({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: templateId } } } } } })).toBe(4);
  });

  test('the first instance appears on the schedule as a bookable class', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Recurring Flow').first()).toBeVisible();

    const first = await prisma.class.findFirstOrThrow({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: templateId } } } } }, orderBy: { calendarEntry: { date: 'asc' } }, include: { calendarEntry: true } });
    await page.goto(`/class/${first.id}`);
    await expect(page.getByRole('heading', { name: 'Recurring Flow' })).toBeVisible();
    await expect(page.getByText('Open for registration')).toBeVisible();
  });

  // Rule 1 of #194 at the only level a teacher actually experiences it: they
  // change the start time in the form, press Save, and their four already-
  // scheduled classes do not move. This is the inverse of the test it
  // replaces, which drove the same form and asserted the opposite — that all
  // four had been rewritten to 10:00 and that the form said "Applied to 4
  // upcoming classes."
  //
  // Worth more than the test it replaces: `npm run verify` is
  // `typecheck && lint && vitest` (`package.json`), so Playwright runs only
  // under `test:e2e`. Nothing else in the toolchain proves that the form, the
  // route and the service agree about what an edit does — the vitest suites
  // each prove one layer.
  //
  // The confirmation is now the real sentence rather than `Saved.`, which
  // makes this the one place where the SERVICE's prediction and the DATABASE's
  // contents are checked against each other through a browser: the week named
  // in the paragraph is derived below from the four rows the assertions on
  // either side of it read.
  test('editing the template leaves the already-scheduled instances where they are', async ({
    page,
  }) => {
    const before = await prisma.class.findMany({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: templateId } } } } }, orderBy: { calendarEntry: { date: 'asc' } }, include: { calendarEntry: true } });
    expect(before.length).toBe(4);
    expect(before.every((c) => timeToHHmm(c.calendarEntry.startTime) === '08:15')).toBe(true);

    await page.goto(`/settings/recurring/${templateId}`);
    await page.getByLabel('Start time').fill('10:00');
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    // The whole sentence, with the week computed from the rows above rather
    // than hard-coded: those four classes hold weeks 1–4, so the earliest week
    // the new schedule can reach is the fifth — one week past the last of them
    // — and the service's probe has to say so. `templateDate` moves with the
    // run day, so a fixed date here would pass on one day of the week.
    const weekFive = new Date(before[3]!.calendarEntry.date);
    weekFive.setUTCDate(weekFive.getUTCDate() + 7);
    // Back to that week's Monday, the same conversion `mondayOf` makes: the
    // copy speaks about weeks, not about the class's own weekday.
    weekFive.setUTCDate(weekFive.getUTCDate() - ((weekFive.getUTCDay() + 6) % 7));
    expect(weekFive.getUTCDay()).toBe(1);
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const expected =
      'Template updated. It takes effect for newly generated classes — your first class on the new schedule is the week starting ' +
      `Monday, ${weekFive.getUTCDate()} ${MONTHS[weekFive.getUTCMonth()]!}. ` +
      'Change existing classes individually if needed.';
    await expect(page.getByText(expected)).toBeVisible({ timeout: 10_000 });

    // The template moved.
    const template = await prisma.classTemplate.findUniqueOrThrow({
      where: { id: templateId },
      include: { scheduleRule: true },
    });
    expect(timeToHHmm(template.scheduleRule.startTime)).toBe('10:00');

    // The classes did not — same rows, same ids, same time. Asserted on ids
    // as well as times: "still four rows at 08:15" would also be satisfied by
    // a delete-and-refill that happened to land on the old time.
    const after = await prisma.class.findMany({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: templateId } } } } }, orderBy: { calendarEntry: { date: 'asc' } }, include: { calendarEntry: true } });
    expect(after.map((c) => c.id)).toEqual(before.map((c) => c.id));
    expect(after.every((c) => timeToHHmm(c.calendarEntry.startTime) === '08:15')).toBe(true);
  });
});
