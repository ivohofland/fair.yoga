/**
 * Next.js instrumentation hook — runs once when the server boots.
 * Starts the in-process job scheduler; roster in `src/lib/scheduler.ts`
 * (also `docs/technical-architecture.md`, Cron Jobs).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startScheduler } = await import('@/lib/scheduler');
    await startScheduler();
  }
}
