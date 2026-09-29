import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { log } from '@/lib/log';
import {
  respondOk, respondUnchanged, respondError, requireTeacher, isErrorResponse, withErrorHandler,
} from '@/lib/api-utils';
import { checkRateLimit, rateLimitKey, respondRateLimited } from '@/lib/rate-limit';
import { MAX_PHOTO_BYTES, MAX_PHOTO_REQUEST_BYTES, PHOTO_MESSAGES } from '@/lib/teacher-photo-limits';
import { processTeacherPhoto, saveTeacherPhoto, removeTeacherPhoto } from '@/services/teacher-photo';

const UPLOADS_PER_WINDOW = 10;
const UPLOAD_WINDOW_MS = 15 * 60 * 1000;

export const POST = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;
  if (session.teacherId !== id) return respondError('Access denied', 403);

  const limit = checkRateLimit(rateLimitKey('teacher-photo', id), UPLOADS_PER_WINDOW, UPLOAD_WINDOW_MS);
  if (!limit.allowed) return respondRateLimited(limit, 'Too many photo uploads.');

  // Refused before the body is read: a missing or non-numeric Content-Length
  // is refused outright rather than trusted as "small enough" — a chunked
  // body carries no Content-Length at all, and formData() would read it in
  // full regardless of what this header claims.
  const declaredHeader = request.headers.get('content-length');
  const declared = declaredHeader === null ? NaN : Number(declaredHeader);
  if (!Number.isFinite(declared) || declared <= 0) return respondError(PHOTO_MESSAGES['no-photo'], 400);
  if (declared > MAX_PHOTO_REQUEST_BYTES) return respondError(PHOTO_MESSAGES['too-large'], 400);

  let file: FormDataEntryValue | null;
  try {
    file = (await request.formData()).get('photo');
  } catch (err) {
    log.warn({ err, teacherId: id }, 'teacher photo: upload body could not be parsed');
    return respondError(PHOTO_MESSAGES['no-photo'], 400);
  }
  if (!(file instanceof File) || file.size === 0) return respondError(PHOTO_MESSAGES['no-photo'], 400);
  if (file.size > MAX_PHOTO_BYTES) return respondError(PHOTO_MESSAGES['too-large'], 400);

  const processed = await processTeacherPhoto(new Uint8Array(await file.arrayBuffer()));
  if (!processed.ok) return respondError(PHOTO_MESSAGES[processed.reason], 400);

  const saved = await saveTeacherPhoto(prisma, id, processed.bytes);
  if (!saved.saved) {
    log.info({ teacherId: id }, 'teacher photo: upload refused — the teacher was erased while it was processed');
    return respondError('Teacher not found', 404);
  }
  return respondOk({ photoId: saved.photoId });
});

export const DELETE = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;
  if (session.teacherId !== id) return respondError('Access denied', 403);

  if ((await removeTeacherPhoto(prisma, id)) === 'none') {
    return respondUnchanged<{ photoId: null }>({ photoId: null });
  }
  return respondOk({ photoId: null });
});
