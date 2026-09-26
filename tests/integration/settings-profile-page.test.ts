import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BASE_URL, cookie, uniqueSuffix, seedSession } from '../helpers';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

/**
 * The page is the only caller that hands `timeZoneOptions` the teacher's
 * STORED zone. The unit and component tests call it directly, so this is what
 * fails if the page stops passing that zone through — the picker would then
 * have no option for a stored `UTC`, which a real browser renders blank.
 */
describe('GET /settings/profile (timezone picker)', () => {
  const email = `settings-profile-tz-${suffix}@test.local`;
  let accountId: string | undefined;

  afterAll(async () => {
    if (accountId) await prisma.session.deleteMany({ where: { accountId } });
    if (accountId) await prisma.teacher.deleteMany({ where: { accountId } });
    if (accountId) await prisma.account.deleteMany({ where: { id: accountId } });
    await prisma.$disconnect();
  });

  it('renders a stored zone the list lacks as the selected option', async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Zone',
        lastName: 'Stored',
        email,
        bio: '',
        pageSlug: `settings-profile-tz-${suffix}`,
        defaultTimezone: 'UTC',
        account: { create: { email } },
      },
      select: { accountId: true },
    });
    accountId = teacher.accountId;
    const token = await seedSession(prisma, accountId);

    const res = await fetch(`${BASE_URL}/settings/profile`, { headers: cookie(token) });
    expect(res.status).toBe(200);
    const html = await res.text();

    const selected = [...html.matchAll(/<option\b[^>]*>/g)]
      .map((m) => m[0])
      .filter((tag) => /\bselected\b/.test(tag));
    expect(selected.some((tag) => tag.includes('value="UTC"')), selected.join(' ')).toBe(true);
  });
});
