import { createHash, timingSafeEqual } from 'node:crypto';
import { NextRequest } from 'next/server';
import { respondError } from '@/lib/api-utils';

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/**
 * Whether the request carries the configured cron secret. Compares SHA-256
 * digests in constant time, so the lengths always match and a wrong secret's
 * length leaks nothing. False when no secret is configured.
 */
export function hasCronSecret(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const presented = request.headers.get('authorization') ?? '';
  return timingSafeEqual(digest(presented), digest(`Bearer ${secret}`));
}

export function requireCronAuth(request: NextRequest) {
  if (!process.env.CRON_SECRET) {
    return respondError('CRON_SECRET not configured', 500);
  }
  if (!hasCronSecret(request)) {
    return respondError('Unauthorized', 401);
  }
  return null;
}
