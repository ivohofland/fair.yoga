import { randomUUID } from 'node:crypto';
import sharp, { type Metadata } from 'sharp';
import type { PrismaClient } from '@prisma/client';
import { log } from '@/lib/log';
import { lockLiveTeacher } from '@/lib/db-locks';
import type { PhotoRefusal } from '@/lib/teacher-photo-limits';

/** The stored avatar's edge, in pixels. Sized against the Avatar entry in `docs/design-brief.md`. */
export const PHOTO_EDGE_PX = 400;

/** Refused before decoding — the guard against a small file that inflates to gigabytes. */
export const MAX_INPUT_PIXELS = 50_000_000;

const ACCEPTED_FORMATS: ReadonlySet<string> = new Set(['jpeg', 'png', 'webp']);

export type ProcessedPhoto = { ok: true; bytes: Buffer } | { ok: false; reason: PhotoRefusal };

/**
 * Decodes an uploaded image and re-encodes it as the stored avatar: upright
 * (EXIF orientation applied), centre-cropped square, WebP. sharp writes no
 * input metadata unless asked, so EXIF — GPS included — does not survive.
 * The format is sharp's own detection, never the client's claim.
 */
export async function processTeacherPhoto(input: Uint8Array): Promise<ProcessedPhoto> {
  let meta: Metadata;
  try {
    meta = await sharp(input).metadata();
  } catch {
    return { ok: false, reason: 'not-an-image' };
  }
  if (meta.format === undefined || !ACCEPTED_FORMATS.has(meta.format)) {
    return { ok: false, reason: 'not-an-image' };
  }
  if (meta.width === undefined || meta.height === undefined) {
    return { ok: false, reason: 'not-an-image' };
  }
  if (meta.width * meta.height > MAX_INPUT_PIXELS) {
    return { ok: false, reason: 'too-many-pixels' };
  }

  try {
    const bytes = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .resize(PHOTO_EDGE_PX, PHOTO_EDGE_PX, { fit: 'cover' })
      .webp({ quality: 80 })
      .toBuffer();
    return { ok: true, bytes };
  } catch (err) {
    // A header that parsed but a body that will not decode — a truncated or
    // corrupt upload. Logged, because the same catch would also see a failure
    // that is not the file's fault.
    log.warn({ err }, 'teacher photo: decode failed after the header parsed');
    return { ok: false, reason: 'not-an-image' };
  }
}

export type SavePhotoResult = { saved: true; photoId: string } | { saved: false; reason: 'teacher-gone' };

/**
 * Stores `bytes` as the teacher's photo under a fresh id, replacing any earlier
 * one. The `upsert` resolves two concurrent saves last-write-wins through
 * `ON CONFLICT` rather than a unique violation. Gated on `lockLiveTeacher`,
 * whose placement against erasure is `docs/lock-order.md`'s.
 */
export async function saveTeacherPhoto(
  db: PrismaClient,
  teacherId: string,
  bytes: Uint8Array,
): Promise<SavePhotoResult> {
  return db.$transaction(async (tx): Promise<SavePhotoResult> => {
    if (!(await lockLiveTeacher(tx, teacherId))) return { saved: false, reason: 'teacher-gone' };
    const photoId = randomUUID();
    // A copy: Prisma's `Bytes` input takes only an `ArrayBuffer`-backed array,
    // and a `Buffer` (sharp's output) is typed over `ArrayBufferLike`.
    const stored = new Uint8Array(bytes);
    await tx.teacherPhoto.upsert({
      where: { teacherId },
      create: { id: photoId, teacherId, bytes: stored },
      update: { id: photoId, bytes: stored },
    });
    return { saved: true, photoId };
  });
}

export async function removeTeacherPhoto(db: PrismaClient, teacherId: string): Promise<'removed' | 'none'> {
  const { count } = await db.teacherPhoto.deleteMany({ where: { teacherId } });
  return count === 0 ? 'none' : 'removed';
}

/** The stored bytes for `photoId`, or `null` when unknown or its teacher is erased. */
export async function readTeacherPhoto(db: PrismaClient, photoId: string): Promise<Uint8Array | null> {
  const row = await db.teacherPhoto.findFirst({
    where: { id: photoId, teacher: { deletedAt: null } },
    select: { bytes: true },
  });
  return row?.bytes ?? null;
}
