import sharp, { type Metadata } from 'sharp';
import { log } from '@/lib/log';
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
