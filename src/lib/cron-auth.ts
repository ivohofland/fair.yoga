import { NextRequest } from 'next/server';
import { respondError } from '@/lib/api-utils';

export function requireCronAuth(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return respondError('CRON_SECRET not configured', 500);
  }

  const auth = request.headers.get('authorization');
  if (auth !== `Bearer ${secret}`) {
    return respondError('Unauthorized', 401);
  }

  return null;
}
