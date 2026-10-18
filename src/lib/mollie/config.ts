type MollieEnvSource = Record<string, string | undefined>;

export type MollieConfig = {
  clientId: string;
  clientSecret: string;
  tokenKey: Buffer;
  testmode: boolean;
  appUrl: string;
};
export type MollieConfigProblem = 'unset' | 'partial' | 'token-key-length' | 'app-url';
export type MollieDiagnosis = { ok: true; config: MollieConfig } | { ok: false; reason: MollieConfigProblem };

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** Whether Mollie Connect is configured. Never logs or returns a secret on failure. */
export function diagnoseMollieConfig(env: MollieEnvSource = process.env): MollieDiagnosis {
  const clientId = env.MOLLIE_CLIENT_ID;
  const clientSecret = env.MOLLIE_CLIENT_SECRET;
  const rawKey = env.PROCESSOR_TOKEN_KEY;
  if (!clientId && !clientSecret && !rawKey) return { ok: false, reason: 'unset' };
  if (!clientId || !clientSecret || !rawKey) return { ok: false, reason: 'partial' };
  const tokenKey = Buffer.from(rawKey, 'base64');
  if (tokenKey.length !== 32) return { ok: false, reason: 'token-key-length' };
  const appUrl = env.NEXT_PUBLIC_APP_URL;
  if (!appUrl || !isHttpUrl(appUrl)) return { ok: false, reason: 'app-url' };
  return { ok: true, config: { clientId, clientSecret, tokenKey, testmode: env.MOLLIE_TESTMODE === '1', appUrl } };
}
