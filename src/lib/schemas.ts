import { z } from 'zod';

// ============================================================================
// AUTH
// ============================================================================

export const magicLinkSendSchema = z.object({
  email: z.string().email(),
});

export const magicLinkVerifySchema = z.object({
  token: z.string().min(1),
});

export const passkeyRegisterVerifySchema = z.object({
  response: z.record(z.string(), z.unknown()), // WebAuthn response is complex, validate shape loosely
});

export const passkeyAuthOptionsSchema = z.object({
  email: z.string().email().optional(),
});

export const passkeyAuthVerifySchema = z.object({
  response: z.record(z.string(), z.unknown()),
  challengeId: z.string().min(1),
});

// ============================================================================
// TEACHERS
// ============================================================================

export const createTeacherSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email(),
  bio: z.string().max(250),
  pageSlug: z.string().min(1).regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens'),
});

export const updateTeacherSchema = z.object({
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  photoUrl: z.string().url().nullable().optional(),
  bio: z.string().max(250).optional(),
  pageSlug: z.string().min(1).regex(/^[a-z0-9-]+$/).optional(),
  defaultCurrency: z.string().optional(),
  defaultTimezone: z.string().optional(),
  defaultReminder: z.enum(['morning_of', 'evening_before', 'one_hour_before']).optional(),
  bankIban: z.string().nullable().optional(),
  bankAccountName: z.string().nullable().optional(),
}).strict();

// ============================================================================
// STUDENTS
// ============================================================================

export const createStudentSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email(),
});

export const updateStudentSchema = z.object({
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  phone: z.string().nullable().optional(),
  birthday: z.string().nullable().optional(), // ISO date string
  address: z.string().nullable().optional(),
  incomeTier: z.number().int().min(1).max(5).optional(),
  reminderPref: z.enum(['eve', 'morning', 'one_hour', 'off']).optional(),
  emailNotifications: z.boolean().optional(),
}).strict();

export const updatePrivacySchema = z.object({
  teacherId: z.string().uuid(),
  shareEmail: z.boolean().optional(),
  sharePhone: z.boolean().optional(),
  shareBirthday: z.boolean().optional(),
  shareAddress: z.boolean().optional(),
  receiveComms: z.boolean().optional(),
});

export const studentListQuerySchema = z.object({
  search: z.string().optional().default(''),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(50).optional().default(20),
});

// ============================================================================
// ROOMS
// ============================================================================

export const createRoomSchema = z.object({
  venueName: z.string().min(1),
  address: z.string().min(1),
  city: z.string().min(1),
  postcode: z.string().min(1),
  floor: z.string().min(1),
  roomName: z.string().min(1),
  maxCapacity: z.number().int().positive(),
  equipment: z.unknown().optional(),
  notes: z.string().nullable().optional(),
  isPublic: z.boolean().optional(),
});

export const updateRoomSchema = z.object({
  venueName: z.string().min(1).optional(),
  address: z.string().min(1).optional(),
  city: z.string().min(1).optional(),
  postcode: z.string().min(1).optional(),
  floor: z.string().min(1).optional(),
  roomName: z.string().min(1).optional(),
  maxCapacity: z.number().int().positive().optional(),
  equipment: z.unknown().optional(),
  notes: z.string().nullable().optional(),
  isPublic: z.boolean().optional(),
}).strict();

// ============================================================================
// TEACHER ROOMS
// ============================================================================

export const createTeacherRoomSchema = z.object({
  roomId: z.string().uuid(),
  capacityOverride: z.number().int().positive(),
  rentalRate: z.number().nonnegative(),
  equipmentNotes: z.string().nullable().optional(),
});

export const updateTeacherRoomSchema = z.object({
  capacityOverride: z.number().int().positive().optional(),
  rentalRate: z.number().nonnegative().optional(),
  equipmentNotes: z.string().nullable().optional(),
}).strict();

// ============================================================================
// CLASSES
// ============================================================================

