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

const page = (id: string) =>
  fetch(`${BASE_URL}/studio-class/${id}`, { headers: cookie(token) }).then((r) => r.text());

const makeClass = (data: {
  templateId?: string | null;
  date: Date;
  startTime: string;
  cancelledAt?: Date | null;
  hourlyRate?: number;
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
        location: 'Community Studio',
        hourlyRate: 45,
      },
    });
    const sc = await makeClass({
      templateId: tpl.id,
      date: new Date('2099-08-05T00:00:00.000Z'),
      startTime: '07:00',
    });
    expect(await page(sc.id)).not.toContain('Remove this class');
  });

  it('offers removal on a cancelled past class, where the page used to dead-end', async () => {
    const sc = await makeClass({
      date: new Date('2020-08-05T00:00:00.000Z'),
      startTime: '07:15',
      cancelledAt: new Date('2020-08-01T10:00:00.000Z'),
    });
    const html = await page(sc.id);
    expect(html).toContain('This class was cancelled.');
    expect(html).toContain('Remove this class');
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
    expect(html).not.toContain('\\"earningsAtRisk\\":45');
  });

  /**
   * DATED TODAY, STARTING AT LOCAL MIDNIGHT — not at a convenient hour.
   * `classStartInstant(today, '00:00', TZ)` is local midnight of today, which
   * is in the past at every wall-clock moment of the day. A fixture at, say,
   * '09:00' would be removable only after 09:00 Amsterdam and would fail every
   * morning, which reads as a bug rather than as a fixture choice.
   */
  it('claims the earnings for a class dated today whose start has passed', async () => {
    const today = startOfLocalDay(new Date(), TZ);
    const sc = await makeClass({
      templateId: null,
      date: today,
      startTime: '00:00',
      hourlyRate: 45,
    });
    const html = await page(sc.id);
    expect(html).toContain('Remove this class');
    // 45.00 x 60 / 60 — threaded as the prop, rendered after the click.
    expect(html).toContain('\\"earningsAtRisk\\":45');
  });
});

/**
 * The end-to-end proof of the spec's §1.5 — the claim issue 279 inherited from
 * `prisma/schema.prisma:488` and built half its dilemma on. A studio class's
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
