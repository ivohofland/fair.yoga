/**
 * `/(teacher)/studio-class/[id]` — the page half of issue 279, and the first
 * integration coverage this page has had (issue 143 lists it as one of three
 * uncovered teacher detail pages).
 *
 * What is worth pinning here is the pair of predicates the page computes, which
 * are close enough to be conflated and are not the same: REMOVABILITY decides
 * whether the button is drawn, REPORTING'S WINDOW decides whether the confirm
 * claims a cost. A single shared predicate passes the first two cases below and
 * fails the last two.
 *
 * Since issue 304 it also pins how the page TITLES itself — the h1 leads with
 * the class type, and a Location row carries the venue in both the live and
 * the cancelled branch.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { startOfLocalDay } from '@/lib/timezone';
import { BASE_URL, cookie, uniqueSuffix, seedSession } from '../helpers';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

/** The `Teacher.defaultTimezone` default, and what every fixture here assumes. */
const TZ = 'Europe/Amsterdam';

let teacherId: string;
let token: string;

/**
 * Asserts 200 before returning the body. Without it every `not.toContain` in
 * this file passes against a page that did not render at all — a 500, or the
 * `redirect('/')` a non-owner gets, contains none of the strings either.
 */
const page = async (id: string) => {
  const res = await fetch(`${BASE_URL}/studio-class/${id}`, { headers: cookie(token) });
  expect(res.status).toBe(200);
  return res.text();
};

const makeClass = (data: {
  templateId?: string | null;
  classType?: string;
  date: Date;
  startTime: string;
  cancelledAt?: Date | null;
  hourlyRate?: number;
  durationMinutes?: number;
}) =>
  prisma.studioClass.create({
    data: {
      teacherId,
      classType: 'Page Case',
      durationMinutes: 60,
      location: 'Community Studio',
      hourlyRate: 45,
      ...data,
    },
  });

beforeAll(async () => {
  await prisma.$connect();
  const email = `studiopage-${suffix}@test.local`;
  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'Studio',
      lastName: 'Page',
      email,
      account: { create: { email } },
      bio: 'Studio class page tests',
      pageSlug: `studiopage-${suffix}`,
    },
  });
  teacherId = teacher.id;
  token = await seedSession(prisma, teacher.accountId);
});

afterAll(async () => {
  await prisma.studioClass.deleteMany({ where: { teacherId } });
  await prisma.studioClassTemplate.deleteMany({ where: { teacherId } });
  await prisma.$disconnect();
});

describe('the studio class page: which classes offer removal', () => {
  it('offers no removal on a future generated class', async () => {
    const tpl = await prisma.studioClassTemplate.create({
      data: {
        teacherId,
        classType: 'Page Template',
        dayOfWeek: 3,
        startTime: '07:00',
        durationMinutes: 60,
        location: 'Template Venue',
        hourlyRate: 45,
      },
    });
    const sc = await makeClass({
      templateId: tpl.id,
      date: new Date('2099-08-05T00:00:00.000Z'),
      startTime: '07:00',
    });
    const html = await page(sc.id);
    // Anchored: without a string only this page can render, the negative
    // assertion below would pass against a page that rendered nothing useful.
    expect(html).toContain('Community Studio');
    expect(html).toContain('>Location</span>');
    expect(html).toMatch(/<h1[^>]*>Page Case<\/h1>/);
    expect(html).not.toContain('Remove this class');
  });

  /**
   * THE PAGE HALF OF THE REGRESSION PR #295's REVIEW FOUND. A generated class
   * dated TODAY offers no removal, however long ago it started — the class's
   * `startTime` is a stamp and the generator filters on the template's current
   * one, so "it has started" does not mean "the sweep cannot rebuild it".
   *
   * The template is deliberately created at a LATER hour than the class, which
   * is the divergence itself rather than merely a same-day class.
   */
  it('offers no removal on a generated class dated today, however long ago it started', async () => {
    const tpl = await prisma.studioClassTemplate.create({
      data: {
        teacherId,
        classType: 'Page Template Today',
        dayOfWeek: 4,
        startTime: '23:30',
        durationMinutes: 60,
        location: 'Template Venue',
        hourlyRate: 45,
      },
    });
    const sc = await makeClass({
      templateId: tpl.id,
      date: startOfLocalDay(new Date(), TZ),
      startTime: '00:01',
    });
    const html = await page(sc.id);
    expect(html).toContain('Community Studio');
    expect(html).toContain('>Location</span>');
    expect(html).not.toContain('Remove this class');
  });

  it('offers removal on a cancelled past class, where the page used to dead-end', async () => {
    const sc = await makeClass({
      date: new Date('2020-08-05T00:00:00.000Z'),
      startTime: '07:15',
      cancelledAt: new Date('2020-08-01T10:00:00.000Z'),
    });
    const html = await page(sc.id);
    expect(html).toContain('This class was cancelled.');
    // The only case reaching the cancelled branch. Without these, a change
    // gating the details block on the live branch passes every other
    // assertion in this file.
    expect(html).toMatch(/<h1[^>]*>Page Case<\/h1>/);
    expect(html).toMatch(/>Location<\/span>\s*<p[^>]*>Community Studio<\/p>/);
    expect(html).toContain('Remove this class');
  });
});

