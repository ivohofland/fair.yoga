import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';

/**
 * The installed app's start URL (`src/app/manifest.ts`). A signed-out
 * person lands on sign-in rather than the public pitch `/` shows; a
 * signed-in one goes home, the teacher home first for a two-hat account.
 * See docs/technical-architecture.md (Authentication Flow → Installed app
 * start URL) for why this stays outside `src/proxy.ts`'s matcher.
 */
export default async function StartPage(): Promise<never> {
  const session = await getSession();
  if (session?.teacherId) redirect('/schedule');
  if (session?.studentId) redirect('/bookings');
  redirect('/login');
}