export const createClassSchema = z.object({
  teacherRoomId: z.string().uuid(),
  classType: z.string().min(1),
  description: z.string().nullable().optional(),
  date: z.string().min(1), // ISO date string
  startTime: z.string().regex(/^\d{2}:\d{2}$/, 'Must be HH:mm format'),
  durationMinutes: z.number().int().positive(),
  roomCost: z.number().nonnegative(),
  minRate: z.number(), // can be negative (teacher subsidizes)
  targetRate: z.number(),
  minStudents: z.number().int().positive(),
  maxStudents: z.number().int().positive(),
  cancelDeadline: z.enum(['HOURS_48', 'HOURS_24', 'HOURS_12', 'HOURS_6']).optional(),
  autoCancelCheck: z.enum(['HOURS_4', 'HOURS_2', 'HOURS_1']).optional(),
  templateId: z.string().uuid().nullable().optional(),
});

export const updateClassSchema = z.object({
  classType: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  date: z.string().optional(),
  startTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  durationMinutes: z.number().int().positive().optional(),
  // Economic fields — only accepted when settings not locked (checked in route)
  roomCost: z.number().nonnegative().optional(),
  minRate: z.number().optional(),
  targetRate: z.number().optional(),
  minStudents: z.number().int().positive().optional(),
  maxStudents: z.number().int().positive().optional(),
}).strict();

export const transitionClassSchema = z.object({
  status: z.enum(['draft', 'open', 'full', 'in_progress', 'completed', 'cancelled']),
});

// ============================================================================
// CLASS TEMPLATES
// ============================================================================

export const createClassTemplateSchema = z.object({
  teacherRoomId: z.string().uuid(),
  classType: z.string().min(1),
  description: z.string().nullable().optional(),
  dayOfWeek: z.number().int().min(0).max(6),
  startTime: z.string().regex(/^\d{2}:\d{2}$/),
  durationMinutes: z.number().int().positive(),
  roomCost: z.number().nonnegative(),
  minRate: z.number(),
  targetRate: z.number(),
  minStudents: z.number().int().positive(),
  maxStudents: z.number().int().positive(),
  cancelDeadline: z.enum(['HOURS_48', 'HOURS_24', 'HOURS_12', 'HOURS_6']).optional(),
  autoCancelCheck: z.enum(['HOURS_4', 'HOURS_2', 'HOURS_1']).optional(),
});

export const updateClassTemplateSchema = z.object({
  classType: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  teacherRoomId: z.string().uuid().optional(),
  dayOfWeek: z.number().int().min(0).max(6).optional(),
  startTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  durationMinutes: z.number().int().positive().optional(),
  roomCost: z.number().nonnegative().optional(),
  minRate: z.number().optional(),
  targetRate: z.number().optional(),
  minStudents: z.number().int().positive().optional(),
  maxStudents: z.number().int().positive().optional(),
  cancelDeadline: z.enum(['HOURS_48', 'HOURS_24', 'HOURS_12', 'HOURS_6']).optional(),
  autoCancelCheck: z.enum(['HOURS_4', 'HOURS_2', 'HOURS_1']).optional(),
}).strict();

// ============================================================================
// REGISTRATIONS
// ============================================================================

export const createRegistrationSchema = z.object({
  classId: z.string().uuid(),
  studentId: z.string().uuid().optional(), // optional for student self-registration
});

export const updateRegistrationSchema = z.object({
  status: z.enum(['attended', 'no_show', 'late_cancel']),
});

// ============================================================================
// WAITLIST
// ============================================================================

export const createWaitlistSchema = z.object({
  classId: z.string().uuid(),
});

// ============================================================================
// PAYMENTS
// ============================================================================

export const markPaidSchema = z.object({
  method: z.string().min(1),
});

// ============================================================================
// NOTIFICATIONS & ANNOUNCEMENTS
// ============================================================================

export const createAnnouncementSchema = z.object({
  classId: z.string().uuid().optional(),
  message: z.string().min(1),
});