describe('the studio class page: how it titles itself', () => {
  /**
   * The `|| location` half of the header, which nothing else reaches. Every
   * studio write schema validates `.min(1)`, so only a row written straight to
   * the database — as this file does — can carry an empty class type. The
   * column permits it (`String @default("")`), which is why the fallback is
   * there at all.
   */
  it('falls back to the location when the class type is empty', async () => {
    const sc = await makeClass({
      classType: '',
      date: new Date('2099-09-09T00:00:00.000Z'),
      startTime: '19:45',
    });
    const html = await page(sc.id);
    expect(html).toMatch(/<h1[^>]*>Community Studio<\/h1>/);
  });
});

describe('the studio class page: what the removal claims it costs', () => {
  /**
   * THE FIGURE TRAVELS AS A PROP, AND THE PROP IS WHAT A FETCH CAN SEE. The
   * confirm sentence renders only after the teacher clicks — the component's
   * initial state hides it, so no server render contains it (the plan's
   * predicted assertion on the sentence itself is unpassable by its own
   * component design, which keeps the two-step confirm). What the served
   * document does carry is the serialized props handed to the client
   * component, so these cases read that handoff: `earningsAtRisk` null in one
   * document and 45 in the other pins REPORTING'S WINDOW — not removability —
   * deciding the figure. A page that derived the claim from `deletable`
   * threads a number into both documents; case 1's null assertion forbids
   * exactly that.
   */

  it('claims nothing for a future-dated manual class, which reporting does not count', async () => {
    const sc = await makeClass({
      templateId: null,
      date: new Date('2099-08-06T00:00:00.000Z'),
      startTime: '07:30',
    });
    const html = await page(sc.id);
    expect(html).toContain('Remove this class');
    // Nothing renders before the click…
    expect(html).not.toContain('will come off your reported earnings');
    // …and the prop the page hands the button carries no figure.
    expect(html).toContain('\\"earningsAtRisk\\":null');
  });

  /**
   * DATED TODAY AND MANUAL. Manual is what keeps it removable: a GENERATED
   * class dated today is refused outright (see the page case above), so only a
   * manual one can be both inside reporting's window and removable — which is
   * precisely the overlap this case exists to separate.
   *
   * NINETY MINUTES, NOT SIXTY, and that is the whole point. At 60 the formula
   * `hourlyRate x durationMinutes / 60` returns the hourly rate unchanged, so
   * input and output are the same number and a page that dropped the duration
   * term entirely passed. 45.00 x 90 / 60 = 67.50 can only come from the real
   * formula.
   */
  it('claims the earnings for a manual class dated today, at its real duration', async () => {
    const sc = await makeClass({
      templateId: null,
      date: startOfLocalDay(new Date(), TZ),
      startTime: '00:00',
      hourlyRate: 45,
      durationMinutes: 90,
    });
    const html = await page(sc.id);
    expect(html).toContain('Remove this class');
    // Delimited with the closing brace — `earningsAtRisk` is the last prop the
    // page passes, so it is what follows. An unanchored `":67.5` would also
    // match 67.55 or 675.
    expect(html).toContain('\\"earningsAtRisk\\":67.5}');
  });
});

/**
 * The end-to-end proof of the spec's §1.5 — the claim issue 279 inherited from
 * the `withdrawnCount` docblock on `StudioClassTemplate`, which read "an
 * already-cancelled one is an income record and survives" until this branch
 * corrected it, and on which the issue built half its dilemma. A studio class's
 * earnings are `hourlyRate x durationMinutes / 60` and nothing else;
 * `studentCount` never touches money; and removing the class takes the figure
 * with it.
 *
 * ITS OWN TEACHER, because the assertion is on an absolute total and every
 * other fixture in this file would otherwise be inside it.
 */
describe('the reporting page, which is where the income claim is settled', () => {
  let soloId: string;
  let soloToken: string;

  beforeAll(async () => {
    const email = `studiopage-solo-${suffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Studio',
        lastName: 'Solo',
        email,
        account: { create: { email } },
        bio: 'Studio reporting removal',
        pageSlug: `studiopage-solo-${suffix}`,
      },
    });
    soloId = teacher.id;
    soloToken = await seedSession(prisma, teacher.accountId);
  });

  afterAll(async () => {
    await prisma.studioClass.deleteMany({ where: { teacherId: soloId } });
  });

  it('loses the removed class earnings, which a cancelled class never had', async () => {
    const reporting = () =>
      fetch(`${BASE_URL}/settings/reporting`, { headers: cookie(soloToken) }).then((r) => r.text());

    // 60.00/hr x 90 min = 90.00, and studentCount is deliberately left null to
    // show it plays no part in the figure.
    const sc = await prisma.studioClass.create({
      data: {
        teacherId: soloId,
        classType: 'Solo Case',
        templateId: null,
        date: new Date('2020-08-07T00:00:00.000Z'),
        startTime: '08:00',
        durationMinutes: 90,
        location: 'Community Studio',
        hourlyRate: 60,
        studentCount: null,
      },
    });

    expect(await reporting()).toContain('90.00');

    const res = await fetch(`${BASE_URL}/api/studio-classes/${sc.id}`, {
      method: 'DELETE',
      headers: cookie(soloToken),
    });
    expect(res.status).toBe(200);

    expect(await reporting()).not.toContain('90.00');
  });
});
