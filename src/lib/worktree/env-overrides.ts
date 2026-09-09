/**
 * Every value in a worktree's generated `.env` that would otherwise point at
 * the main checkout's shared infrastructure — a database, or this app's own
 * origin — gets re-pointed here. A var left un-repointed breaks whatever
 * reads it as if it were still talking to the shared instance.
 */
export function buildEnvOverrides(dbHost: string, dev: string, test: string, port: number): Record<string, string> {
  const appUrl = `http://localhost:${port}`;
  return {
    DATABASE_URL: `${dbHost}/${dev}`,
    DATABASE_URL_TEST: `${dbHost}/${test}`,
    INTEGRATION_BASE_URL: appUrl,
    NEXT_PUBLIC_APP_URL: appUrl,
  };
}
