import { PrismaClient, Prisma } from '@prisma/client';
import { hhmmToTime } from '@/lib/time-of-day';

const prisma = new PrismaClient();

// ---------------------------------------------------------------------------
// Helper: relative dates
// ---------------------------------------------------------------------------
/**
 * A calendar date `days` from today, as midnight UTC.
 *
 * UTC accessors, not local ones. These values go into `@db.Date` columns
 * (`Class.date`, `StudioClass.date`, `Student.birthday`), which store a
 * calendar date and take it from the *UTC* portion of the timestamp — so
 * building local midnight lands a day early for anyone east of UTC. On
 * `Europe/Amsterdam` this returned `2026-07-30T22:00:00Z` for "today",
 * which Postgres stored as the 30th while the calendar said the 31st, and
 * every relative date in this file inherited the error.
 *
 * That is the same rule `src/lib/timezone.ts` states, tripped from the other
 * side: #101 and #115 broke west of UTC by reading a calendar date locally,
 * and this broke east of UTC by writing one locally.
 */
function daysFromNow(days: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function daysAgo(days: number): Date {
  return daysFromNow(-days);
}

const today = daysFromNow(0);
const lastWeek = daysAgo(7);
const lastWeek2 = daysAgo(5);
const thisWeekThursday = daysFromNow(1);
const thisWeekSaturday = daysFromNow(3);
const nextWeek = daysFromNow(7);

// ---------------------------------------------------------------------------
// Main seed function
// ---------------------------------------------------------------------------
async function main() {
  // Clear all data in reverse dependency order
  await prisma.session.deleteMany();
  await prisma.passkeyCredential.deleteMany();
  await prisma.magicLinkToken.deleteMany();
  await prisma.announcement.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.waitlistEntry.deleteMany();
  await prisma.registration.deleteMany();
  await prisma.class.deleteMany();
  await prisma.classTemplate.deleteMany();
  await prisma.studioClass.deleteMany();
  await prisma.studioClassTemplate.deleteMany();
  await prisma.teacherRoom.deleteMany();
  await prisma.room.deleteMany();
  await prisma.studentPrivacy.deleteMany();
  await prisma.teacherStudent.deleteMany();
  await prisma.student.deleteMany();
  await prisma.invitation.deleteMany();
  await prisma.teacherBlock.deleteMany();
  await prisma.teacher.deleteMany();
  // Accounts last: Teacher.accountId RESTRICTs while a profile still points at one.
  await prisma.account.deleteMany();

  // ==========================================================================
  // TEACHERS
  // ==========================================================================
  const ivo = await prisma.teacher.create({
    data: {
      firstName: 'Ivo',
      lastName: 'Hofland',
      email: 'ivo@fairyoga.dev',
      account: { create: { email: 'ivo@fairyoga.dev' } },
      bio: 'Vinyasa and Hatha teacher based in Amsterdam. Focused on accessible, ethical yoga for everyone.',
      pageSlug: 'ivo',
      defaultCurrency: 'EUR',
      defaultTimezone: 'Europe/Amsterdam',
      defaultReminder: 'morning_of',
      paymentLevel: 'LEVEL_1',
      bankIban: 'NL91ABNA0417164300',
      bankAccountName: 'I. Hofland',
    },
  });

  const sarah = await prisma.teacher.create({
    data: {
      firstName: 'Sarah',
      lastName: 'Mitchell',
      email: 'sarah@fairyoga.dev',
      account: { create: { email: 'sarah@fairyoga.dev' } },
      bio: 'Yin and restorative yoga in London. Creating calm spaces for healing.',
      pageSlug: 'sarah',
      defaultCurrency: 'GBP',
      defaultTimezone: 'Europe/London',
      defaultReminder: 'evening_before',
      paymentLevel: 'LEVEL_1',
      bankIban: 'GB29NWBK60161331926819',
      bankAccountName: 'S. Mitchell',
    },
  });

  // A teacher **west of UTC**, which the other two are not (Amsterdam +2,
  // London +1). Every date bug this app has had is invisible east of UTC: a
  // calendar date read in local time moves back exactly one day west of the
  // meridian and moves nothing at or east of it. Without a teacher here, the
  // whole family — #101's boundaries, #115's renderings, and whatever #96
  // decides about formats — can only be exercised in tests, never by opening
  // the app. Maya exists so a developer can log in and look.
  //
  // `America/Los_Angeles` specifically: a large offset (UTC-7/-8) so the
  // divergence is obvious rather than an edge case, and a DST-observing zone
  // so the offset is not a constant anyone can hard-code by accident.
  const maya = await prisma.teacher.create({
    data: {
      firstName: 'Maya',
      lastName: 'Chen',
      email: 'maya@fairyoga.dev',
      account: { create: { email: 'maya@fairyoga.dev' } },
      bio: 'Slow flow and breathwork in Portland. Small classes, sliding scale, no rush.',
      pageSlug: 'maya',
      defaultCurrency: 'USD',
      defaultTimezone: 'America/Los_Angeles',
      defaultReminder: 'evening_before',
      paymentLevel: 'LEVEL_1',
      // Null rather than a fabricated IBAN: she is in the US, and `bankIban`
      // is nullable precisely because not every teacher has one.
      bankIban: null,
      bankAccountName: 'M. Chen',
    },
  });

  // ==========================================================================
  // STUDENTS (10 students, 2 per income tier)
  // ==========================================================================
  const studentData: Prisma.StudentCreateInput[] = [
    // Tier 1
    {
      firstName: 'Anna',
      lastName: 'de Vries',
      email: 'anna@example.com',
      incomeTier: 1,
      phone: '+31612345001',
      reminderPref: 'morning',
    },
    {
      firstName: 'Ben',
      lastName: 'Bakker',
      email: 'ben@example.com',
      incomeTier: 1,
      reminderPref: 'eve',
    },
    // Tier 2
    {
      firstName: 'Clara',
      lastName: 'Jansen',
      email: 'clara@example.com',
      incomeTier: 2,
      phone: '+31612345003',
      birthday: new Date('1990-06-15'),
      reminderPref: 'morning',
    },
    {
      firstName: 'David',
      lastName: 'Smit',
      email: 'david@example.com',
      incomeTier: 2,
      reminderPref: 'one_hour',
    },
    // Tier 3
    {
      firstName: 'Eva',
      lastName: 'Mulder',
      email: 'eva@example.com',
      incomeTier: 3,
      phone: '+31612345005',
      address: 'Prinsengracht 100, 1015 DV Amsterdam',
      reminderPref: 'morning',
    },
    {
      firstName: 'Finn',
      lastName: 'de Boer',
      email: 'finn@example.com',
      incomeTier: 3,
      birthday: new Date('1985-11-22'),
      reminderPref: 'off',
    },
    // Tier 4
    {
      firstName: 'Greta',
      lastName: 'van Dijk',
      email: 'greta@example.com',
      incomeTier: 4,
      phone: '+31612345007',
      address: 'Keizersgracht 200, 1016 DZ Amsterdam',
      birthday: new Date('1988-03-10'),
      reminderPref: 'morning',
    },
    {
      firstName: 'Hugo',
      lastName: 'Visser',
      email: 'hugo@example.com',
      incomeTier: 4,
      reminderPref: 'eve',
    },
    // Tier 5
    {
      firstName: 'Iris',
      lastName: 'Meijer',
      email: 'iris@example.com',
      incomeTier: 5,
      phone: '+31612345009',
      address: 'Herengracht 300, 1016 CG Amsterdam',
      birthday: new Date('1992-08-05'),
      reminderPref: 'morning',
    },
    {
      firstName: 'Jan',
      lastName: 'de Groot',
      email: 'jan@example.com',
      incomeTier: 5,
      reminderPref: 'morning',
    },
  ];

  const students = await Promise.all(
    studentData.map((data) =>
      prisma.student.create({
        data: {
          ...data,
          claimedAt: daysAgo(30),
          // Claimed students are assumed to have chosen at claim time
          // (mirrors the migration backfill's one-time heuristic).
          tierSelectedAt: daysAgo(30),
          account: { create: { email: data.email } },
        },
      }),
    ),
  );

  // ==========================================================================
  // STUDENT PRIVACY (per-teacher, for Ivo)
  // ==========================================================================
  // Varied sharing levels
  const privacySettings = [
    { shareFullName: true, shareEmail: true, sharePhone: true, shareBirthday: false, shareAddress: false }, // Anna — full name visible
    { shareFullName: false, shareEmail: false, sharePhone: false, shareBirthday: false, shareAddress: false }, // Ben (max privacy)
    { shareFullName: true, shareEmail: true, sharePhone: true, shareBirthday: true, shareAddress: false }, // Clara — full name visible
    { shareFullName: false, shareEmail: true, sharePhone: false, shareBirthday: false, shareAddress: false }, // David — initial only
    { shareFullName: true, shareEmail: true, sharePhone: true, shareBirthday: false, shareAddress: true }, // Eva — full name visible
    { shareFullName: false, shareEmail: false, sharePhone: false, shareBirthday: true, shareAddress: false }, // Finn — initial only
    { shareFullName: true, shareEmail: true, sharePhone: true, shareBirthday: true, shareAddress: true }, // Greta (shares all)
    { shareFullName: false, shareEmail: true, sharePhone: false, shareBirthday: false, shareAddress: false }, // Hugo — initial only
    { shareFullName: true, shareEmail: true, sharePhone: true, shareBirthday: true, shareAddress: true }, // Iris (shares all)
    { shareFullName: false, shareEmail: true, sharePhone: false, shareBirthday: false, shareAddress: false }, // Jan — initial only
  ];

  await Promise.all(
    students.map((student, i) =>
      prisma.studentPrivacy.create({
        data: {
          studentId: student.id,
          teacherId: ivo.id,
          ...privacySettings[i],
        },
      }),
    ),
  );

  // ==========================================================================
  // TEACHER-STUDENT LINKS (CRM contacts)
  // ==========================================================================
  // All claimed students are in Ivo's contacts. Nothing creates an unclaimed
  // Student any more (#166) — the CRM-only fixtures below are Invitation rows
  // instead, not Student + TeacherStudent pairs.
  await Promise.all(
    students.map((student) =>
      prisma.teacherStudent.create({
        data: {
          teacherId: ivo.id,
          studentId: student.id,
        },
      }),
    ),
  );

  // Sarah has 3 students in her contacts (Anna, Clara, Eva)
  for (const idx of [0, 2, 4]) {
    await prisma.teacherStudent.create({
      data: {
        teacherId: sarah.id,
        studentId: students[idx]!.id,
      },
    });
  }

  // ==========================================================================
  // INVITATIONS (CRM pending contacts, #166)
  // ==========================================================================
  // Two pending (Lena, Max) and one declined (Nadia). `accepted` needs no
  // fixture of its own here: an accepted invitation is exactly a claimed
  // Student with a TeacherStudent link, and the seed already has ten.
  await prisma.invitation.createMany({
    data: [
      { teacherId: ivo.id, email: 'lena@example.com', firstName: 'Lena', lastName: 'Visser' },
      { teacherId: ivo.id, email: 'max@example.com', firstName: 'Max', lastName: 'Dekker' },
      {
        teacherId: ivo.id, email: 'declined@example.com',
        firstName: 'Nadia', lastName: 'Bakker',
        status: 'declined', respondedAt: daysAgo(3),
      },
    ],
  });

  // ==========================================================================
  // ROOMS
  // ==========================================================================
  const yogaschool = await prisma.room.create({
    data: {
      venueName: 'De Yogaschool',
      address: 'Nieuwe Keizersgracht 58',
      city: 'Amsterdam',
      postcode: '1018DT',
      floor: '1st',
      roomName: 'Main Studio',
      maxCapacity: 20,
      equipment: JSON.parse('["mats", "blocks", "straps", "bolsters", "blankets", "cushions"]'),
      isPublic: true,
      createdById: ivo.id,
    },
  });

  const communityCenter = await prisma.room.create({
    data: {
      venueName: 'Community Center West',
      address: 'Fannius Scholtenstraat 10',
      city: 'Amsterdam',
      postcode: '1051EX',
      floor: 'Ground',
      roomName: 'Activity Room',
      maxCapacity: 15,
      equipment: JSON.parse('["mats"]'),
      isPublic: true,
      createdById: ivo.id,
    },
  });

  const homeStudio = await prisma.room.create({
    data: {
      venueName: 'Thuis',
      address: 'Hansenstraat 12A',
      city: 'Leiden',
      postcode: '2316BJ',
      floor: '',
      roomName: '',
      maxCapacity: 1,
      equipment: JSON.parse('["mats", "blocks", "straps"]'),
      isPublic: false,
      createdById: ivo.id,
    },
  });

  // ==========================================================================
  // TEACHER ROOMS
  // ==========================================================================
  const ivoYogaschool = await prisma.teacherRoom.create({
    data: {
      teacherId: ivo.id,
      roomId: yogaschool.id,
      capacityOverride: 12,
      rentalRate: new Prisma.Decimal('35.00'),
    },
  });

  const ivoCommunity = await prisma.teacherRoom.create({
    data: {
      teacherId: ivo.id,
      roomId: communityCenter.id,
      capacityOverride: 10,
      rentalRate: new Prisma.Decimal('25.00'),
    },
  });

  await prisma.teacherRoom.create({
    data: {
      teacherId: ivo.id,
      roomId: homeStudio.id,
      capacityOverride: 1,
      rentalRate: new Prisma.Decimal('0.00'),
    },
  });

  await prisma.teacherRoom.create({
    data: {
      teacherId: sarah.id,
      roomId: yogaschool.id,
      capacityOverride: 15,
      rentalRate: new Prisma.Decimal('40.00'),
    },
  });

  const portlandStudio = await prisma.room.create({
    data: {
      venueName: 'Rose City Yoga',
      address: '1420 SE Division St',
      city: 'Portland',
      postcode: '97202',
      roomName: 'Back Room',
      maxCapacity: 12,
      equipment: JSON.parse('["mats", "blocks", "bolsters", "blankets"]'),
      isPublic: false,
      createdById: maya.id,
    },
  });

  const mayaPortland = await prisma.teacherRoom.create({
    data: {
      teacherId: maya.id,
      roomId: portlandStudio.id,
      capacityOverride: 10,
      rentalRate: new Prisma.Decimal('30.00'),
    },
  });

  // ==========================================================================
  // CLASS TEMPLATE
  // ==========================================================================
  const vinyasaTemplate = await prisma.classTemplate.create({
    data: {
      scheduleRule: {
        create: {
          teacherId: ivo.id,
          kind: 'regular',
          classType: 'Vinyasa',
          dayOfWeek: 1, // Tuesday
          startTime: hhmmToTime('09:00'),
          durationMinutes: 75,
          isActive: true,
        },
      },
      teacherRoom: { connect: { id: ivoYogaschool.id } },
      description: 'Dynamic flow class suitable for all levels.',
      roomCost: new Prisma.Decimal('35.00'),
      minRate: new Prisma.Decimal('15.00'),
      targetRate: new Prisma.Decimal('25.00'),
      minStudents: 4,
      maxStudents: 12,
      cancelDeadline: 'HOURS_24',
      autoCancelCheck: 'HOURS_2',
    },
  });

  // ==========================================================================
  // CLASSES (one per lifecycle state)
  // ==========================================================================

  // 1. DRAFT — next week, Hatha, not published
  await prisma.class.create({
    data: {
      teacherId: ivo.id,
      teacherRoomId: ivoCommunity.id,
      classType: 'Hatha',
      description: 'Gentle Hatha class for beginners.',
      date: nextWeek,
      startTime: '18:00',
      durationMinutes: 60,
      roomCost: new Prisma.Decimal('25.00'),
      minRate: new Prisma.Decimal('12.00'),
      targetRate: new Prisma.Decimal('20.00'),
      minStudents: 3,
      maxStudents: 10,
      cancelDeadline: 'HOURS_24',
      autoCancelCheck: 'HOURS_2',
      status: 'draft',
    },
  });

  // 2. OPEN — this week, 3 registrations
  const openClass = await prisma.class.create({
    data: {
      teacherId: ivo.id,
      teacherRoomId: ivoYogaschool.id,
      templateId: vinyasaTemplate.id,
      classType: 'Vinyasa',
      description: 'Dynamic flow class suitable for all levels.',
      date: thisWeekThursday,
      startTime: '09:00',
      durationMinutes: 75,
      roomCost: new Prisma.Decimal('35.00'),
      minRate: new Prisma.Decimal('15.00'),
      targetRate: new Prisma.Decimal('25.00'),
      minStudents: 4,
      maxStudents: 12,
      cancelDeadline: 'HOURS_24',
      autoCancelCheck: 'HOURS_2',
      status: 'open',
      settingsLocked: true,
    },
  });

  // 3. OPEN (full) — this week, 12 registrations (all spots filled, status stays open)
  const fullClass = await prisma.class.create({
    data: {
      teacherId: ivo.id,
      teacherRoomId: ivoYogaschool.id,
      templateId: vinyasaTemplate.id,
      classType: 'Vinyasa',
      description: 'Dynamic flow class suitable for all levels.',
      date: thisWeekSaturday,
      startTime: '09:00',
      durationMinutes: 75,
      roomCost: new Prisma.Decimal('35.00'),
      minRate: new Prisma.Decimal('15.00'),
      targetRate: new Prisma.Decimal('25.00'),
      minStudents: 4,
      maxStudents: 12,
      cancelDeadline: 'HOURS_24',
      autoCancelCheck: 'HOURS_2',
      status: 'open',
      settingsLocked: true,
    },
  });

  // 4. IN_PROGRESS — today, 8 registrations
  const inProgressClass = await prisma.class.create({
    data: {
      teacherId: ivo.id,
      teacherRoomId: ivoYogaschool.id,
      templateId: vinyasaTemplate.id,
      classType: 'Vinyasa',
      description: 'Dynamic flow class suitable for all levels.',
      date: today,
      startTime: '09:00',
      durationMinutes: 75,
      roomCost: new Prisma.Decimal('35.00'),
      minRate: new Prisma.Decimal('15.00'),
      targetRate: new Prisma.Decimal('25.00'),
      minStudents: 4,
      maxStudents: 12,
      cancelDeadline: 'HOURS_24',
      autoCancelCheck: 'HOURS_2',
      status: 'in_progress',
      settingsLocked: true,
    },
  });

  // 5. COMPLETED — last week, 10 registrations, pricing calculated
  //
  // Pricing calculation for 9 charged students (7 attended + 1 no_show + 1 late_cancel):
  //   effective_teacher_rate = 15 + (25 - 15) * (9 - 4) / (12 - 4) = 21.25 (per-class total)
  //   total = 35 + 21.25 = 56.25
  //   tier distribution: tiers [1,1,2,3,3,4,4,5,5] → ratios [0.65,0.65,0.80,1.00,1.00,1.20,1.20,1.35,1.35]
  //   sum of ratios = 9.20
  //   base price = 56.25 / 9.20 = 6.114...
  //   tier 1: 6.11 * 0.65 = 3.97, tier 2: 6.11 * 0.80 = 4.89
  //   tier 3: 6.11 * 1.00 = 6.11, tier 4: 6.11 * 1.20 = 7.34
  //   tier 5: 6.11 * 1.35 = 8.25
  const completedClass = await prisma.class.create({
    data: {
      teacherId: ivo.id,
      teacherRoomId: ivoYogaschool.id,
      templateId: vinyasaTemplate.id,
      classType: 'Vinyasa',
      description: 'Dynamic flow class suitable for all levels.',
      date: lastWeek,
      startTime: '09:00',
      durationMinutes: 75,
      roomCost: new Prisma.Decimal('35.00'),
      minRate: new Prisma.Decimal('15.00'),
      targetRate: new Prisma.Decimal('25.00'),
      minStudents: 4,
      maxStudents: 12,
      cancelDeadline: 'HOURS_24',
      autoCancelCheck: 'HOURS_2',
      status: 'completed',
      settingsLocked: true,
      effectiveTeacherRate: new Prisma.Decimal('21.25'),
      totalStudents: 9,
      totalRevenue: new Prisma.Decimal('56.25'),
    },
  });

  // 6. CANCELLED — last week, 2 registrations (below min_students of 4)
  const cancelledClass = await prisma.class.create({
    data: {
      teacherId: ivo.id,
      teacherRoomId: ivoYogaschool.id,
      templateId: vinyasaTemplate.id,
      classType: 'Vinyasa',
      description: 'Dynamic flow class suitable for all levels.',
      date: lastWeek2,
      startTime: '09:00',
      durationMinutes: 75,
      roomCost: new Prisma.Decimal('35.00'),
      minRate: new Prisma.Decimal('15.00'),
      targetRate: new Prisma.Decimal('25.00'),
      minStudents: 4,
      maxStudents: 12,
      cancelDeadline: 'HOURS_24',
      autoCancelCheck: 'HOURS_2',
      status: 'cancelled',
      settingsLocked: true,
    },
  });

  // --------------------------------------------------------------------------
  // Maya's classes — the ones that make the timezone boundary visible
  // --------------------------------------------------------------------------
  // The point of these three is what they look like *from Portland*, which is
  // only interesting because the server and the developer's laptop are almost
  // certainly not there.
  //
  // The 19:00 class dated today is the load-bearing one, and the hour you look
  // at it decides what it shows. Measured against the pre-#101 code:
  //
  //   12:00–19:00 Pacific  the card dimmed as already-taught, because the
  //                        start was read as 19:00 *UTC* rather than Pacific
  //   17:00–23:59 Pacific  it also appeared under Past classes, because UTC
  //                        had rolled past midnight and the boundary was
  //                        `setUTCHours(0,0,0,0)` on an instant
  //   17:00–19:00 Pacific  both at once — the clearest window
  //
  // After the fix it does neither until 19:00 Pacific, when it genuinely
  // starts, and it never reaches Past classes on its own day. Outside those
  // hours the row looks correct either way, so a developer checking at 10:00
  // Pacific — or from Europe, where these bugs do not manifest at all — will
  // see nothing wrong and should not conclude the seed is pointless.
  await prisma.class.create({
    data: {
      teacherId: maya.id,
      teacherRoomId: mayaPortland.id,
      classType: 'Slow Flow',
      description: 'Evening slow flow. Bring a blanket.',
      date: today,
      startTime: '19:00',
      durationMinutes: 75,
      roomCost: new Prisma.Decimal('30.00'),
      minRate: new Prisma.Decimal('10.00'),
      targetRate: new Prisma.Decimal('18.00'),
      minStudents: 3,
      maxStudents: 10,
      cancelDeadline: 'HOURS_12',
      autoCancelCheck: 'HOURS_2',
      status: 'open',
    },
  });

  // Yesterday, completed: gives Past classes something that genuinely belongs
  // there, so the page is not empty and the boundary has two sides to get right.
  await prisma.class.create({
    data: {
      teacherId: maya.id,
      teacherRoomId: mayaPortland.id,
      classType: 'Breathwork',
      description: 'Pranayama and long holds.',
      date: daysAgo(1),
      startTime: '07:00',
      durationMinutes: 45,
      roomCost: new Prisma.Decimal('30.00'),
      minRate: new Prisma.Decimal('10.00'),
      targetRate: new Prisma.Decimal('18.00'),
      minStudents: 2,
      maxStudents: 8,
      cancelDeadline: 'HOURS_12',
      autoCancelCheck: 'HOURS_2',
      status: 'completed',
      effectiveTeacherRate: new Prisma.Decimal('14.00'),
      totalStudents: 4,
      totalRevenue: new Prisma.Decimal('44.00'),
    },
  });

  // Next week, so the Schedule tab has a "Next week" heading to render for her
  // and the week grouping is exercised, not just the day boundary.
  await prisma.class.create({
    data: {
      teacherId: maya.id,
      teacherRoomId: mayaPortland.id,
      classType: 'Slow Flow',
      description: 'Evening slow flow. Bring a blanket.',
      date: nextWeek,
      startTime: '19:00',
      durationMinutes: 75,
      roomCost: new Prisma.Decimal('30.00'),
      minRate: new Prisma.Decimal('10.00'),
      targetRate: new Prisma.Decimal('18.00'),
      minStudents: 3,
      maxStudents: 10,
      cancelDeadline: 'HOURS_12',
      autoCancelCheck: 'HOURS_2',
      status: 'open',
    },
  });

  // ==========================================================================
  // STUDIO CLASS TEMPLATE + INSTANCES
  // ==========================================================================
  const studioTemplate = await prisma.studioClassTemplate.create({
    data: {
      scheduleRule: {
        create: {
          teacherId: ivo.id,
          kind: 'studio',
          classType: 'Vinyasa',
          dayOfWeek: 3, // Thursday
          startTime: hhmmToTime('11:00'),
          durationMinutes: 60,
          isActive: true,
        },
      },
      location: 'Yoga Studio Centrum, Amsterdam',
      hourlyRate: new Prisma.Decimal('35.00'),
    },
  });

  // Past studio class (with student count)
  await prisma.studioClass.create({
    data: {
      teacherId: ivo.id,
      templateId: studioTemplate.id,
      date: lastWeek,
      startTime: '11:00',
      durationMinutes: 60,
      classType: 'Vinyasa',
      location: 'Yoga Studio Centrum, Amsterdam',
      studentCount: 18,
      hourlyRate: new Prisma.Decimal('35.00'),
    },
  });

  // Upcoming studio class (no student count yet)
  await prisma.studioClass.create({
    data: {
      teacherId: ivo.id,
      templateId: studioTemplate.id,
      date: thisWeekThursday,
      startTime: '11:00',
      durationMinutes: 60,
      classType: 'Vinyasa',
      location: 'Yoga Studio Centrum, Amsterdam',
      studentCount: null,
      hourlyRate: new Prisma.Decimal('35.00'),
    },
  });

  // One-off studio class at a different studio
  await prisma.studioClass.create({
    data: {
      teacherId: ivo.id,
      date: nextWeek,
      startTime: '14:00',
      durationMinutes: 90,
      classType: 'Bikram',
      location: 'Bikram Amsterdam, Keizersgracht',
      studentCount: null,
      hourlyRate: new Prisma.Decimal('45.00'),
    },
  });

  // ==========================================================================
  // REGISTRATIONS
  // ==========================================================================

  // -- OPEN class: 3 registrations (tiers 1, 3, 5)
  for (const [idx, tier] of [0, 4, 8].entries()) {
    await prisma.registration.create({
      data: {
        classId: openClass.id,
        studentId: students[tier]!.id,
        status: 'registered',
        tierAtBooking: students[tier]!.incomeTier,
        registeredAt: daysAgo(2 - idx),
      },
    });
  }

  // -- FULL class: all 10 students + 2 walk-ins (first 2 students as walk-ins)
  for (let i = 0; i < 10; i++) {
    await prisma.registration.create({
      data: {
        classId: fullClass.id,
        studentId: students[i]!.id,
        status: 'registered',
        tierAtBooking: students[i]!.incomeTier,
        registeredAt: daysAgo(5 - Math.floor(i / 2)),
      },
    });
  }

  // -- IN_PROGRESS class: 8 registrations (students 0-7)
  for (let i = 0; i < 8; i++) {
    await prisma.registration.create({
      data: {
        classId: inProgressClass.id,
        studentId: students[i]!.id,
        status: 'registered',
        tierAtBooking: students[i]!.incomeTier,
        registeredAt: daysAgo(3 - Math.floor(i / 3)),
      },
    });
  }

  // -- COMPLETED class: 10 registrations with varied statuses and calculated prices
  // Tier distribution for 9 charged: [1, 1, 2, 3, 3, 4, 4, 5, 5]
  // Sum of ratios: 0.65 + 0.65 + 0.80 + 1.00 + 1.00 + 1.20 + 1.20 + 1.35 + 1.35 = 9.20
  // Base price: 56.25 / 9.20 ≈ 6.1141
  const tierRatioMap: Record<number, string> = {
    1: '0.6500',
    2: '0.8000',
    3: '1.0000',
    4: '1.2000',
    5: '1.3500',
  };
  const tierPriceMap: Record<number, string> = {
    1: '3.97',
    2: '4.89',
    3: '6.11',
    4: '7.34',
    5: '8.25',
  };

  const completedStatuses: Array<{
    status: 'attended' | 'no_show' | 'late_cancel' | 'cancelled';
    charged: boolean;
  }> = [
    { status: 'attended', charged: true }, // Anna (tier 1)
    { status: 'attended', charged: true }, // Ben (tier 1)
    { status: 'attended', charged: true }, // Clara (tier 2)
    { status: 'attended', charged: true }, // David (tier 2)
    { status: 'attended', charged: true }, // Eva (tier 3)
    { status: 'attended', charged: true }, // Finn (tier 3)
    { status: 'no_show', charged: true }, // Greta (tier 4)
    { status: 'attended', charged: true }, // Hugo (tier 4)
    { status: 'late_cancel', charged: true }, // Iris (tier 5)
    { status: 'cancelled', charged: false }, // Jan (tier 5) — cancelled before deadline
  ];

  const completedRegistrations = [];
  for (let i = 0; i < 10; i++) {
    const student = students[i]!;
    const entry = completedStatuses[i]!;
    const tier = student.incomeTier;

    const reg = await prisma.registration.create({
      data: {
        classId: completedClass.id,
        studentId: student.id,
        status: entry.status,
        tierAtBooking: tier,
        price: entry.charged ? new Prisma.Decimal(tierPriceMap[tier]!) : null,
        tierRatio: entry.charged ? new Prisma.Decimal(tierRatioMap[tier]!) : null,
        registeredAt: daysAgo(10 - i),
        cancelledAt: entry.status === 'cancelled' ? daysAgo(8) : null,
      },
    });
    completedRegistrations.push(reg);
  }

  // -- CANCELLED class: 2 registrations (both set to cancelled)
  for (const idx of [0, 1]) {
    await prisma.registration.create({
      data: {
        classId: cancelledClass.id,
        studentId: students[idx]!.id,
        status: 'cancelled',
        tierAtBooking: students[idx]!.incomeTier,
        registeredAt: daysAgo(8),
        cancelledAt: lastWeek2,
      },
    });
  }

  // ==========================================================================
  // WAITLIST ENTRIES (on full class)
  // ==========================================================================
  // Students 8 and 9 are on the waitlist (Iris and Jan) — but they're already
  // registered in the full class above. Use students from a different scenario:
  // Actually, the full class already has all 10 students. In a real scenario
  // extra students who couldn't register would be waitlisted.
  // We'll skip creating waitlist entries that conflict with unique constraints.
  // Instead, note that waitlist entries would be created for students NOT
  // already registered. For seed purposes, we'll leave the waitlist empty
  // for the full class since all 10 students are registered.

  // ==========================================================================
  // PAYMENTS (first completed class — 9 charged registrations)
  // ==========================================================================
  const chargedRegistrations = completedRegistrations.filter(
    (_, i) => completedStatuses[i]!.charged,
  );

  const paymentStatuses: Array<{
    status: 'paid' | 'pending' | 'overdue';
    paidAt: Date | null;
    reminderSentAt: Date | null;
  }> = [
    { status: 'paid', paidAt: daysAgo(5), reminderSentAt: null },
    { status: 'paid', paidAt: daysAgo(4), reminderSentAt: null },
    { status: 'paid', paidAt: daysAgo(4), reminderSentAt: null },
    { status: 'paid', paidAt: daysAgo(3), reminderSentAt: null },
    { status: 'paid', paidAt: daysAgo(3), reminderSentAt: null },
    { status: 'pending', paidAt: null, reminderSentAt: null },
    { status: 'pending', paidAt: null, reminderSentAt: null },
    { status: 'pending', paidAt: null, reminderSentAt: null },
    { status: 'overdue', paidAt: null, reminderSentAt: daysAgo(2) },
  ];

  for (let i = 0; i < chargedRegistrations.length; i++) {
    const reg = chargedRegistrations[i]!;
    const paymentInfo = paymentStatuses[i]!;

    await prisma.payment.create({
      data: {
        registrationId: reg.id,
        amount: reg.price!,
        status: paymentInfo.status,
        method: paymentInfo.status === 'paid' ? 'bank_transfer' : null,
        paidAt: paymentInfo.paidAt,
        reminderSentAt: paymentInfo.reminderSentAt,
      },
    });
  }

  // ==========================================================================
  // OVERDUE GRADIENT (two more completed classes)
  // ==========================================================================
  // The students list shows per-student overdue counts; seed a visible
  // gradient: Iris 3, Hugo 2, Greta 1 (Iris's third overdue is the
  // pre-existing one from the first completed class above). Dev-visual
  // data — per-class totals are plausible, not recomputed by the
  // pricing engine.
  const overdueClassSpecs = [
    {
      date: daysAgo(12),
      effectiveTeacherRate: '16.25',
      totalRevenue: '51.25',
      roster: [
        { student: students[8]!, payment: 'overdue' as const }, // Iris
        { student: students[7]!, payment: 'overdue' as const }, // Hugo
        { student: students[6]!, payment: 'overdue' as const }, // Greta
        { student: students[0]!, payment: 'paid' as const }, // Anna
        { student: students[4]!, payment: 'paid' as const }, // Eva
      ],
    },
    {
      date: daysAgo(14),
      effectiveTeacherRate: '15.00',
      totalRevenue: '50.00',
      roster: [
        { student: students[8]!, payment: 'overdue' as const }, // Iris
        { student: students[7]!, payment: 'overdue' as const }, // Hugo
        { student: students[1]!, payment: 'paid' as const }, // Ben
        { student: students[2]!, payment: 'paid' as const }, // Clara
      ],
    },
  ];

  for (const spec of overdueClassSpecs) {
    const overdueClass = await prisma.class.create({
      data: {
        teacherId: ivo.id,
        teacherRoomId: ivoYogaschool.id,
        templateId: vinyasaTemplate.id,
        classType: 'Vinyasa',
        description: 'Dynamic flow class suitable for all levels.',
        date: spec.date,
        startTime: '09:00',
        durationMinutes: 75,
        roomCost: new Prisma.Decimal('35.00'),
        minRate: new Prisma.Decimal('15.00'),
        targetRate: new Prisma.Decimal('25.00'),
        minStudents: 4,
        maxStudents: 12,
        cancelDeadline: 'HOURS_24',
        autoCancelCheck: 'HOURS_2',
        status: 'completed',
        settingsLocked: true,
        effectiveTeacherRate: new Prisma.Decimal(spec.effectiveTeacherRate),
        totalStudents: spec.roster.length,
        totalRevenue: new Prisma.Decimal(spec.totalRevenue),
      },
    });

    for (const { student, payment } of spec.roster) {
      const reg = await prisma.registration.create({
        data: {
          classId: overdueClass.id,
          studentId: student.id,
          status: 'attended',
          tierAtBooking: student.incomeTier,
          price: new Prisma.Decimal(tierPriceMap[student.incomeTier]!),
          tierRatio: new Prisma.Decimal(tierRatioMap[student.incomeTier]!),
          registeredAt: new Date(spec.date.getTime() - 3 * 86400_000),
        },
      });
      await prisma.payment.create({
        data: {
          registrationId: reg.id,
          amount: reg.price!,
          status: payment,
          method: payment === 'paid' ? 'bank_transfer' : null,
          paidAt: payment === 'paid' ? spec.date : null,
          reminderSentAt: payment === 'overdue' ? daysAgo(2) : null,
        },
      });
    }
  }

  // ==========================================================================
  // NOTIFICATIONS
  // ==========================================================================
  await prisma.notification.createMany({
    data: [
      {
        recipientType: 'student',
        recipientId: students[0]!.id,
        type: 'booking_confirmed',
        title: 'Booking confirmed',
        body: `Your spot in Vinyasa on ${thisWeekThursday.toLocaleDateString()} is confirmed.`,
        relatedClassId: openClass.id,
        isRead: true,
        emailSent: true,
      },
      {
        recipientType: 'student',
        recipientId: students[0]!.id,
        type: 'class_cancelled',
        title: 'Class cancelled',
        body: 'Vinyasa class has been cancelled due to insufficient registrations.',
        relatedClassId: cancelledClass.id,
        isRead: true,
        emailSent: true,
      },
      {
        recipientType: 'teacher',
        recipientId: ivo.id,
        type: 'payment_received',
        title: 'Payment received',
        body: 'Anna de Vries has paid for Vinyasa class.',
        relatedClassId: completedClass.id,
        isRead: false,
        emailSent: false,
      },
      {
        recipientType: 'student',
        recipientId: students[4]!.id,
        type: 'reminder',
        title: 'Class tomorrow',
        body: `Reminder: Vinyasa class tomorrow at 09:00.`,
        relatedClassId: openClass.id,
        isRead: false,
        emailSent: false,
      },
      {
        recipientType: 'teacher',
        recipientId: ivo.id,
        type: 'booking_confirmed',
        title: 'New booking',
        body: 'Eva Mulder booked Vinyasa class.',
        relatedClassId: openClass.id,
        isRead: false,
        emailSent: false,
      },
    ],
  });

  // ==========================================================================
  // ANNOUNCEMENT
  // ==========================================================================
  await prisma.announcement.create({
    data: {
      teacherId: ivo.id,
      classId: completedClass.id,
      message:
        'Thank you all for a wonderful class last week! Payment details have been sent to your inbox.',
      recipientCount: 9,
    },
  });

  console.log('Seed data created successfully');
  console.log(`  Teachers: 3 (Ivo, Sarah, Maya — Maya is west of UTC)`);
  console.log(`  Students: 10 (all claimed, with classes)`);
  console.log(`  TeacherStudents: 13 (10 for Ivo, 3 for Sarah)`);
  console.log(`  Invitations: 3 (2 pending, 1 declined)`);
  console.log(`  Rooms: 3, TeacherRooms: 4`);
  console.log(`  ClassTemplate: 1`);
  console.log(`  Classes: 11 (8 for Ivo across every lifecycle state, 3 for Maya)`);
  console.log(`  StudioClassTemplate: 1`);
  console.log(`  StudioClasses: 3 (1 past, 1 upcoming, 1 one-off)`);
  console.log(`  Registrations: 42`);
  console.log(`  Payments: 18 (9 paid, 3 pending, 6 overdue)`);
  console.log(`  Notifications: 5`);
  console.log(`  Announcements: 1`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
