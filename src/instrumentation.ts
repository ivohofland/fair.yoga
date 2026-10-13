import { installZodLocale } from '@/lib/zod-locale';

/**
 * Next.js instrumentation hook — runs once when the server boots.
 * Gives zod its English messages (`src/lib/zod-locale.ts`), installs the
 * shutdown signal (`docs/technical-architecture.md`, Shutdown),
 * then starts the in-process job scheduler; roster in `src/lib/scheduler.ts`
 * (also `docs/technical-architecture.md`, Cron Jobs).
 */
export async function register(): Promise<void> {
  installZodLocale();
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { installShutdownSignal } = await import('@/lib/shutdown');
    installShutdownSignal();
    const { startScheduler } = await import('@/lib/scheduler');
    await startScheduler();
  }
}
