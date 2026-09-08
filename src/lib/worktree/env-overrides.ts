/**
 * The `.env.example` overrides a worktree's generated `.env` needs so the
 * app it runs never reads a value naming the main checkout's server or
 * database — see docs/superpowers/specs/2026-09-08-worktree-db-isolation-design.md.
 * `NEXT_PUBLIC_APP_URL` is the app's own origin: WebAuthn validates it
 * against the request (`src/lib/auth/passkey.ts`) and every magic-link/
 * invitation email embeds it (`src/lib/auth/link-delivery.ts`,
 * `src/lib/email-templates.ts`, `src/services/invitations.ts`) — left
 * un-repointed, a worktree's own app answers with the main checkout's origin.
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
