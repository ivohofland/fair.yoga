/**
 * The photo upload's size limits, accepted types and refusal copy.
 * Imports nothing: client code value-imports this module.
 */
export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

/** Room for the multipart framing around a file at the limit. */
export const MAX_PHOTO_REQUEST_BYTES = MAX_PHOTO_BYTES + 64 * 1024;

export const ACCEPTED_PHOTO_TYPES = 'image/jpeg,image/png,image/webp';

export type PhotoRefusal = 'not-an-image' | 'too-many-pixels';
export type PhotoProblem = PhotoRefusal | 'no-photo' | 'too-large';

export const PHOTO_MESSAGES = {
  'no-photo': 'Choose a photo to upload.',
  'too-large': `That photo is over ${MAX_PHOTO_BYTES / (1024 * 1024)} MB. Choose a smaller one.`,
  'not-an-image': 'That file isn’t a JPEG, PNG or WebP image.',
  'too-many-pixels': 'That image is too large to process. Choose a smaller one.',
} as const satisfies Record<PhotoProblem, string>;

export function teacherPhotoPath(photoId: string): string {
  return `/api/teacher-photos/${encodeURIComponent(photoId)}`;
}
