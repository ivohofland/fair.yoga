import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

// ---------------------------------------------------------------------------
// Helper: relative dates
// ---------------------------------------------------------------------------
function daysFromNow(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(0, 0, 0, 0);
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
  await prisma.announcement.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.waitlistEntry.deleteMany();
  await prisma.registration.deleteMany();
  await prisma.class.deleteMany();
  await prisma.classTemplate.deleteMany();
  await prisma.studioClass.deleteMany();
  await prisma.teacherRoom.deleteMany();
  await prisma.room.deleteMany();
  await prisma.studentPrivacy.deleteMany();
  await prisma.student.deleteMany();
  await prisma.teacher.deleteMany();

  // ==========================================================================
  // TEACHERS
  // ==========================================================================
  const ivo = await prisma.teacher.create({
    data: {
      firstName: 'Ivo',
      lastName: 'Hofland',
      email: 'ivo@fairyoga.dev',
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
    studentData.map((data) => prisma.student.create({ data })),
  );

  // ==========================================================================
  // STUDENT PRIVACY (per-teacher, for Ivo)
  // ==========================================================================
  // Varied sharing levels
  const privacySettings = [
    { shareEmail: true, sharePhone: true, shareBirthday: false, shareAddress: false }, // Anna
    { shareEmail: false, sharePhone: false, shareBirthday: false, shareAddress: false }, // Ben (max privacy)
    { shareEmail: true, sharePhone: true, shareBirthday: true, shareAddress: false }, // Clara
    { shareEmail: true, sharePhone: false, shareBirthday: false, shareAddress: false }, // David
    { shareEmail: true, sharePhone: true, shareBirthday: false, shareAddress: true }, // Eva
    { shareEmail: false, sharePhone: false, shareBirthday: true, shareAddress: false }, // Finn
    { shareEmail: true, sharePhone: true, shareBirthday: true, shareAddress: true }, // Greta (shares all)
    { shareEmail: true, sharePhone: false, shareBirthday: false, shareAddress: false }, // Hugo
    { shareEmail: true, sharePhone: true, shareBirthday: true, shareAddress: true }, // Iris (shares all)
    { shareEmail: true, sharePhone: false, shareBirthday: false, shareAddress: false }, // Jan
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
  // ROOMS
  // ==========================================================================
  const yogaschool = await prisma.room.create({
    data: {
      venueName: 'De Yogaschool',
      address: 'Nieuwe Keizersgracht 58',
      city: 'Amsterdam',
      postcode: '1018 DT',
      floor: '1st',
      roomName: 'Main Studio',
      maxCapacity: 20,
      equipment: JSON.parse('["mats", "blocks", "straps", "bolsters"]'),
      isPublic: true,
      createdById: ivo.id,
    },
  });

  const communityCenter = await prisma.room.create({
    data: {
      venueName: 'Community Center West',
      address: 'Fannius Scholtenstraat 10',
      city: 'Amsterdam',
      postcode: '1051 EX',
      floor: 'Ground',
      roomName: 'Activity Room',
      maxCapacity: 15,
      equipment: JSON.parse('["mats"]'),
      isPublic: true,
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
      teacherId: sarah.id,
      roomId: yogaschool.id,
      capacityOverride: 15,
      rentalRate: new Prisma.Decimal('40.00'),
    },
  });

  // ==========================================================================
  // CLASS TEMPLATE
  // ==========================================================================
  const vinyasaTemplate = await prisma.classTemplate.create({
    data: {
      teacherId: ivo.id,
      teacherRoomId: ivoYogaschool.id,
      classType: 'Vinyasa',
      description: 'Dynamic flow class suitable for all levels.',
      dayOfWeek: 1, // Tuesday
      startTime: '09:00',
      durationMinutes: 75,
      roomCost: new Prisma.Decimal('35.00'),
      minRate: new Prisma.Decimal('15.00'),
      targetRate: new Prisma.Decimal('25.00'),
      minStudents: 4,
      maxStudents: 12,
      cancelDeadline: 'HOURS_24',
      autoCancelCheck: 'HOURS_2',
      isActive: true,
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

  // 3. FULL — this week, 12 registrations (all spots filled)
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
      status: 'full',
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
  //   effective_teacher_rate = 15 + (25 - 15) * (9 - 4) / (12 - 4) = 21.25
  //   total = 35 + (21.25 * 9) = 226.25
  //   tier distribution: tiers [1,1,2,3,3,4,4,5,5] → ratios [0.65,0.65,0.80,1.00,1.00,1.20,1.20,1.35,1.35]
  //   sum of ratios = 9.20
  //   base price = 226.25 / 9.20 = 24.592...
  //   tier 1: 24.59 * 0.65 = 15.99, tier 2: 24.59 * 0.80 = 19.67
  //   tier 3: 24.59 * 1.00 = 24.59, tier 4: 24.59 * 1.20 = 29.51
  //   tier 5: 24.59 * 1.35 = 33.20
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
      totalRevenue: new Prisma.Decimal('226.25'),
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

  // ==========================================================================
  // STUDIO CLASS
  // ==========================================================================
  await prisma.studioClass.create({
    data: {
      teacherId: ivo.id,
      date: lastWeek,
      startTime: '11:00',
      durationMinutes: 60,
      location: 'Yoga Studio Centrum, Amsterdam',
      studentCount: 18,
      hourlyRate: new Prisma.Decimal('35.00'),
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
  // Base price: 226.25 / 9.20 ≈ 24.5924
  const tierRatioMap: Record<number, string> = {
    1: '0.6500',
    2: '0.8000',
    3: '1.0000',
    4: '1.2000',
    5: '1.3500',
  };
  const tierPriceMap: Record<number, string> = {
    1: '15.99',
    2: '19.67',
    3: '24.59',
    4: '29.51',
    5: '33.20',
  };

  const completedStatuses: Array<{
    status: 'attended' | 'no_show' | 'late_cancel' | 'cancelled';
    charged: boolean;
  }> = [
    { status: 'attended', charged: true }, // Anna (tier 1)
    { status: 'attended', charged: true }, // Ben (tier 1)
    { status: 'attended', charged: true }, // Clara (tier 2)
    { status: 'attended', charged: true }, // David — cancelled (not charged)
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
  // PAYMENTS (for completed class — 9 charged registrations)
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
  console.log(`  Teachers: 2 (Ivo, Sarah)`);
  console.log(`  Students: 10 (tiers 1-5, 2 per tier)`);
  console.log(`  Rooms: 2, TeacherRooms: 3`);
  console.log(`  ClassTemplate: 1`);
  console.log(`  Classes: 6 (draft, open, full, in_progress, completed, cancelled)`);
  console.log(`  StudioClass: 1`);
  console.log(`  Registrations: 33`);
  console.log(`  Payments: 9 (5 paid, 3 pending, 1 overdue)`);
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
