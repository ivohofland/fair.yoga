import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '@/lib/prisma-client';

/**
 * Sharing a schedule publicly (#916): a secret key in the URL, switched on and
 * off by the teacher. Framework-agnostic.
 */

export type ScheduleShareState = {
  key: string | null;
  weeks: number;
  includeStudio: boolean;
};

export type ScheduleShareChange = { state: ScheduleShareState; changed: boolean };

export type ScheduleSharePatch = { weeks?: number; includeStudio?: boolean };

/** Thrown by a reset while sharing is off: there is no key to replace. */
export class ScheduleShareOffError extends Error {}

const STATE_SELECT = {
  scheduleShareKey: true,
  scheduleShareWeeks: true,
  scheduleShareStudio: true,
} as const;

function toState(row: {
  scheduleShareKey: string | null;
  scheduleShareWeeks: number;
  scheduleShareStudio: boolean;
}): ScheduleShareState {
  return { key: row.scheduleShareKey, weeks: row.scheduleShareWeeks, includeStudio: row.scheduleShareStudio };
}

/** The shape `mintScheduleShareKey` produces: 16 random bytes in base64url are always 22 characters. */
export const SHARE_KEY_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export function mintScheduleShareKey(): string {
  return randomBytes(16).toString('base64url');
}

export async function getScheduleShare(db: PrismaClient, teacherId: string): Promise<ScheduleShareState> {
  const row = await db.teacher.findUniqueOrThrow({ where: { id: teacherId }, select: STATE_SELECT });
  return toState(row);
}

/**
 * The write is conditional on the key still being null, so of two concurrent
 * requests exactly one lands its key and reports `changed`.
 */
export async function enableScheduleShare(db: PrismaClient, teacherId: string): Promise<ScheduleShareChange> {
  const { count } = await db.teacher.updateMany({
    where: { id: teacherId, deletedAt: null, scheduleShareKey: null },
    data: { scheduleShareKey: mintScheduleShareKey() },
  });
  return { state: await getScheduleShare(db, teacherId), changed: count === 1 };
}

export async function disableScheduleShare(db: PrismaClient, teacherId: string): Promise<ScheduleShareChange> {
  const { count } = await db.teacher.updateMany({
    where: { id: teacherId, scheduleShareKey: { not: null } },
    data: { scheduleShareKey: null },
  });
  return { state: await getScheduleShare(db, teacherId), changed: count === 1 };
}

export async function resetScheduleShareKey(db: PrismaClient, teacherId: string): Promise<ScheduleShareState> {
  const { count } = await db.teacher.updateMany({
    where: { id: teacherId, deletedAt: null, scheduleShareKey: { not: null } },
    data: { scheduleShareKey: mintScheduleShareKey() },
  });
  if (count === 0) throw new ScheduleShareOffError();
  return getScheduleShare(db, teacherId);
}

export async function updateScheduleShare(
  db: PrismaClient,
  teacherId: string,
  patch: ScheduleSharePatch,
): Promise<ScheduleShareState> {
  const data: { scheduleShareWeeks?: number; scheduleShareStudio?: boolean } = {};
  if (patch.weeks !== undefined) data.scheduleShareWeeks = patch.weeks;
  if (patch.includeStudio !== undefined) data.scheduleShareStudio = patch.includeStudio;
  if (Object.keys(data).length > 0) await db.teacher.updateMany({ where: { id: teacherId, deletedAt: null }, data });
  return getScheduleShare(db, teacherId);
}

export type SharedTeacher = {
  id: string;
  pageSlug: string;
  firstName: string;
  defaultTimezone: string;
  scheduleShareWeeks: number;
  scheduleShareStudio: boolean;
};

/** The live teacher whose current key this is; null for an unknown key or an erased teacher. */
export async function teacherByShareKey(db: PrismaClient, key: string): Promise<SharedTeacher | null> {
  const teacher = await db.teacher.findUnique({
    where: { scheduleShareKey: key },
    select: {
      id: true,
      pageSlug: true,
      firstName: true,
      defaultTimezone: true,
      scheduleShareWeeks: true,
      scheduleShareStudio: true,
      deletedAt: true,
    },
  });
  if (!teacher || teacher.deletedAt !== null) return null;
  return {
    id: teacher.id,
    pageSlug: teacher.pageSlug,
    firstName: teacher.firstName,
    defaultTimezone: teacher.defaultTimezone,
    scheduleShareWeeks: teacher.scheduleShareWeeks,
    scheduleShareStudio: teacher.scheduleShareStudio,
  };
}
