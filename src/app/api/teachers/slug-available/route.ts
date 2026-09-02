import { NextRequest } from 'next/server';
import { respondOk, withErrorHandler } from '@/lib/api-utils';
import { prisma } from '@/lib/db';
import { pageSlugField } from '@/lib/schemas';
import { checkIpRateLimit, clientIp, respondRateLimited } from '@/lib/rate-limit';

export const GET = withErrorHandler(async (request: NextRequest) => {
  const ip = clientIp(request);
  const check = checkIpRateLimit('slug-available', ip, 60, 60 * 60 * 1000, 'slug-available');
  if (!check.allowed) return respondRateLimited(check, 'Too many address checks.');

  const slug = request.nextUrl.searchParams.get('slug') ?? '';

  // Reserved and malformed values are answered without a database read —
  // `pageSlugField` is the same validator the form runs in the browser.
  const parsed = pageSlugField.safeParse(slug);
  if (!parsed.success) return respondOk({ available: false });

  // Discloses nothing the public teacher page doesn't already: it calls
  // notFound() for an unknown slug, so anyone can probe this by visiting the
  // URL. Rate-limited only so it is not CHEAPER than probing. Emphatically
  // unlike email, where the uniform 200s exist to prevent exactly this.
  const taken = await prisma.teacher.findUnique({ where: { pageSlug: slug }, select: { id: true } });
  return respondOk({ available: taken === null });
});
