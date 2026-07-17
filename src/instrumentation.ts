/**
 * Next.js instrumentation hook — runs once when the server boots.
 * Starts the in-process job scheduler (class lifecycle, generation,
 * email fallback, payment reminders).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startScheduler } = await import('@/lib/scheduler');
    await startScheduler();
  }
}
