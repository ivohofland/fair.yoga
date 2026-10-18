# Mollie Connect, the method allowlist and refunds — Implementation Plan (#896)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A teacher connects their own Mollie account by OAuth; the allowlisted methods it enables appear as rows on the student pay page; a payment made through one settles its `Payment` by webhook; the teacher can refund any Mollie-paid payment in full.

**Architecture:** One thin HTTP adapter (`src/lib/mollie/client.ts`) is the only code that talks to Mollie, and every service takes it injected inside a `MollieDeps` value, so no test ever reaches Mollie. Tokens live encrypted in their own table. The obligation (`Payment`) stays separate from each charge attempt (`ProcessorPayment`), and refunds are rows on the attempt.

**Tech Stack:** Next.js 16 App Router, Prisma/PostgreSQL, TypeScript strict, zod, vitest (`unit`, `components`, `integration` projects), `node:crypto`.

**Spec:** `docs/superpowers/specs/2026-10-18-mollie-connect-design.md` — read it in full before any task. Decision numbers below are the spec's.

## Global Constraints

- TypeScript `strict`, no `any`; every Mollie JSON response is parsed with a zod schema, never cast.
- No test calls Mollie. Integration tests (live dev server on :3000, or the worktree's) cover only paths that make no outbound call; everything else is unit tier with the adapter injected or `fetch` stubbed.
- Never restart or re-env the dev server on :3000.
- Every 409 names a code registered in `src/lib/api-error-codes.ts`; "already done" answers `respondUnchanged`.
- Work that must not be awaited returns `FireAndForget` (`src/lib/fire-and-forget.ts`), written as `void (async () => { … })().catch(…)` with nothing before the IIFE.
- No database lock is ever held across a Mollie call.
- Comment discipline (CLAUDE.md): no counts or member lists in comments; name the type; no history in comments.
- No user-facing copy names a payment "level". A teacher reads "Mollie connected".
- Schema changes only through `pnpm exec prisma migrate dev`; hand-written CHECKs and partial indexes are appended to the generated SQL and named in a `///` comment on the model. Never edit an applied migration.
- Stage exact paths; never `git add -A`/`.`; quote paths containing `(student)`/`(teacher)`.
- `pnpm` needs Node 24 (`~/.nvm/versions/node/v24*/bin` on PATH).
- Commit messages end with `(#896)` in the subject and the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A zero-amount payment** (a class priced to €0.00 for some tier) must show no Mollie rows: Mollie refuses amounts below 0.01, and the pay page must not log a degradation for it. Pinned in Task 4.
2. **A teacher switches currency after completion**: the attempt charges the *class's* currency, never `Teacher.currency`. Pinned in Task 7.
3. **`PROCESSOR_TOKEN_KEY` replaced or wrong** (stored tokens no longer open): pay page renders the existing rows, the connection is *not* disconnected, `PROCESSOR_TOKEN_UNREADABLE` is logged. Pinned in Task 5.
4. **A webhook for an attempt whose teacher was erased** (connection gone): 200, nothing written, no Mollie call. Pinned in Task 8.
5. **The student returns before the webhook arrives**, or the webhook never arrives (localhost): the return route settles the payment itself, and a later webhook is `unchanged`. Pinned in Task 8.

---

## Task 0: Verify the Mollie facts the spec assumes

No code. The later tasks are built on these answers; a wrong one changes Task 3, 7, 8 or 9.

**Files:**
- Modify: `docs/superpowers/specs/2026-10-18-mollie-connect-design.md` (section *Mollie facts, as checked*, and any section a finding contradicts)
- Modify: this plan, where a finding changes a request shape in Task 3

- [ ] **Step 1:** For each bullet in the spec's *Mollie facts, as checked* section, find the answer on docs.mollie.com (API reference and guides). Record, per bullet: verdict (holds / wrong / not documented), the URL, and a one-line quote.
- [ ] **Step 2:** Check also, for Task 3's request shapes: the OAuth authorize URL and its parameters (`approval_prompt`), the token endpoint's auth (HTTP Basic with client id/secret) and body encoding, the revoke endpoint's body (`token_type_hint`, `token`), the `testmode` parameter on each v2 call under OAuth, `GET /v2/payments/{id}?embed=refunds`, the refund create body, and the error body shape (`status`, `title`, `detail`, `field`).
- [ ] **Step 3: The PayPal check (Decision 3).** Determine whether a Mollie-created PayPal payment can show PayPal's own pay-later offers, and whether a Mollie or PayPal setting removes them. If they can appear and cannot be turned off, remove `paypal` from the allowlist in Task 4's constant and say so in the spec's Decision 2/3.
- [ ] **Step 4:** Replace each verified bullet in the spec with the fact as found; correct any section a finding contradicts (correct by replacing, never "this previously said"). Where a finding changes Task 3's code below, edit this plan.
- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-10-18-mollie-connect-design.md docs/superpowers/plans/2026-10-18-mollie-connect.md
git commit -m "docs: verify the Mollie facts the spec assumed (#896)"
```

---

## Task 1: Schema — connection, attempts, refunds, OAuth state; drop the placeholders

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_mollie_connect/migration.sql` (generated, then appended)
- Modify: `src/services/gdpr.ts` (the `processorType: null, processorAccountId: null` lines in the teacher erasure `updateMany`)
- Modify: `src/app/api/payments/[id]/shared.test.ts` (fixture field `processorRef`)
- Modify: every `satisfies Record<NotificationType | TeacherNotificationType | PayoutChangeKind, …>` map the compiler names: `src/lib/push-policy.ts`, `src/lib/notification-retention.ts`, `src/lib/email-templates.ts`, `src/services/notification-policy.ts` (`TeacherNotificationType`, `TEACHER_EMAIL_POLICY`, `TEACHER_UNSUBSCRIBE`), and whatever renders a `PayoutChangeKind` (find with `pnpm exec tsc --noEmit`)
- Test: `src/services/processor-schema.test.ts` (unit tier, real test DB)

**Interfaces:**
- Produces: Prisma models `ProcessorConnection`, `ProcessorPayment`, `ProcessorRefund`, `OAuthState`; enums `ProcessorPaymentStatus`, `ProcessorRefundStatus`, `RefundOutcome`; new members on `PayoutChangeKind` (`processor_connected`, `processor_changed`, `processor_disconnected`) and `NotificationType` (`processor_disconnected`, `payment_paid_twice`, `payment_charged_back`, `refund_failed`, `payment_refunded`); `TeacherNotificationType` gains the teacher ones (every new member but `payment_refunded`).
- Removes: `Teacher.paymentLevel`, `Teacher.processorType`, `Teacher.processorAccountId`, `Payment.processorRef`, enum `PaymentLevel`.

- [ ] **Step 1: Write the failing constraint test**

`src/services/processor-schema.test.ts` — follow `src/services/payout-notice-delivery.test.ts` for the client and cleanup shape (`createPrismaClient()`, `uniqueSuffix()`, ids tracked and deleted in `afterAll` in FK order). Build one teacher, one student, one completed class with a registration and a `Payment` (copy the fixture calls from `tests/integration/pay-page.test.ts`, which uses `createClassFixture` from `tests/class-fixtures.ts`). Then:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Prisma } from '@/generated/prisma/client';
import { createPrismaClient } from '@/lib/prisma-client';

const prisma = createPrismaClient();
const sealed = Buffer.from([1, 2, 3]);

async function connection(teacherId: string, data: Partial<Prisma.ProcessorConnectionUncheckedCreateInput> = {}) {
  return prisma.processorConnection.create({
    data: {
      teacherId, processor: 'mollie', organizationId: 'org_test', profileId: 'pfl_test',
      accessToken: sealed, refreshToken: sealed, accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      scopes: ['payments.read'], testmode: true, ...data,
    },
  });
}

async function expectCheck(promise: Promise<unknown>, constraint: string) {
  await expect(promise).rejects.toThrow(constraint);
}

describe('ProcessorConnection constraints', () => {
  it('refuses a row without tokens that is not revoked', async () => {
    await expectCheck(connection(teacherA, { accessToken: null }), 'ProcessorConnection_tokens_present_check');
  });
  it('refuses a revoked row that still holds tokens', async () => {
    await expectCheck(
      connection(teacherB, { disconnectedAt: new Date(), revokedAt: new Date() }),
      'ProcessorConnection_tokens_absent_check',
    );
  });
  it('refuses revocation fields on a row that is not disconnected', async () => {
    await expectCheck(connection(teacherC, { revokeAfter: new Date() }), 'ProcessorConnection_revoke_check');
  });
});

describe('ProcessorPayment settling index', () => {
  it('allows at most one settling attempt per payment', async () => {
    const base = { paymentId, connectionId, profileId: 'pfl_seed', testmode: true, method: 'ideal', status: 'paid' as const, amount: new Prisma.Decimal('10.00'), currency: 'EUR' as const };
    await prisma.processorPayment.create({ data: { ...base, processorPaymentId: `tr_a${suffix}`, settledPayment: true } });
    await expect(
      prisma.processorPayment.create({ data: { ...base, processorPaymentId: `tr_b${suffix}`, settledPayment: true } }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await prisma.processorPayment.create({ data: { ...base, processorPaymentId: `tr_c${suffix}`, settledPayment: false } });
  });
});

describe('ProcessorRefund live index', () => {
  it('allows one live refund per attempt, and another after a failure', async () => {
    const first = await prisma.processorRefund.create({ data: { attemptId, amount: new Prisma.Decimal('10.00'), status: 'queued' } });
    await expect(
      prisma.processorRefund.create({ data: { attemptId, amount: new Prisma.Decimal('10.00'), status: 'queued' } }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await prisma.processorRefund.update({ where: { id: first.id }, data: { status: 'failed' } });
    await prisma.processorRefund.create({ data: { attemptId, amount: new Prisma.Decimal('10.00'), status: 'queued' } });
  });
});
```

(`teacherA/B/C`, `paymentId`, `connectionId`, `attemptId`, `suffix` are set in `beforeAll`; each connection test uses its own teacher because `teacherId` is unique.)

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm exec vitest run --project unit src/services/processor-schema.test.ts`
Expected: FAIL — TypeScript/Prisma errors, `processorConnection` does not exist on the client.

- [ ] **Step 3: Edit `prisma/schema.prisma`**

Remove `paymentLevel`, `processorType`, `processorAccountId` from `Teacher`, `processorRef` from `Payment`, and the `PaymentLevel` enum. Add to `Teacher`: `processorConnection ProcessorConnection?` and `oauthStates OAuthState[]`; to `Payment`: `processorAttempts ProcessorPayment[]`; to `Session`: `oauthStates OAuthState[]`. Add the enum members listed under *Interfaces*. Add:

```prisma
enum ProcessorPaymentStatus {
  open
  pending
  authorized
  paid
  canceled
  expired
  failed
}

enum ProcessorRefundStatus {
  queued
  pending
  processing
  refunded
  failed
  canceled
}

enum RefundOutcome {
  waived
  reopened
}

/// A teacher's OAuth connection to their payment processor. `accessToken` and
/// `refreshToken` are ciphertexts from `src/lib/processor-token-cipher.ts`.
/// Live means `disconnectedAt IS NULL AND profileId IS NOT NULL`.
/// Hand-written in the migration: `ProcessorConnection_tokens_present_check`,
/// `ProcessorConnection_tokens_absent_check`, `ProcessorConnection_revoke_check`.
model ProcessorConnection {
  id                   String        @id @default(uuid())
  teacherId            String        @unique
  processor            ProcessorType
  organizationId       String
  profileId            String?
  accessToken          Bytes?
  accessTokenExpiresAt DateTime?
  refreshToken         Bytes?
  scopes               String[]
  testmode             Boolean
  connectedAt          DateTime      @default(now())
  disconnectedAt       DateTime?
  revokeAfter          DateTime?
  revokedAt            DateTime?

  teacher  Teacher            @relation(fields: [teacherId], references: [id], onDelete: Cascade)
  attempts ProcessorPayment[]
}

/// One charge attempt at the processor for a `Payment`. `currency` is what the
/// processor charged and is never relabelled. `chargedBackAt` is when the
/// processor first reported a chargeback on it. Hand-written in the migration:
/// `ProcessorPayment_one_settling_per_payment` (partial unique on `paymentId`
/// where `settledPayment`).
model ProcessorPayment {
  id                 String                 @id @default(uuid())
  paymentId          String
  connectionId       String?
  processorPaymentId String                 @unique
  profileId          String
  testmode           Boolean
  method             String
  status             ProcessorPaymentStatus
  amount             Decimal                @db.Decimal(10, 2)
  currency           Currency
  checkoutUrl        String?
  expiresAt          DateTime?
  paidAt             DateTime?
  settledPayment     Boolean                @default(false)
  chargedBackAt      DateTime?
  createdAt          DateTime               @default(now())
  updatedAt          DateTime               @updatedAt

  payment    Payment              @relation(fields: [paymentId], references: [id], onDelete: Cascade)
  connection ProcessorConnection? @relation(fields: [connectionId], references: [id], onDelete: SetNull)
  refunds    ProcessorRefund[]

  @@index([paymentId])
}

/// A full refund of one attempt. `processorRefundId` is null until the
/// processor accepts it. Hand-written in the migration:
/// `ProcessorRefund_one_live_per_attempt` (partial unique on `attemptId` where
/// the status is neither `failed` nor `canceled`).
model ProcessorRefund {
  id                String                @id @default(uuid())
  attemptId         String
  processorRefundId String?               @unique
  amount            Decimal               @db.Decimal(10, 2)
  status            ProcessorRefundStatus
  outcome           RefundOutcome?
  requestedAt       DateTime              @default(now())
  updatedAt         DateTime              @updatedAt

  attempt ProcessorPayment @relation(fields: [attemptId], references: [id], onDelete: Cascade)

  @@index([attemptId])
}

/// The `state` of one OAuth authorize round trip, bound to the session that
/// started it. `stateHash` is sha256 of 32 random bytes (`hashToken`).
model OAuthState {
  id        String   @id @default(uuid())
  stateHash String   @unique
  teacherId String
  sessionId String
  expiresAt DateTime
  createdAt DateTime @default(now())

  teacher Teacher @relation(fields: [teacherId], references: [id], onDelete: Cascade)
  session Session @relation(fields: [sessionId], references: [id], onDelete: Cascade)
}
```

Match `ProcessorPayment.amount`/`ProcessorRefund.amount` to `Payment.amount`'s `@db` type if it differs from `Decimal(10, 2)`.

- [ ] **Step 4: Generate the migration, then append the hand-written SQL**

Run: `pnpm exec prisma migrate dev --create-only --name mollie_connect`
Append to the generated `migration.sql`:

```sql
-- A connection holds both tokens and their expiry until it is revoked.
ALTER TABLE "ProcessorConnection" ADD CONSTRAINT "ProcessorConnection_tokens_present_check"
  CHECK ("revokedAt" IS NOT NULL OR ("accessToken" IS NOT NULL AND "refreshToken" IS NOT NULL AND "accessTokenExpiresAt" IS NOT NULL));

-- A revoked connection holds no token.
ALTER TABLE "ProcessorConnection" ADD CONSTRAINT "ProcessorConnection_tokens_absent_check"
  CHECK ("revokedAt" IS NULL OR ("accessToken" IS NULL AND "refreshToken" IS NULL AND "accessTokenExpiresAt" IS NULL));

-- Revocation is scheduled and recorded only on a disconnected connection.
ALTER TABLE "ProcessorConnection" ADD CONSTRAINT "ProcessorConnection_revoke_check"
  CHECK ("disconnectedAt" IS NOT NULL OR ("revokeAfter" IS NULL AND "revokedAt" IS NULL));

-- At most one attempt settled each payment.
CREATE UNIQUE INDEX "ProcessorPayment_one_settling_per_payment" ON "ProcessorPayment"("paymentId") WHERE "settledPayment";

-- At most one refund per attempt that has not failed or been canceled.
CREATE UNIQUE INDEX "ProcessorRefund_one_live_per_attempt" ON "ProcessorRefund"("attemptId") WHERE "status" NOT IN ('failed', 'canceled');
```

Then run: `pnpm exec prisma migrate dev` (applies it and regenerates the client). Then run the seed if `migrate dev` did not (`pnpm exec prisma db seed`) — it is the first thing that can trip a new constraint.

- [ ] **Step 5: Make it compile**

Run: `pnpm exec tsc --noEmit`. Fix each error:
- `src/services/gdpr.ts`: delete the two processor lines from the teacher erasure `updateMany` (Task 10 adds the connection's own erasure).
- `shared.test.ts`: drop `processorRef` from the fixture and from the "never exposes" assertion list if present.
- Notification maps — classify each new member:
  - `STUDENT_PUSH_GROUP`: `payment_refunded` → the group `payment_request` uses; each teacher type → `'never'`.
  - `RETENTION`: every new type → `STANDARD_RETENTION_DAYS`.
  - `STUDENT_INTROS` (exhaustive over `NotificationType`): one sentence each, e.g. `payment_refunded: 'Your teacher refunded a payment.'`, teacher types get the same wording style as the existing teacher entries there.
  - `TeacherNotificationType`: add `'processor_disconnected' | 'payment_paid_twice' | 'payment_charged_back' | 'refund_failed'`.
  - `TEACHER_EMAIL_POLICY`: each new teacher type `() => true` (money; always email, as `class_cancelled`).
  - `TEACHER_UNSUBSCRIBE`: each new teacher type `null`.
  - `TEACHER_PUSH_GROUP`: each new teacher type → the group `payment_request` uses for teachers.
  - `ESSENTIAL_NOTIFICATION_TYPES` (a Set, not compiler-checked): add `payment_refunded`.
- Anything switching on `PayoutChangeKind` (the alert email copy): add the three processor kinds with copy "Mollie connected" / "Mollie account changed" / "Mollie disconnected".

- [ ] **Step 6: Run the test, see it pass**

Run: `pnpm exec vitest run --project unit src/services/processor-schema.test.ts`
Expected: PASS.

- [ ] **Step 7: Prove each constraint bites.** For each of the five hand-written objects, in the test DB (`DATABASE_URL_TEST`) through `psql` in the `fairyoga-db-1` container: drop it (`ALTER TABLE … DROP CONSTRAINT …` / `DROP INDEX …`), rerun the test file, record the failing test name and message, recreate it with the exact SQL above, rerun to green. Record the five failure texts for the PR body.

- [ ] **Step 8: Run the whole unit tier and typecheck**

Run: `pnpm exec tsc --noEmit && pnpm exec vitest run --project unit`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/*_mollie_connect src/services/gdpr.ts "src/app/api/payments/[id]/shared.test.ts" src/services/processor-schema.test.ts src/lib/push-policy.ts src/lib/notification-retention.ts src/lib/email-templates.ts src/services/notification-policy.ts
# plus any PayoutChangeKind copy file tsc named
git commit -m "feat: processor connection, attempt and refund tables; drop the level placeholders (#896)"
```

---

## Task 2: Mollie config and the token cipher

**Files:**
- Create: `src/lib/mollie/config.ts`, `src/lib/mollie/config.test.ts`
- Create: `src/lib/processor-token-cipher.ts`, `src/lib/processor-token-cipher.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces:
  - `type MollieConfig = { clientId: string; clientSecret: string; tokenKey: Buffer; testmode: boolean; appUrl: string }`
  - `type MollieConfigProblem = 'unset' | 'partial' | 'token-key-length' | 'app-url'`
  - `diagnoseMollieConfig(env?: Record<string, string | undefined>): { ok: true; config: MollieConfig } | { ok: false; reason: MollieConfigProblem }`
  - `sealToken(plaintext: string, key: Buffer): Buffer`, `openToken(sealed: Uint8Array, key: Buffer): string`, `class TokenCipherError extends Error`, `TOKEN_CIPHER_VERSION = 1`

- [ ] **Step 1: Write the failing tests**

`src/lib/processor-token-cipher.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { sealToken, openToken, TokenCipherError, TOKEN_CIPHER_VERSION } from './processor-token-cipher';

const key = randomBytes(32);

describe('processor token cipher', () => {
  it('round-trips a token', () => {
    expect(openToken(sealToken('access_abc', key), key)).toBe('access_abc');
  });
  it('writes the version byte first and a fresh IV each time', () => {
    const a = sealToken('same', key);
    const b = sealToken('same', key);
    expect(a[0]).toBe(TOKEN_CIPHER_VERSION);
    expect(a.equals(b)).toBe(false);
  });
  it('refuses a tampered ciphertext', () => {
    const sealed = sealToken('access_abc', key);
    sealed[sealed.length - 1] ^= 0x01;
    expect(() => openToken(sealed, key)).toThrow(TokenCipherError);
  });
  it('refuses the wrong key', () => {
    expect(() => openToken(sealToken('access_abc', key), randomBytes(32))).toThrow(TokenCipherError);
  });
  it('refuses an unknown version', () => {
    const sealed = sealToken('access_abc', key);
    sealed[0] = 2;
    expect(() => openToken(sealed, key)).toThrow(/version 2/);
  });
  it('refuses a key that is not 32 bytes', () => {
    expect(() => sealToken('x', randomBytes(16))).toThrow(TokenCipherError);
  });
  it('refuses a truncated value', () => {
    expect(() => openToken(Buffer.from([TOKEN_CIPHER_VERSION, 1, 2]), key)).toThrow(TokenCipherError);
  });
});
```

`src/lib/mollie/config.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { diagnoseMollieConfig } from './config';

const key = Buffer.alloc(32, 7).toString('base64');
const full = { MOLLIE_CLIENT_ID: 'app_x', MOLLIE_CLIENT_SECRET: 's', PROCESSOR_TOKEN_KEY: key, NEXT_PUBLIC_APP_URL: 'https://fair.yoga' };

describe('diagnoseMollieConfig', () => {
  it('is unset when none of the three is set', () => {
    expect(diagnoseMollieConfig({ NEXT_PUBLIC_APP_URL: 'https://fair.yoga' })).toEqual({ ok: false, reason: 'unset' });
  });
  it('is partial when only some are set', () => {
    expect(diagnoseMollieConfig({ MOLLIE_CLIENT_ID: 'app_x' })).toEqual({ ok: false, reason: 'partial' });
  });
  it('refuses a key that does not decode to 32 bytes', () => {
    expect(diagnoseMollieConfig({ ...full, PROCESSOR_TOKEN_KEY: Buffer.alloc(16).toString('base64') }))
      .toEqual({ ok: false, reason: 'token-key-length' });
  });
  it('needs the app URL for redirect and webhook URLs', () => {
    expect(diagnoseMollieConfig({ ...full, NEXT_PUBLIC_APP_URL: undefined })).toEqual({ ok: false, reason: 'app-url' });
  });
  it('answers the config, live by default', () => {
    const d = diagnoseMollieConfig(full);
    expect(d.ok && d.config.testmode).toBe(false);
    expect(d.ok && d.config.tokenKey.length).toBe(32);
  });
  it('reads MOLLIE_TESTMODE=1 as test mode', () => {
    const d = diagnoseMollieConfig({ ...full, MOLLIE_TESTMODE: '1' });
    expect(d.ok && d.config.testmode).toBe(true);
  });
});
```

- [ ] **Step 2: Run, see them fail**

Run: `pnpm exec vitest run --project unit src/lib/processor-token-cipher.test.ts src/lib/mollie/config.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`src/lib/processor-token-cipher.ts`:

```ts
import 'server-only';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** The first byte of every sealed token; a new key gets a new version. */
export const TOKEN_CIPHER_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export class TokenCipherError extends Error {}

/** AES-256-GCM, laid out `[version][iv][tag][ciphertext]`; the version byte is authenticated. */
export function sealToken(plaintext: string, key: Buffer): Buffer {
  if (key.length !== KEY_BYTES) throw new TokenCipherError(`token key must be ${KEY_BYTES} bytes`);
  const version = Buffer.from([TOKEN_CIPHER_VERSION]);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(version);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([version, iv, cipher.getAuthTag(), ciphertext]);
}

export function openToken(sealed: Uint8Array, key: Buffer): string {
  const buf = Buffer.from(sealed);
  if (buf.length < 1 + IV_BYTES + TAG_BYTES) throw new TokenCipherError('sealed token is too short');
  const version = buf[0];
  if (version !== TOKEN_CIPHER_VERSION) throw new TokenCipherError(`unknown token cipher version ${String(version)}`);
  const iv = buf.subarray(1, 1 + IV_BYTES);
  const tag = buf.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
  const ciphertext = buf.subarray(1 + IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(buf.subarray(0, 1));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (err) {
    throw new TokenCipherError('sealed token failed authentication', { cause: err });
  }
}
```

`src/lib/mollie/config.ts`:

```ts
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
  if (!appUrl) return { ok: false, reason: 'app-url' };
  return { ok: true, config: { clientId, clientSecret, tokenKey, testmode: env.MOLLIE_TESTMODE === '1', appUrl } };
}
```

`.env.example`: replace the `MOLLIE_API_KEY=` line (keep the Stripe lines) with:

```env
# Mollie Connect. All three unset turns Mollie off. Generate the key with
# `openssl rand -base64 32`; replacing it makes every stored token unreadable.
MOLLIE_CLIENT_ID=
MOLLIE_CLIENT_SECRET=
PROCESSOR_TOKEN_KEY=
MOLLIE_TESTMODE=            # 1 creates test-mode payments
```

- [ ] **Step 4: Run, see them pass**

Run: `pnpm exec vitest run --project unit src/lib/processor-token-cipher.test.ts src/lib/mollie/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Prove the AAD bites.** Remove the explicit version check in `openToken` and change the test's unknown-version expectation to `toThrow(TokenCipherError)`: it still passes, because the version byte is authenticated. Then also remove `setAAD` from both functions: that test now fails (the altered byte opens). Record the failure; restore both; restore the test's `/version 2/` expectation; rerun green.

- [ ] **Step 6: Commit**

```bash
git add src/lib/processor-token-cipher.ts src/lib/processor-token-cipher.test.ts src/lib/mollie/config.ts src/lib/mollie/config.test.ts .env.example
git commit -m "feat: Mollie config diagnosis and the token cipher (#896)"
```

---

## Task 3: The Mollie HTTP adapter

**Files:**
- Create: `src/lib/mollie/client.ts`, `src/lib/mollie/client.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces (exact):

```ts
export class MollieUnavailable extends Error { readonly status: number | null }
export type MollieAmount = { value: string; currency: string };
export type TokenGrant = { accessToken: string; refreshToken: string; expiresInSeconds: number; scopes: string[] };
export type TokenAnswer = { kind: 'granted'; grant: TokenGrant } | { kind: 'invalid_grant' };
export type MollieProfile = { id: string; name: string; mode: 'live' | 'test'; status: string };
export type MethodsAnswer = { kind: 'methods'; ids: string[] } | { kind: 'unsupported' };
export type MollieRefundView = { id: string; status: string; amount: MollieAmount };
export type MolliePaymentView = {
  id: string; status: string; method: string | null; amount: MollieAmount;
  checkoutUrl: string | null; expiresAt: string | null; paidAt: string | null;
  amountChargedBack: MollieAmount | null; refunds: MollieRefundView[];
};
export type CreatePaymentInput = {
  amount: MollieAmount; description: string; method: string; redirectUrl: string;
  webhookUrl: string | null; profileId: string; metadata: { paymentId: string; attemptId: string }; testmode: boolean;
};
export type RefundAnswer =
  | { kind: 'created'; refund: MollieRefundView }
  | { kind: 'refused'; detail: string; field: string | null };
export interface MollieClient {
  authorizeUrl(input: { redirectUri: string; state: string; scopes: readonly string[]; forcePrompt: boolean }): string;
  exchangeCode(code: string, redirectUri: string): Promise<TokenAnswer>;
  refresh(refreshToken: string): Promise<TokenAnswer>;
  revoke(refreshToken: string): Promise<void>;
  organization(accessToken: string): Promise<{ id: string; name: string }>;
  profiles(accessToken: string): Promise<MollieProfile[]>;
  listMethods(accessToken: string, q: { profileId: string; amount: MollieAmount; testmode: boolean }): Promise<MethodsAnswer>;
  createPayment(accessToken: string, input: CreatePaymentInput): Promise<MolliePaymentView>;
  getPayment(accessToken: string, id: string, q: { testmode: boolean }): Promise<MolliePaymentView | null>;
  createRefund(accessToken: string, paymentId: string, q: { amount: MollieAmount; testmode: boolean }): Promise<RefundAnswer>;
}
export function createMollieClient(
  credentials: { clientId: string; clientSecret: string },
  options?: { fetchImpl?: typeof fetch; timeoutMs?: number },
): MollieClient;
```

Classification rule, for every method: a network error, a timeout, or a 5xx throws `MollieUnavailable`; a 401/403 on a `/v2` call throws `MollieUnavailable` with that status (the token service decides what it means); the specific non-2xx answers each method lists below are returned as values; any other non-2xx throws `MollieUnavailable`.

- [ ] **Step 1: Write the failing tests**

`src/lib/mollie/client.test.ts` — inject `fetchImpl` (the `src/lib/push/send.ts` pattern), one `describe` per method. The cases (write each as an `it` with an explicit `Response`):

```ts
import { describe, it, expect, vi } from 'vitest';
import { createMollieClient, MollieUnavailable } from './client';

function client(responses: Response[]) {
  const fetchImpl = vi.fn<typeof fetch>();
  for (const r of responses) fetchImpl.mockResolvedValueOnce(r);
  return { fetchImpl, mollie: createMollieClient({ clientId: 'app_id', clientSecret: 'secret' }, { fetchImpl, timeoutMs: 50 }) };
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/hal+json' } });

describe('exchangeCode', () => {
  it('posts the code with basic auth and answers the grant', async () => {
    const { fetchImpl, mollie } = client([json(200, {
      access_token: 'access_1', refresh_token: 'refresh_1', expires_in: 3600, token_type: 'bearer', scope: 'payments.read payments.write',
    })]);
    const answer = await mollie.exchangeCode('auth_code', 'https://fair.yoga/api/processor/mollie/callback');
    expect(answer).toEqual({ kind: 'granted', grant: { accessToken: 'access_1', refreshToken: 'refresh_1', expiresInSeconds: 3600, scopes: ['payments.read', 'payments.write'] } });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.mollie.com/oauth2/tokens');
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Basic ${Buffer.from('app_id:secret').toString('base64')}`);
    expect(String(init?.body)).toContain('grant_type=authorization_code');
  });
  it('answers invalid_grant for a 400 invalid_grant', async () => {
    const { mollie } = client([json(400, { error: 'invalid_grant', error_description: 'expired' })]);
    expect(await mollie.exchangeCode('c', 'https://x')).toEqual({ kind: 'invalid_grant' });
  });
});

describe('refresh', () => {
  it('keeps the old refresh token when Mollie returns none', async () => {
    const { mollie } = client([json(200, { access_token: 'a2', expires_in: 3600, token_type: 'bearer', scope: 'payments.read' })]);
    const answer = await mollie.refresh('refresh_old');
    expect(answer.kind === 'granted' && answer.grant.refreshToken).toBe('refresh_old');
  });
  it('answers invalid_grant when access was revoked', async () => {
    const { mollie } = client([json(400, { error: 'invalid_grant' })]);
    expect(await mollie.refresh('r')).toEqual({ kind: 'invalid_grant' });
  });
  it('throws MollieUnavailable on a 503', async () => {
    const { mollie } = client([json(503, {})]);
    await expect(mollie.refresh('r')).rejects.toBeInstanceOf(MollieUnavailable);
  });
});

describe('listMethods', () => {
  it('asks for the profile, amount and test mode, and answers the ids', async () => {
    const { fetchImpl, mollie } = client([json(200, { _embedded: { methods: [{ id: 'ideal' }, { id: 'klarna' }] } })]);
    const answer = await mollie.listMethods('tok', { profileId: 'pfl_1', amount: { value: '12.50', currency: 'EUR' }, testmode: true });
    expect(answer).toEqual({ kind: 'methods', ids: ['ideal', 'klarna'] });
    const url = new URL(String(fetchImpl.mock.calls[0]![0]));
    expect(url.pathname).toBe('/v2/methods');
    expect(url.searchParams.get('profileId')).toBe('pfl_1');
    expect(url.searchParams.get('amount[value]')).toBe('12.50');
    expect(url.searchParams.get('amount[currency]')).toBe('EUR');
    expect(url.searchParams.get('testmode')).toBe('true');
    expect(new Headers(fetchImpl.mock.calls[0]![1]?.headers).get('Authorization')).toBe('Bearer tok');
  });
  it('answers unsupported for a 422', async () => {
    const { mollie } = client([json(422, { status: 422, title: 'Unprocessable Entity', detail: 'currency not supported', field: 'amount.currency' })]);
    expect(await mollie.listMethods('tok', { profileId: 'p', amount: { value: '1.00', currency: 'AED' }, testmode: false })).toEqual({ kind: 'unsupported' });
  });
  it('throws MollieUnavailable when fetch rejects (timeout, network)', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new DOMException('timeout', 'TimeoutError'));
    const mollie = createMollieClient({ clientId: 'a', clientSecret: 'b' }, { fetchImpl });
    await expect(mollie.listMethods('t', { profileId: 'p', amount: { value: '1.00', currency: 'EUR' }, testmode: false })).rejects.toBeInstanceOf(MollieUnavailable);
  });
});

describe('createPayment', () => {
  it('sends one method, no applicationFee, and reads the checkout link', async () => {
    const { fetchImpl, mollie } = client([json(201, {
      id: 'tr_1', status: 'open', method: 'ideal', amount: { value: '10.00', currency: 'EUR' },
      expiresAt: '2026-10-18T12:15:00+00:00', paidAt: null, _links: { checkout: { href: 'https://www.mollie.com/checkout/x' } },
    })]);
    const view = await mollie.createPayment('tok', {
      amount: { value: '10.00', currency: 'EUR' }, description: 'Hatha Sat 18 Oct', method: 'ideal',
      redirectUrl: 'https://fair.yoga/r', webhookUrl: 'https://fair.yoga/api/webhooks/mollie', profileId: 'pfl_1',
      metadata: { paymentId: 'pay_1', attemptId: 'att_1' }, testmode: false,
    });
    expect(view).toMatchObject({ id: 'tr_1', status: 'open', checkoutUrl: 'https://www.mollie.com/checkout/x', refunds: [] });
    const body = JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body)) as Record<string, unknown>;
    expect(body.method).toBe('ideal');
    expect(body).not.toHaveProperty('applicationFee');
    expect(body).not.toHaveProperty('testmode');
  });
  it('omits webhookUrl when it is null', async () => {
    const { fetchImpl, mollie } = client([json(201, { id: 'tr_2', status: 'open', method: 'ideal', amount: { value: '1.00', currency: 'EUR' }, _links: { checkout: { href: 'https://c' } } })]);
    await mollie.createPayment('tok', { amount: { value: '1.00', currency: 'EUR' }, description: 'd', method: 'ideal', redirectUrl: 'http://localhost:3000/r', webhookUrl: null, profileId: 'p', metadata: { paymentId: 'a', attemptId: 'b' }, testmode: true });
    const body = JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty('webhookUrl');
    expect(body.testmode).toBe(true);
  });
});

describe('getPayment', () => {
  it('embeds refunds', async () => {
    const { fetchImpl, mollie } = client([json(200, {
      id: 'tr_1', status: 'paid', method: 'ideal', amount: { value: '10.00', currency: 'EUR' }, paidAt: '2026-10-18T12:05:00+00:00',
      _embedded: { refunds: [{ id: 're_1', status: 'queued', amount: { value: '10.00', currency: 'EUR' } }] }, _links: {},
    })]);
    const view = await mollie.getPayment('tok', 'tr_1', { testmode: false });
    expect(view?.refunds).toEqual([{ id: 're_1', status: 'queued', amount: { value: '10.00', currency: 'EUR' } }]);
    expect(new URL(String(fetchImpl.mock.calls[0]![0])).searchParams.get('embed')).toBe('refunds');
  });
  it('reads amountChargedBack, and null when Mollie omits it', async () => {
    const { mollie } = client([
      json(200, { id: 'tr_1', status: 'paid', method: 'ideal', amount: { value: '10.00', currency: 'EUR' }, amountChargedBack: { value: '4.00', currency: 'EUR' }, _links: {} }),
      json(200, { id: 'tr_2', status: 'paid', method: 'ideal', amount: { value: '10.00', currency: 'EUR' }, _links: {} }),
    ]);
    expect((await mollie.getPayment('tok', 'tr_1', { testmode: false }))?.amountChargedBack).toEqual({ value: '4.00', currency: 'EUR' });
    expect((await mollie.getPayment('tok', 'tr_2', { testmode: false }))?.amountChargedBack).toBeNull();
  });
  it('answers null for a 404', async () => {
    const { mollie } = client([json(404, { status: 404 })]);
    expect(await mollie.getPayment('tok', 'tr_x', { testmode: false })).toBeNull();
  });
});

describe('createRefund', () => {
  it('answers refused with Mollie\'s detail for a 422', async () => {
    const { mollie } = client([json(422, { status: 422, detail: 'Insufficient balance', field: null })]);
    expect(await mollie.createRefund('tok', 'tr_1', { amount: { value: '10.00', currency: 'EUR' }, testmode: false }))
      .toEqual({ kind: 'refused', detail: 'Insufficient balance', field: null });
  });
});

describe('authorizeUrl', () => {
  it('forces the consent prompt only on a reconnect', () => {
    const { mollie } = client([]);
    const input = { redirectUri: 'https://fair.yoga/api/processor/mollie/callback', state: 's1', scopes: ['payments.read', 'refunds.write'] };
    const first = new URL(mollie.authorizeUrl({ ...input, forcePrompt: false }));
    expect(first.origin + first.pathname).toBe('https://my.mollie.com/oauth2/authorize');
    expect(first.searchParams.get('scope')).toBe('payments.read refunds.write');
    expect(first.searchParams.get('response_type')).toBe('code');
    expect(first.searchParams.has('approval_prompt')).toBe(false);
    expect(new URL(mollie.authorizeUrl({ ...input, forcePrompt: true })).searchParams.get('approval_prompt')).toBe('force');
  });
});

describe('revoke and a 401', () => {
  it('revokes the refresh token', async () => {
    const { fetchImpl, mollie } = client([new Response(null, { status: 204 })]);
    await mollie.revoke('refresh_1');
    expect(String(fetchImpl.mock.calls[0]![1]?.body)).toContain('token_type_hint=refresh_token');
    expect(fetchImpl.mock.calls[0]![1]?.method).toBe('DELETE');
  });
  it('a 401 on a v2 call throws MollieUnavailable carrying the status', async () => {
    const { mollie } = client([json(401, { status: 401 })]);
    await expect(mollie.organization('tok')).rejects.toMatchObject({ status: 401 });
  });
});
```

Adjust request details to whatever Task 0 recorded; the shapes above are the spec's assumption.

- [ ] **Step 2: Run, see them fail**

Run: `pnpm exec vitest run --project unit src/lib/mollie/client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/lib/mollie/client.ts`**

Start with `import 'server-only';`. Structure:

```ts
import 'server-only';
import { z } from 'zod';

const API = 'https://api.mollie.com';
const AUTHORIZE = 'https://my.mollie.com/oauth2/authorize';
const DEFAULT_TIMEOUT_MS = 8_000;

export class MollieUnavailable extends Error {
  constructor(message: string, readonly status: number | null, options?: { cause?: unknown }) {
    super(message, options);
  }
}

const amountSchema = z.object({ value: z.string(), currency: z.string() });
const tokenSchema = z.object({
  access_token: z.string(), refresh_token: z.string().optional(), expires_in: z.number(), scope: z.string(),
});
const oauthErrorSchema = z.object({ error: z.string() });
const errorSchema = z.object({ detail: z.string().optional(), field: z.string().nullable().optional() });
const refundSchema = z.object({ id: z.string(), status: z.string(), amount: amountSchema });
const paymentSchema = z.object({
  id: z.string(), status: z.string(), method: z.string().nullable().optional(), amount: amountSchema,
  expiresAt: z.string().nullable().optional(), paidAt: z.string().nullable().optional(),
  amountChargedBack: amountSchema.optional(),
  _embedded: z.object({ refunds: z.array(refundSchema).optional() }).optional(),
  _links: z.object({ checkout: z.object({ href: z.string() }).optional() }).optional(),
});
const methodsSchema = z.object({ _embedded: z.object({ methods: z.array(z.object({ id: z.string() })) }) });
const orgSchema = z.object({ id: z.string(), name: z.string() });
const profilesSchema = z.object({
  _embedded: z.object({ profiles: z.array(z.object({ id: z.string(), name: z.string(), mode: z.enum(['live', 'test']), status: z.string() })) }),
});

function toView(p: z.infer<typeof paymentSchema>): MolliePaymentView {
  return {
    id: p.id, status: p.status, method: p.method ?? null, amount: p.amount,
    checkoutUrl: p._links?.checkout?.href ?? null, expiresAt: p.expiresAt ?? null, paidAt: p.paidAt ?? null,
    amountChargedBack: p.amountChargedBack ?? null, refunds: p._embedded?.refunds ?? [],
  };
}
```

then `createMollieClient` with one private `send(url, init)` that applies `AbortSignal.timeout(timeoutMs)`, converts a rejected fetch into `MollieUnavailable(…, null, { cause })`, and returns the `Response`; and one `parse(schema, res)` that throws `MollieUnavailable('unexpected response shape', res.status)` when zod fails. Each method:

- `authorizeUrl`: `AUTHORIZE?client_id&redirect_uri&state&scope=<space-joined>&response_type=code`, plus `&approval_prompt=force` only when `forcePrompt` (a reconnect): Mollie revokes the previous authorizations when a forced prompt ends in a new one, and `auto` is the default.
- `exchangeCode`/`refresh`: `POST API/oauth2/tokens`, `Authorization: Basic base64(id:secret)`, `Content-Type: application/x-www-form-urlencoded`, body `grant_type=authorization_code&code&redirect_uri` or `grant_type=refresh_token&refresh_token`. 200 → `granted` (scopes split on spaces; `refreshToken` falls back to the one sent, for refresh). 400 with `error: 'invalid_grant'` → `invalid_grant`. Else → throw.
- `revoke`: `DELETE API/oauth2/tokens`, same Basic auth, form body `token_type_hint=refresh_token&token=…`. 2xx → resolve; else throw.
- `/v2` calls: `Authorization: Bearer <token>`; `organization` → `GET /v2/organizations/me`; `profiles` → `GET /v2/profiles?limit=250`; `listMethods` → `GET /v2/methods` with the query above, 422 → `unsupported`; `createPayment` → `POST /v2/payments` JSON body (omit `webhookUrl` when null, include `testmode: true` only when true, never `applicationFee`); `getPayment` → `GET /v2/payments/{id}?embed=refunds` (+`testmode=true`), 404 → null; `createRefund` → `POST /v2/payments/{id}/refunds` JSON `{ amount, testmode? }`, 422 → `refused` with `detail` (default `'Mollie refused the refund.'`) and `field`.

- [ ] **Step 4: Run, see them pass**

Run: `pnpm exec vitest run --project unit src/lib/mollie/client.test.ts`
Expected: PASS.

- [ ] **Step 5: Prove the classification bites.** Change the 422 branch of `listMethods` to throw instead of answering `unsupported`; rerun; record the failure; restore. Change the `refresh` fallback to `refresh_token ?? ''`; rerun; record; restore.

- [ ] **Step 6: Commit**

```bash
git add src/lib/mollie/client.ts src/lib/mollie/client.test.ts
git commit -m "feat: the Mollie HTTP adapter (#896)"
```

---

## Task 4: The allowlist and the offered methods

**Files:**
- Create: `src/lib/processor-methods.ts`, `src/lib/processor-methods.test.ts`
- Create: `src/services/mollie-deps.ts`
- Create: `src/services/processor-methods-offer.ts`, `src/services/processor-methods-offer.test.ts`
- Create: `src/services/processor-methods-cache.ts` (the cache alone, so Task 5's token service can clear it without an import cycle)
- Modify: `src/lib/degradation-codes.ts`, `docs/degradation-sites.md` (code `MOLLIE_UNAVAILABLE`)

**Interfaces:**
- Consumes: `MollieClient`, `MollieUnavailable` (Task 3); `MollieConfig`, `diagnoseMollieConfig` (Task 2).
- Produces:

```ts
// src/lib/processor-methods.ts
export type MollieMethodEntry = { label: string; expiresMinutes: number; recurring: boolean };
export const MOLLIE_METHODS: { readonly ideal: MollieMethodEntry; /* … one key per allowed method */ };
export type AllowedMollieMethod = keyof typeof MOLLIE_METHODS;
export function isAllowedMollieMethod(id: string): id is AllowedMollieMethod;
export function orderOffered(ids: readonly string[]): { offered: AllowedMollieMethod[]; excluded: string[] };
export type ExclusionReason = 'pay_later' | 'not_offered';
export function exclusionReason(id: string): ExclusionReason;
export const EXCLUSION_COPY: Record<ExclusionReason, string>;
export const LONGEST_METHOD_EXPIRY_MINUTES: number;

// src/services/mollie-deps.ts
export type MollieDeps = { client: MollieClient; config: MollieConfig };
export function mollieDeps(): MollieDeps | null;

// src/services/processor-methods-offer.ts
export type OfferedMethods = { kind: 'methods'; offered: AllowedMollieMethod[]; excluded: string[] } | { kind: 'unavailable' };
export const METHODS_CACHE_MS = 60_000;
export function listOfferedMethods(
  db: PrismaClient, deps: MollieDeps,
  connection: { id: string; profileId: string; testmode: boolean },
  amount: Prisma.Decimal, currency: Currency, now?: number,
): Promise<OfferedMethods>;
export function forgetOfferedMethods(connectionId: string): void;
```

`listOfferedMethods` needs `getAccessToken` from Task 5. **Task order:** implement Task 4's pure module and `mollieDeps` first, then do Task 5, then return to Step 5 onward of this task. A single implementer may simply do Task 5 before Task 4's service half; the plan keeps them separate for review.

- [ ] **Step 1: Write the failing pure tests** (`src/lib/processor-methods.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { MOLLIE_METHODS, isAllowedMollieMethod, orderOffered, exclusionReason, LONGEST_METHOD_EXPIRY_MINUTES } from './processor-methods';

describe('the allowlist', () => {
  it('holds no pay-later method', () => {
    for (const id of ['klarna', 'in3', 'riverty', 'billie', 'billink', 'alma', 'klarnapaylater', 'klarnasliceit']) {
      expect(isAllowedMollieMethod(id)).toBe(false);
    }
  });
  it('holds neither Mollie bank transfer nor googlepay', () => {
    expect(isAllowedMollieMethod('banktransfer')).toBe(false);
    expect(isAllowedMollieMethod('googlepay')).toBe(false);
  });
  it('holds no PayPal, whose checkout can offer pay-later (Decision 3)', () => {
    expect(isAllowedMollieMethod('paypal')).toBe(false);
  });
  it('lists iDEAL and Wero as separate rows', () => {
    expect(MOLLIE_METHODS.ideal.label).toBe('iDEAL');
    expect(MOLLIE_METHODS.wero.label).toBe('Wero');
  });
  it('is not fooled by prototype keys', () => {
    expect(isAllowedMollieMethod('toString')).toBe(false);
    expect(isAllowedMollieMethod('__proto__')).toBe(false);
  });
});

describe('orderOffered', () => {
  it('keeps allowlisted ids in allowlist order and reports the rest', () => {
    expect(orderOffered(['twint', 'klarna', 'ideal', 'paypal', 'newmethod'])).toEqual({
      offered: ['ideal', 'twint'], excluded: ['klarna', 'paypal', 'newmethod'],
    });
  });
});

describe('exclusionReason', () => {
  it('names pay-later for credit products and not-offered for the rest', () => {
    expect(exclusionReason('klarna')).toBe('pay_later');
    expect(exclusionReason('banktransfer')).toBe('not_offered');
  });
});

it('the longest expiry is an hour', () => {
  expect(LONGEST_METHOD_EXPIRY_MINUTES).toBe(60);
});
```

- [ ] **Step 2: Run, see them fail.** `pnpm exec vitest run --project unit src/lib/processor-methods.test.ts` → FAIL, module not found.

- [ ] **Step 3: Implement `src/lib/processor-methods.ts`**

```ts
/** One method fair.yoga offers at checkout. `recurring` is whether it can start a mandate. */
export type MollieMethodEntry = { label: string; expiresMinutes: number; recurring: boolean };

/**
 * The methods fair.yoga offers, in pay-page order. An allowlist: a method the
 * processor adds is offered only once a reviewed change adds it here. The rule
 * for what may be added is the spec's Decision 1 (no deferred payment).
 */
export const MOLLIE_METHODS = {
  ideal: { label: 'iDEAL', expiresMinutes: 15, recurring: false },
  wero: { label: 'Wero', expiresMinutes: 10, recurring: false },
  bancontact: { label: 'Bancontact', expiresMinutes: 60, recurring: false },
  creditcard: { label: 'Card', expiresMinutes: 30, recurring: false },
  applepay: { label: 'Apple Pay', expiresMinutes: 30, recurring: false },
  eps: { label: 'EPS', expiresMinutes: 60, recurring: false },
  blik: { label: 'BLIK', expiresMinutes: 1, recurring: false },
  przelewy24: { label: 'Przelewy24', expiresMinutes: 60, recurring: false },
  twint: { label: 'TWINT', expiresMinutes: 45, recurring: false },
} as const satisfies Record<string, MollieMethodEntry>;

export type AllowedMollieMethod = keyof typeof MOLLIE_METHODS;

const ORDER = Object.keys(MOLLIE_METHODS) as AllowedMollieMethod[];

export function isAllowedMollieMethod(id: string): id is AllowedMollieMethod {
  return Object.hasOwn(MOLLIE_METHODS, id);
}

/** The ids fair.yoga offers, in allowlist order, and the ones it does not. */
export function orderOffered(ids: readonly string[]): { offered: AllowedMollieMethod[]; excluded: string[] } {
  const present = new Set(ids);
  return {
    offered: ORDER.filter((m) => present.has(m)),
    excluded: ids.filter((id) => !isAllowedMollieMethod(id)),
  };
}

/**
 * Copy only — which sentence explains an excluded method to the teacher. It
 * gates nothing; the allowlist does.
 */
const PAY_LATER_IDS: ReadonlySet<string> = new Set(['klarna', 'klarnapaylater', 'klarnasliceit', 'klarnapaynow', 'in3', 'riverty', 'billie', 'billink', 'alma']);
export type ExclusionReason = 'pay_later' | 'not_offered';
export function exclusionReason(id: string): ExclusionReason {
  return PAY_LATER_IDS.has(id) ? 'pay_later' : 'not_offered';
}
export const EXCLUSION_COPY = {
  pay_later: "fair.yoga doesn't offer pay-later credit at checkout.",
  not_offered: 'fair.yoga doesn’t offer this method yet.',
} as const satisfies Record<ExclusionReason, string>;

export const LONGEST_METHOD_EXPIRY_MINUTES = Math.max(...ORDER.map((m) => MOLLIE_METHODS[m].expiresMinutes));
```

(BLIK's `expiresMinutes` is 1: Mollie's BLIK page gives a 55-second session timeout and the expiry table has no row for it.)

- [ ] **Step 4: Run, see them pass.** Same command → PASS.

- [ ] **Step 5: `src/services/mollie-deps.ts`** (no test of its own; the push consumer is its model)

```ts
import { createMollieClient, type MollieClient } from '@/lib/mollie/client';
import { diagnoseMollieConfig, type MollieConfig } from '@/lib/mollie/config';
import { log } from '@/lib/log';

export type MollieDeps = { client: MollieClient; config: MollieConfig };

let reported = false;
let cached: MollieDeps | null | undefined;

/** Mollie's client and config, or null when Mollie is not configured. Logs the reason once per process. */
export function mollieDeps(): MollieDeps | null {
  if (cached !== undefined) return cached;
  const d = diagnoseMollieConfig();
  if (!d.ok) {
    if (!reported) {
      reported = true;
      if (d.reason === 'unset') log.warn({ reason: d.reason }, 'Mollie is not configured; Mollie payments are off');
      else log.error({ reason: d.reason }, 'Mollie is misconfigured; Mollie payments are off');
    }
    cached = null;
    return null;
  }
  cached = { client: createMollieClient(d.config), config: d.config };
  return cached;
}
```

- [ ] **Step 6: Register `MOLLIE_UNAVAILABLE`** in `src/lib/degradation-codes.ts`:

```ts
MOLLIE_UNAVAILABLE: {
  level: 'warn',
  description: 'Mollie could not be reached or answered unexpectedly. The pay page showed the teacher’s other payment rows without Mollie’s, or a webhook was answered 503 for Mollie to retry.',
  contextKeys: ['connectionId', 'operation', 'status'],
},
```

and add its `### \`MOLLIE_UNAVAILABLE\`` runbook section to `docs/degradation-sites.md` (What happened / Where the bad value lives / Confirm / Correct, as the neighbouring sections). `operation` is one of the client method names.

- [ ] **Step 7: Write the failing service tests** (`src/services/processor-methods-offer.test.ts`, unit tier, real DB)

Create a teacher and a live connection whose tokens are sealed with a test key and expire in an hour (so `getAccessToken` uses them without refreshing). Build `deps` with a hand-written fake client (an object implementing `MollieClient` whose methods are `vi.fn`s) and a `config` with that key. Cases:

```ts
it('offers allowlisted methods in allowlist order and reports the rest', async () => {
  fake.listMethods.mockResolvedValue({ kind: 'methods', ids: ['twint', 'klarna', 'ideal'] });
  expect(await listOfferedMethods(prisma, deps, conn, new Prisma.Decimal('12.50'), 'EUR'))
    .toEqual({ kind: 'methods', offered: ['ideal', 'twint'], excluded: ['klarna'] });
  expect(fake.listMethods).toHaveBeenCalledWith('access_plain', { profileId: conn.profileId, amount: { value: '12.50', currency: 'EUR' }, testmode: true });
});
it('drops an id the processor returns that the allowlist does not hold', async () => {
  fake.listMethods.mockResolvedValue({ kind: 'methods', ids: ['brandnewcredit'] });
  expect(await listOfferedMethods(prisma, deps, conn, new Prisma.Decimal('5.00'), 'EUR'))
    .toEqual({ kind: 'methods', offered: [], excluded: ['brandnewcredit'] });
});
it('answers empty for an unsupported currency, without a degradation', async () => {
  fake.listMethods.mockResolvedValue({ kind: 'unsupported' });
  expect(await listOfferedMethods(prisma, deps, conn, new Prisma.Decimal('5.00'), 'AED'))
    .toEqual({ kind: 'methods', offered: [], excluded: [] });
  expect(degradations()).toHaveLength(0);
});
it('answers empty for a zero amount without calling Mollie', async () => {
  expect(await listOfferedMethods(prisma, deps, conn, new Prisma.Decimal('0.00'), 'EUR'))
    .toEqual({ kind: 'methods', offered: [], excluded: [] });
  expect(fake.listMethods).not.toHaveBeenCalled();
});
it('answers unavailable and logs MOLLIE_UNAVAILABLE when Mollie is down', async () => {
  fake.listMethods.mockRejectedValue(new MollieUnavailable('down', 503));
  expect(await listOfferedMethods(prisma, deps, conn, new Prisma.Decimal('5.00'), 'EUR')).toEqual({ kind: 'unavailable' });
  expect(degradations().map((d) => d.code)).toEqual(['MOLLIE_UNAVAILABLE']);
});
it('caches for 60 s per connection, currency and amount', async () => {
  fake.listMethods.mockResolvedValue({ kind: 'methods', ids: ['ideal'] });
  await listOfferedMethods(prisma, deps, conn, new Prisma.Decimal('5.00'), 'EUR', 1_000);
  await listOfferedMethods(prisma, deps, conn, new Prisma.Decimal('5.00'), 'EUR', 1_000 + 59_999);
  expect(fake.listMethods).toHaveBeenCalledTimes(1);
  await listOfferedMethods(prisma, deps, conn, new Prisma.Decimal('5.00'), 'EUR', 1_000 + 60_000);
  expect(fake.listMethods).toHaveBeenCalledTimes(2);
  await listOfferedMethods(prisma, deps, conn, new Prisma.Decimal('6.00'), 'EUR', 1_000 + 60_000);
  expect(fake.listMethods).toHaveBeenCalledTimes(3);
});
```

`degradations()` reads the recorded degradation store the `unit` project sets up (`tests/setup/degradation-store.ts`; use the accessor it exports). Call `forgetOfferedMethods(conn.id)` in `beforeEach`.

- [ ] **Step 8: Run, see them fail.** `pnpm exec vitest run --project unit src/services/processor-methods-offer.test.ts` → FAIL.

- [ ] **Step 9: Implement `src/services/processor-methods-offer.ts`**

```ts
import type { PrismaClient } from '@/generated/prisma/client';
import { Prisma, type Currency } from '@/generated/prisma/client';
import { MollieUnavailable } from '@/lib/mollie/client';
import { orderOffered, type AllowedMollieMethod } from '@/lib/processor-methods';
import { logDegraded } from '@/lib/degradation';
import type { MollieDeps } from './mollie-deps';
import { getAccessToken } from './processor-token';
import { offerCache, type CachedOffer } from './processor-methods-cache';
export { forgetOfferedMethods } from './processor-methods-cache';

export type OfferedMethods =
  | { kind: 'methods'; offered: AllowedMollieMethod[]; excluded: string[] }
  | { kind: 'unavailable' };

export const METHODS_CACHE_MS = 60_000;
const MIN_AMOUNT = new Prisma.Decimal('0.01');
const EMPTY: CachedOffer = { kind: 'methods', offered: [], excluded: [] };
```

with the cache in `src/services/processor-methods-cache.ts`:

```ts
import type { AllowedMollieMethod } from '@/lib/processor-methods';

export type CachedOffer = { kind: 'methods'; offered: AllowedMollieMethod[]; excluded: string[] };
export const offerCache = new Map<string, { at: number; value: CachedOffer }>();

/** Drops every cached overlap for a connection; called whenever the connection changes. */
export function forgetOfferedMethods(connectionId: string): void {
  for (const key of offerCache.keys()) if (key.startsWith(`${connectionId}:`)) offerCache.delete(key);
}
```

and `processor-methods-offer.ts` re-exporting `forgetOfferedMethods` and using `offerCache` where the body below says `cache`:

```ts

/** The teacher's enabled methods for this amount and currency that fair.yoga offers. */
export async function listOfferedMethods(
  db: PrismaClient,
  deps: MollieDeps,
  connection: { id: string; profileId: string; testmode: boolean },
  amount: Prisma.Decimal,
  currency: Currency,
  now: number = Date.now(),
): Promise<OfferedMethods> {
  if (amount.lessThan(MIN_AMOUNT)) return EMPTY;
  const key = `${connection.id}:${currency}:${amount.toFixed(2)}`;
  const hit = offerCache.get(key);
  if (hit && now - hit.at < METHODS_CACHE_MS) return hit.value;

  const token = await getAccessToken(db, deps, connection.id);
  if (token.kind !== 'token') return { kind: 'unavailable' };
  let value: CachedOffer;
  try {
    const answer = await deps.client.listMethods(token.accessToken, {
      profileId: connection.profileId, amount: { value: amount.toFixed(2), currency }, testmode: connection.testmode,
    });
    value = answer.kind === 'unsupported' ? EMPTY : { kind: 'methods', ...orderOffered(answer.ids) };
  } catch (err) {
    if (!(err instanceof MollieUnavailable)) throw err;
    logDegraded('MOLLIE_UNAVAILABLE', { connectionId: connection.id, operation: 'listMethods', status: err.status }, 'Mollie methods unavailable; pay page shows the other rows', err);
    return { kind: 'unavailable' };
  }
  offerCache.set(key, { at: now, value });
  return value;
}
```

(Unavailable answers are deliberately not cached, so recovery is immediate. If `logDegraded`'s context type rejects a `null` status, pass `status ?? 0`.)

- [ ] **Step 10: Run, see them pass.** Same command → PASS. Then `pnpm exec vitest run --project unit src/lib/degradation-codes.test.ts` → PASS (it checks the runbook heading).

- [ ] **Step 11: Prove the allowlist gate bites.** Replace `orderOffered(answer.ids)` with `{ offered: answer.ids as AllowedMollieMethod[], excluded: [] }`; rerun; record which test fails (the `brandnewcredit` and `klarna` ones); restore.

- [ ] **Step 12: Commit**

```bash
git add src/lib/processor-methods.ts src/lib/processor-methods.test.ts src/services/mollie-deps.ts src/services/processor-methods-offer.ts src/services/processor-methods-offer.test.ts src/services/processor-methods-cache.ts src/lib/degradation-codes.ts docs/degradation-sites.md
git commit -m "feat: the method allowlist and the offered-methods overlap (#896)"
```

---

## Task 5: Access tokens — refresh, single flight, disconnect on `invalid_grant`

**Files:**
- Create: `src/services/processor-token.ts`, `src/services/processor-token.test.ts`
- Modify: `src/lib/degradation-codes.ts`, `docs/degradation-sites.md` (codes `PROCESSOR_DISCONNECTED`, `PROCESSOR_TOKEN_UNREADABLE`)

**Interfaces:**
- Consumes: `MollieDeps` (Task 4 Step 5), `openToken`/`sealToken`/`TokenCipherError` (Task 2), `createNotification` (`src/services/notifications.ts`).
- Produces:

```ts
export type TokenLookup = { kind: 'token'; accessToken: string } | { kind: 'disconnected' } | { kind: 'unavailable' };
export const REFRESH_MARGIN_MS = 5 * 60_000;
export function getAccessToken(db: PrismaClient, deps: MollieDeps, connectionId: string, now?: Date): Promise<TokenLookup>;
export function sealGrant(grant: TokenGrant, key: Buffer, now: Date): { accessToken: Buffer; refreshToken: Buffer; accessTokenExpiresAt: Date };
```

`getAccessToken` answers a token for any row not yet revoked — including a disconnected one, whose open attempts' webhooks still need it. Callers that offer methods check liveness themselves.

- [ ] **Step 1: Write the failing tests** (unit tier, real DB, fake client as in Task 4)

```ts
it('answers the stored token while it has more than five minutes left', async () => {
  const c = await seedConnection({ expiresAt: new Date(now.getTime() + 10 * 60_000) });
  expect(await getAccessToken(prisma, deps, c.id, now)).toEqual({ kind: 'token', accessToken: 'access_plain' });
  expect(fake.refresh).not.toHaveBeenCalled();
});
it('refreshes inside the margin and stores the new pair sealed', async () => {
  const c = await seedConnection({ expiresAt: new Date(now.getTime() + 60_000) });
  fake.refresh.mockResolvedValue({ kind: 'granted', grant: { accessToken: 'access_new', refreshToken: 'refresh_new', expiresInSeconds: 3600, scopes: [] } });
  expect(await getAccessToken(prisma, deps, c.id, now)).toEqual({ kind: 'token', accessToken: 'access_new' });
  const row = await prisma.processorConnection.findUniqueOrThrow({ where: { id: c.id } });
  expect(openToken(row.refreshToken!, key)).toBe('refresh_new');
  expect(row.accessTokenExpiresAt!.getTime()).toBe(now.getTime() + 3_600_000);
});
it('refreshes once for concurrent callers', async () => {
  const c = await seedConnection({ expiresAt: new Date(now.getTime() - 1) });
  fake.refresh.mockImplementation(async () => ({ kind: 'granted', grant: { accessToken: 'a2', refreshToken: 'r2', expiresInSeconds: 3600, scopes: [] } }));
  const results = await Promise.all([getAccessToken(prisma, deps, c.id, now), getAccessToken(prisma, deps, c.id, now)]);
  expect(fake.refresh).toHaveBeenCalledTimes(1);
  expect(results).toEqual([{ kind: 'token', accessToken: 'a2' }, { kind: 'token', accessToken: 'a2' }]);
});
it('disconnects, nulls the tokens, tells the teacher and logs on invalid_grant', async () => {
  const c = await seedConnection({ expiresAt: new Date(now.getTime() - 1) });
  fake.refresh.mockResolvedValue({ kind: 'invalid_grant' });
  expect(await getAccessToken(prisma, deps, c.id, now)).toEqual({ kind: 'disconnected' });
  const row = await prisma.processorConnection.findUniqueOrThrow({ where: { id: c.id } });
  expect(row).toMatchObject({ accessToken: null, refreshToken: null, disconnectedAt: now, revokedAt: now });
  expect(await prisma.notification.count({ where: { recipientId: teacherId, type: 'processor_disconnected' } })).toBe(1);
  expect(degradations().map((d) => d.code)).toContain('PROCESSOR_DISCONNECTED');
});
it('answers unavailable and leaves the connection alone when Mollie is down', async () => {
  const c = await seedConnection({ expiresAt: new Date(now.getTime() - 1) });
  fake.refresh.mockRejectedValue(new MollieUnavailable('down', 503));
  expect(await getAccessToken(prisma, deps, c.id, now)).toEqual({ kind: 'unavailable' });
  expect((await prisma.processorConnection.findUniqueOrThrow({ where: { id: c.id } })).disconnectedAt).toBeNull();
});
it('answers unavailable without disconnecting when the stored token cannot be opened (Review Focus 3)', async () => {
  const c = await seedConnection({ expiresAt: new Date(now.getTime() + 3_600_000), sealWith: randomBytes(32) });
  expect(await getAccessToken(prisma, deps, c.id, now)).toEqual({ kind: 'unavailable' });
  expect((await prisma.processorConnection.findUniqueOrThrow({ where: { id: c.id } })).disconnectedAt).toBeNull();
  expect(degradations().map((d) => d.code)).toContain('PROCESSOR_TOKEN_UNREADABLE');
});
it('answers disconnected for a revoked row', async () => {
  const c = await seedConnection({ revoked: true });
  expect(await getAccessToken(prisma, deps, c.id, now)).toEqual({ kind: 'disconnected' });
});
it('uses the winner\'s token when another refresh wrote first', async () => {
  // Simulate a second process: refresh resolves after the row was rewritten underneath.
  const c = await seedConnection({ expiresAt: new Date(now.getTime() - 1) });
  fake.refresh.mockImplementation(async () => {
    await prisma.processorConnection.update({ where: { id: c.id }, data: sealGrant({ accessToken: 'winner', refreshToken: 'rw', expiresInSeconds: 3600, scopes: [] }, key, now) });
    return { kind: 'granted', grant: { accessToken: 'loser', refreshToken: 'rl', expiresInSeconds: 3600, scopes: [] } };
  });
  expect(await getAccessToken(prisma, deps, c.id, now)).toEqual({ kind: 'token', accessToken: 'winner' });
});
```

- [ ] **Step 2: Run, see them fail.** `pnpm exec vitest run --project unit src/services/processor-token.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/services/processor-token.ts`**

```ts
import type { PrismaClient } from '@/generated/prisma/client';
import { MollieUnavailable, type TokenGrant } from '@/lib/mollie/client';
import { openToken, sealToken, TokenCipherError } from '@/lib/processor-token-cipher';
import { logDegraded } from '@/lib/degradation';
import { createNotification } from './notifications';
import type { MollieDeps } from './mollie-deps';

export type TokenLookup = { kind: 'token'; accessToken: string } | { kind: 'disconnected' } | { kind: 'unavailable' };
export const REFRESH_MARGIN_MS = 5 * 60_000;

const inflight = new Map<string, Promise<TokenLookup>>();

export function sealGrant(grant: TokenGrant, key: Buffer, now: Date) {
  return {
    accessToken: sealToken(grant.accessToken, key),
    refreshToken: sealToken(grant.refreshToken, key),
    accessTokenExpiresAt: new Date(now.getTime() + grant.expiresInSeconds * 1000),
  };
}

/**
 * A usable access token for a connection not yet revoked. Refreshes inside
 * `REFRESH_MARGIN_MS`, once per connection at a time in this process; a
 * conditional write settles a refresh that raced another.
 */
export async function getAccessToken(db: PrismaClient, deps: MollieDeps, connectionId: string, now: Date = new Date()): Promise<TokenLookup> {
  const row = await db.processorConnection.findUnique({
    where: { id: connectionId },
    select: { teacherId: true, accessToken: true, refreshToken: true, accessTokenExpiresAt: true, revokedAt: true },
  });
  if (!row || row.revokedAt !== null || !row.accessToken || !row.refreshToken || !row.accessTokenExpiresAt) return { kind: 'disconnected' };
  let access: string;
  let refresh: string;
  try {
    access = openToken(row.accessToken, deps.config.tokenKey);
    refresh = openToken(row.refreshToken, deps.config.tokenKey);
  } catch (err) {
    if (!(err instanceof TokenCipherError)) throw err;
    logDegraded('PROCESSOR_TOKEN_UNREADABLE', { connectionId }, 'stored processor token could not be opened; is PROCESSOR_TOKEN_KEY the key it was sealed with?', err);
    return { kind: 'unavailable' };
  }
  if (row.accessTokenExpiresAt.getTime() - now.getTime() > REFRESH_MARGIN_MS) return { kind: 'token', accessToken: access };

  const running = inflight.get(connectionId);
  if (running) return running;
  const sealedRefresh = row.refreshToken;
  const flight = refreshOnce(db, deps, connectionId, row.teacherId, refresh, sealedRefresh, now).finally(() => inflight.delete(connectionId));
  inflight.set(connectionId, flight);
  return flight;
}
```

`refreshOnce`: call `deps.client.refresh(refresh)`.
- `MollieUnavailable` → `logDegraded('MOLLIE_UNAVAILABLE', { connectionId, operation: 'refresh', status })`, answer `unavailable`.
- `invalid_grant` → in one `$transaction`: a raw `UPDATE ... WHERE id = $id AND "revokedAt" IS NULL AND "refreshToken" = <the sealed bytes read at the start>` setting `accessToken`, `refreshToken`, `accessTokenExpiresAt`, `revokeAfter` to null, `revokedAt` to now and `disconnectedAt = COALESCE("disconnectedAt", now)`, returning whether `disconnectedAt` was set before; zero rows means a newer grant or a revocation won, so re-read the row and answer from it with no log, notification or cache change. When a row changed and `disconnectedAt` was not set before, a `createNotification(tx, { recipientType: 'teacher', recipientId: teacherId, type: 'processor_disconnected', title: 'Mollie disconnected', body: 'fair.yoga can no longer reach your Mollie account, so students see your other payment options. Reconnect in Settings → Profile.' })`. After commit, `logDegraded('PROCESSOR_DISCONNECTED', { connectionId }, …)` and `forgetOfferedMethods(connectionId)`. Answer `disconnected`.
- `granted` → `updateMany({ where: { id, refreshToken: sealedRefresh }, data: sealGrant(grant, key, now) })`; count 1 → `token` with the new access token; count 0 → re-read the row and answer its access token (opened) if it is outside the margin, else `unavailable`.

(Import `forgetOfferedMethods` from `src/services/processor-methods-cache.ts`, not from `processor-methods-offer.ts`, which imports this module.)

Register `PROCESSOR_DISCONNECTED` (`level: 'warn'`, contextKeys `['connectionId']`) and `PROCESSOR_TOKEN_UNREADABLE` (`level: 'error'`, contextKeys `['connectionId']`) with runbook sections.

- [ ] **Step 4: Run, see them pass.** Same command, plus `src/lib/degradation-codes.test.ts` → PASS.

- [ ] **Step 5: Prove the guards bite.** (a) Remove the `inflight` check; rerun; the concurrent test fails with `toHaveBeenCalledTimes(1)` receiving 2 — record; restore. (b) Drop `refreshToken: sealedRefresh` from the `where`; rerun; the winner test fails — record; restore. (c) Make the unreadable branch disconnect; rerun; Review Focus 3's test fails — record; restore.

- [ ] **Step 6: Commit**

```bash
git add src/services/processor-token.ts src/services/processor-token.test.ts src/lib/degradation-codes.ts docs/degradation-sites.md
git commit -m "feat: processor access tokens with refresh and disconnect on invalid_grant (#896)"
```

---

## Task 6: Connecting and disconnecting

**Files:**
- Create: `src/services/processor-connection.ts`, `src/services/processor-connection.test.ts`
- Create: `src/app/api/teachers/[id]/processor/route.ts` (DELETE) and `route.test.ts`
- Create: `src/app/api/teachers/[id]/processor/connect/route.ts` (POST) and `route.test.ts`
- Create: `src/app/api/teachers/[id]/processor/profile/route.ts` (PUT) and `route.test.ts`
- Create: `src/app/api/processor/mollie/callback/route.ts` (GET) and `route.test.ts`
- Create: `src/components/settings/mollie-connection-section.tsx` (+ `.test.tsx` in the `components` project)
- Modify: `src/app/(teacher)/settings/profile/page.tsx` (render the section beside bank accounts and payment link)
- Modify: `src/lib/payout-fingerprint.ts`, `src/services/payout-resume.ts` (`readPayoutDetails`), their tests
- Modify: `src/lib/api-error-codes.ts` (`OAUTH_STATE_INVALID: 409`, `PROCESSOR_NOT_CONNECTED: 409`, `PROCESSOR_UNAVAILABLE: 503`)
- Modify: `src/lib/schemas.ts` (`processorProfileSchema`)

**Interfaces:**
- Consumes: `MollieDeps`, `sealGrant`, `getAccessToken` (Task 5), `forgetOfferedMethods`, `hashToken` (`src/lib/auth/magic-link.ts`), `lockTeacherForNoKeyUpdate` (`src/lib/db-locks.ts`), `deliverPayoutChangedNotice` (`src/services/payout-notice.ts`).
- Produces:

```ts
export const MOLLIE_SCOPES = ['payments.read', 'payments.write', 'refunds.read', 'refunds.write', 'profiles.read', 'organizations.read'] as const;
export const OAUTH_STATE_TTL_MS = 10 * 60_000;
export function mollieRedirectUri(appUrl: string): string; // `${appUrl}/api/processor/mollie/callback`
export function startConnect(db, deps, input: { teacherId: string; sessionId: string; now?: Date }): Promise<{ authorizeUrl: string }>;
export type CompleteConnectOutcome =
  | { kind: 'connected'; teacherId: string; eventId: string | null }
  | { kind: 'choose_profile'; teacherId: string }
  | { kind: 'refused'; refusal: Extract<CodedRefusal, { code: 'OAUTH_STATE_INVALID' }> }
  | { kind: 'unavailable' };
export function completeConnect(db, deps, input: { state: string; code: string; sessionId: string; now?: Date }): Promise<CompleteConnectOutcome>;
export type ChooseProfileOutcome = { kind: 'chosen'; eventId: string } | { kind: 'unchanged' } | { kind: 'not_connected' } | { kind: 'unknown_profile' } | { kind: 'unavailable' };
export function chooseProfile(db, deps, input: { teacherId: string; profileId: string }): Promise<ChooseProfileOutcome>;
export type DisconnectOutcome =
  | { kind: 'disconnected'; eventId: string; connectionId: string; revokeNow: boolean }
  | { kind: 'unchanged' } | { kind: 'teacher_gone' };
export function disconnect(db, input: { teacherId: string; now?: Date }): Promise<DisconnectOutcome>;
export function revokeConnection(db, deps, connectionId: string): FireAndForget;
export function maskOrganizationId(id: string): string; // 'org_…' + last four
export function maskProfileId(id: string): string; // 'pfl_…' + last four
export type LiveIdentity = { organizationId: string; profileId: string };
// `${maskOrganizationId(organizationId)} · ${the profile's name in profiles, else maskProfileId(profileId)}`
export function payoutIdentityLabel(identity: LiveIdentity, profiles: readonly { id: string; name: string }[]): string;
export type ConnectionView =
  | { kind: 'none' }
  | { kind: 'choose_profile'; profiles: { id: string; name: string }[] }
  | { kind: 'connected'; organizationName: string; profileName: string; testmode: boolean; offered: AllowedMollieMethod[]; excluded: string[]; missingScopes: string[] }
  | { kind: 'unavailable' };
export function readConnectionView(db, deps, teacherId: string): Promise<ConnectionView>;
```

Event rule (spec, Data and §1): the payout identity is the live row's `(organizationId, profileId)` pair (live = `disconnectedAt IS NULL AND profileId IS NOT NULL`). An event is written whenever the live identity becomes a new pair, at the moment it becomes live, and never when the row is left without a profile.
- `completeConnect`, one usable profile: compare `(org.id, that profile)` with the row's live identity read before the write. No live identity → `processor_connected`; a different pair → `processor_changed`; the same pair → no event (`eventId: null`, e.g. a re-authorization for new scopes).
- `completeConnect`, several profiles: the organization unchanged and the previous live profile in the new list → that `profileId` is kept, the row stays live, no event (`connected`, `eventId: null`). Otherwise `profileId` null, no event (`choose_profile`).
- `chooseProfile` (the picker, or a switch on a live row): a profile different from the row's current `profileId` writes the event — `processor_connected` when the row had no live identity (`profileId` null), else `processor_changed`.
- `before` is `payoutIdentityLabel(previous identity, fetched profiles)` for `processor_changed` and null for `processor_connected`; `after` is `payoutIdentityLabel(new identity, fetched profiles)`.

- [ ] **Step 1: Write the failing service tests** (unit tier, real DB, fake client)

Cases, each its own `it`:
1. `startConnect` stores one `OAuthState` with `stateHash = hashToken(state)` and `expiresAt = now + 10 min`, and the authorize URL carries `state` and every `MOLLIE_SCOPES` member (space-joined in `scope`). A teacher with no `ProcessorConnection` row (first connect) → `fake.authorizeUrl` called with `forcePrompt: false`.
1a. A teacher with a `ProcessorConnection` row — live, live with missing scopes, or disconnected — → `forcePrompt: true` (a reconnect).
2. `completeConnect` with one profile → `connected`, the row has `organizationId`, `profileId`, sealed tokens, `scopes`, `testmode` from config; one `PayoutChangeEvent` `processor_connected` with `after = 'org_…' + last four + ' · ' + name`; the state row is gone.
3. Same with two profiles and no previous live identity → `choose_profile`, `profileId` null, **no** event; the same with a previous live profile that is not in the new list (or a different organization) → `choose_profile`, `profileId` null, no event, and the row is no longer live.
3a. Reconnect to the same organization with two profiles, the previous live profile among them → `connected`, `eventId: null`, `profileId` still the previous one, the row still live.
4. Unknown state, expired state, and a state bound to another session → `refused` `OAUTH_STATE_INVALID`, no Mollie call (`fake.exchangeCode` not called), and the state row of the other-session case **still exists** (a stranger cannot burn the teacher's state).
5. A state is single-use: a second `completeConnect` with the same state → `refused`.
6. Reconnect to the same organization while live → `connected`, `eventId: null`.
7. Reconnect to a different organization → `processor_changed`, `before` names the old org.
8. Reconnect after a disconnect → `processor_connected`; `disconnectedAt`, `revokeAfter`, `revokedAt` cleared.
9. `exchangeCode` answering `invalid_grant` (expired code) → `refused` `OAUTH_STATE_INVALID`; `MollieUnavailable` → `unavailable`; neither writes a connection.
10. `chooseProfile` with an id from the fetched list on a row whose `profileId` is null → `chosen` with an `eventId`, row has it, one event `processor_connected` with `before: null` and `after = payoutIdentityLabel(…)`; on a live row with another profile → `chosen`, event `processor_changed` whose `before` names the previous profile; an id not in the list → `unknown_profile`, no event; same id again → `unchanged`, no event; a disconnected row → `not_connected`.
11. `disconnect` with no open attempts → `revokeNow: true`, `disconnectedAt` set, `revokeAfter = now`, event `processor_disconnected`; a second call → `unchanged`.
12. `disconnect` with an open attempt expiring at T → `revokeNow: false`, `revokeAfter = T`; tokens still present.
13. `revokeConnection` calls `fake.revoke(refreshPlain)` and then nulls the tokens and stamps `revokedAt`; when `revoke` throws, the row is unchanged (the daily sweep retries, Task 10).
14. Fingerprint: `payoutFingerprint` differs between a teacher with no connection and one with a live connection, between two organizations, and between two profiles of one organization; a row without a profile, and a disconnected row, digest as no connection.

- [ ] **Step 2: Run, see them fail.**

- [ ] **Step 3: Implement the service.** `startConnect`: a reconnect is a `ProcessorConnection` row for the teacher in any state, so `forcePrompt = (await db.processorConnection.findUnique({ where: { teacherId }, select: { id: true } })) !== null`, passed to `deps.client.authorizeUrl` with `mollieRedirectUri(deps.config.appUrl)`, the state and `MOLLIE_SCOPES` (spec §1: a forced prompt re-shows the scopes and replaces the earlier authorization; on a first connect it is an extra screen). Shape of `completeConnect`, the one with the subtle order:

```ts
export async function completeConnect(db: PrismaClient, deps: MollieDeps, input: { state: string; code: string; sessionId: string; now?: Date }): Promise<CompleteConnectOutcome> {
  const now = input.now ?? new Date();
  const refused = { kind: 'refused', refusal: codedRefusal('OAUTH_STATE_INVALID', 'That Mollie sign-in link has expired. Start connecting again from Settings.') } as const;
  // Consume the state only if it belongs to this session: deleteMany with every condition in the WHERE.
  const state = await db.oAuthState.findUnique({ where: { stateHash: hashToken(input.state) }, select: { id: true, teacherId: true, sessionId: true, expiresAt: true } });
  if (!state || state.sessionId !== input.sessionId || state.expiresAt <= now) return refused;
  const consumed = await db.oAuthState.deleteMany({ where: { id: state.id, sessionId: input.sessionId } });
  if (consumed.count !== 1) return refused;

  let grant: TokenGrant; let org: { id: string; name: string }; let profiles: MollieProfile[];
  try {
    const answer = await deps.client.exchangeCode(input.code, mollieRedirectUri(deps.config.appUrl));
    if (answer.kind === 'invalid_grant') return refused;
    grant = answer.grant;
    org = await deps.client.organization(grant.accessToken);
    profiles = usableProfiles(await deps.client.profiles(grant.accessToken), deps.config.testmode);
  } catch (err) {
    if (err instanceof MollieUnavailable) return { kind: 'unavailable' };
    throw err;
  }

  return db.$transaction(async (tx): Promise<CompleteConnectOutcome> => {
    if (!(await lockTeacherForNoKeyUpdate(tx, state.teacherId))) return refused;
    const previous = await tx.processorConnection.findUnique({ where: { teacherId: state.teacherId }, select: { organizationId: true, profileId: true, disconnectedAt: true } });
    const previousLive = liveIdentity(previous);
    const profile = initialProfile(profiles, org.id, previousLive);
    const data = {
      processor: 'mollie' as const, organizationId: org.id, profileId: profile?.id ?? null, scopes: grant.scopes, testmode: deps.config.testmode,
      ...sealGrant(grant, deps.config.tokenKey, now), connectedAt: now, disconnectedAt: null, revokeAfter: null, revokedAt: null,
    };
    const row = await tx.processorConnection.upsert({ where: { teacherId: state.teacherId }, create: { teacherId: state.teacherId, ...data }, update: data, select: { id: true } });
    forgetOfferedMethods(row.id);
    if (profile === null) return { kind: 'choose_profile', teacherId: state.teacherId };
    const next: LiveIdentity = { organizationId: org.id, profileId: profile.id };
    const eventId = sameIdentity(previousLive, next) ? null : await writeIdentityEvent(tx, state.teacherId, previousLive, next, profiles);
    return { kind: 'connected', teacherId: state.teacherId, eventId };
  });
}

/** The row's live payout identity, or null when it has none (no row, disconnected, or no profile). */
function liveIdentity(row: { organizationId: string; profileId: string | null; disconnectedAt: Date | null } | null): LiveIdentity | null {
  return row !== null && row.disconnectedAt === null && row.profileId !== null
    ? { organizationId: row.organizationId, profileId: row.profileId }
    : null;
}

/** Live mode offers live profiles only; test mode offers every profile. */
function usableProfiles(profiles: readonly MollieProfile[], testmode: boolean): MollieProfile[] {
  return profiles.filter((p) => testmode || p.mode === 'live');
}

function sameIdentity(a: LiveIdentity | null, b: LiveIdentity): boolean {
  return a !== null && a.organizationId === b.organizationId && a.profileId === b.profileId;
}

/** The profile a callback lands on: the only one, or the previous live one when the organization is unchanged and still lists it. */
function initialProfile(profiles: readonly MollieProfile[], organizationId: string, previousLive: LiveIdentity | null): MollieProfile | null {
  if (profiles.length === 1) return profiles[0] ?? null;
  if (previousLive === null || previousLive.organizationId !== organizationId) return null;
  return profiles.find((p) => p.id === previousLive.profileId) ?? null;
}

/** Writes the event for a live identity that has just become `next`. */
async function writeIdentityEvent(
  tx: Prisma.TransactionClient,
  teacherId: string,
  previousLive: LiveIdentity | null,
  next: LiveIdentity,
  profiles: readonly MollieProfile[],
): Promise<string> {
  const event = await tx.payoutChangeEvent.create({
    data: {
      teacherId,
      kind: previousLive === null ? 'processor_connected' : 'processor_changed',
      before: previousLive === null ? null : payoutIdentityLabel(previousLive, profiles),
      after: payoutIdentityLabel(next, profiles),
      identifierChanged: previousLive === null ? null : true,
    },
    select: { id: true },
  });
  return event.id;
}
```

`chooseProfile` reuses the last two helpers:

```ts
export async function chooseProfile(db: PrismaClient, deps: MollieDeps, input: { teacherId: string; profileId: string }): Promise<ChooseProfileOutcome> {
  const row = await db.processorConnection.findUnique({ where: { teacherId: input.teacherId }, select: { id: true, disconnectedAt: true } });
  if (row === null || row.disconnectedAt !== null) return { kind: 'not_connected' };
  // The list is fetched outside the transaction: no lock is held across a Mollie call.
  const token = await getAccessToken(db, deps, row.id);
  if (token.kind === 'disconnected') return { kind: 'not_connected' };
  if (token.kind === 'unavailable') return { kind: 'unavailable' };
  let profiles: MollieProfile[];
  try {
    profiles = usableProfiles(await deps.client.profiles(token.accessToken), deps.config.testmode);
  } catch (err) {
    if (err instanceof MollieUnavailable) return { kind: 'unavailable' };
    throw err;
  }
  if (!profiles.some((p) => p.id === input.profileId)) return { kind: 'unknown_profile' };

  return db.$transaction(async (tx): Promise<ChooseProfileOutcome> => {
    if (!(await lockTeacherForNoKeyUpdate(tx, input.teacherId))) return { kind: 'not_connected' };
    const current = await tx.processorConnection.findUnique({ where: { teacherId: input.teacherId }, select: { id: true, organizationId: true, profileId: true, disconnectedAt: true } });
    if (current === null || current.disconnectedAt !== null || current.id !== row.id) return { kind: 'not_connected' };
    if (current.profileId === input.profileId) return { kind: 'unchanged' };
    await tx.processorConnection.update({ where: { id: current.id }, data: { profileId: input.profileId } });
    forgetOfferedMethods(current.id);
    const next: LiveIdentity = { organizationId: current.organizationId, profileId: input.profileId };
    return { kind: 'chosen', eventId: await writeIdentityEvent(tx, input.teacherId, liveIdentity(current), next, profiles) };
  });
}
```

(The `current.id !== row.id` check refuses a choice that raced a disconnect-and-reconnect, whose profile list may differ from the one fetched.)

(The profile filter keeps live-mode profiles in live mode; refine per Task 0. A teacher with zero usable profiles gets `choose_profile` with an empty list; the section says "Create a website profile in Mollie first".)

`disconnect`: in a transaction, `lockTeacherForNoKeyUpdate` first (`teacher_gone` when null); read the connection; none or already disconnected → `unchanged`; `revokeAfter` = max `expiresAt` over its attempts with status in `open | pending | authorized` and `expiresAt > now`, else `now`; update `disconnectedAt = now, revokeAfter`; event `processor_disconnected` with `before = masked org`; answer `revokeNow = revokeAfter <= now`. After commit (in the route): `deliverPayoutChangedNotice`, `forgetOfferedMethods`, and `revokeConnection` when `revokeNow`.

`payoutFingerprint` / `readPayoutDetails`: add `processorIdentity: LiveIdentity | null` — the live connection's `organizationId` and `profileId` (`disconnectedAt IS NULL AND profileId IS NOT NULL`; any other row contributes null, since no money can flow to it) — to the digested array, after the bank accounts, as `[organizationId, profileId]` or `null`. `readPayoutDetails` selects `processorConnection: { select: { organizationId, profileId, disconnectedAt } }` and maps it with the same liveness rule (import `LiveIdentity` as a type; keep the rule in one exported helper rather than two spellings). Update the docblock to name the connection's organization and profile as payout details.

- [ ] **Step 4: Routes.** Follow `src/app/api/teachers/[id]/payment-link/route.ts` (authorise, `withErrorHandler`, exhaustive switch). Each route calls `mollieDeps()` and answers 503 `PROCESSOR_UNAVAILABLE` ("Mollie isn't available right now.") when it is null, except `DELETE` which needs no Mollie call (pass `deps` only to `revokeConnection`, skipped when null).
- `POST …/processor/connect` → `respondOk({ authorizeUrl })`.
- `GET /api/processor/mollie/callback?code&state` — session via `requireTeacher`; no session → redirect to sign-in with a return path back to `/settings/profile`; Mollie's `error` param (teacher pressed cancel) → redirect `/settings/profile?mollie=cancelled`; `connected` → `deliverPayoutChangedNotice` when `eventId` set, redirect `/settings/profile?mollie=connected`; `choose_profile` → no notice (nothing became live), redirect `/settings/profile?mollie=choose`; `refused` → redirect `/settings/profile?mollie=expired`; `unavailable` → `/settings/profile?mollie=unavailable`. A GET that writes is acceptable here only because the state is single-use and bound to the session; say so in the route's docblock.
- `PUT …/processor/profile` `{ profileId }` (`processorProfileSchema`: `z.object({ profileId: z.string().regex(/^pfl_[A-Za-z0-9]+$/) }).strict()`) → `chosen` → `deliverPayoutChangedNotice` with its `eventId`, then 200; `unchanged` `respondUnchanged`, `not_connected` 409 `PROCESSOR_NOT_CONNECTED`, `unknown_profile` 400, `unavailable` 503.
- `DELETE …/processor` → `disconnected` 200, `unchanged` `respondUnchanged`, `teacher_gone` 404.
Each route gets a `route.test.ts` in the payment-link route test's style: services mocked, one test per outcome asserting status, code, and (for `connected`, `chosen` and `disconnected`) that `deliverPayoutChangedNotice` was called with the event id; for `choose_profile`, that it was not called.

- [ ] **Step 5: The settings section.** `MollieConnectionSection` (client component) takes a `ConnectionView` plus `mollieConfigured: boolean`, renders nothing when not configured, and per kind:
  - `none`: one sentence ("Let students pay you by iDEAL, card and more through your own Mollie account. Money goes straight to you; Mollie charges you its fees.") and a **Connect Mollie** button that POSTs `connect` and navigates to `authorizeUrl`.
  - `choose_profile`: a radio list of profiles and **Use this profile** (PUT profile).
  - `connected` with more than one profile in the organization: a **Change profile** control with the same list (PUT profile); one sentence that payments then go to that profile's Mollie balance.
  - `connected`: "Mollie connected — <organization> · <profile>" (+ "Test mode" when `testmode`), the methods students see (labels from `MOLLIE_METHODS`), the excluded ones each with `EXCLUSION_COPY[exclusionReason(id)]`, the Wero chargeback note when `offered` includes `wero` ("Wero payments can be disputed for up to 120 days."), the fees line ("Mollie deducts its fees from each payment; you see the net amount in Mollie."), and **Disconnect**.
  - `connected` with `missingScopes` non-empty (a grant narrower than `MOLLIE_SCOPES`): "Reconnect Mollie to enable payments" and a Reconnect button (the same connect POST); `pay-page-methods` and `createAttempt` treat such a connection as not live, and the section shows no method list.
  - `unavailable`: "Mollie can't be reached right now." and Disconnect.
  - The `?mollie=` query param shows one status line (connected / choose / expired / cancelled / unavailable).
  Design: rows and buttons as the bank-account section on the same page; no new tokens. `readConnectionView` computes `offered/excluded` with `listOfferedMethods` for amount `10.00` in `Teacher.currency`. Component test: each kind renders its text; the Connect button POSTs and assigns `location`.

- [ ] **Step 6: Run everything touched.** `pnpm exec vitest run --project unit src/services/processor-connection.test.ts src/lib/payout-fingerprint.test.ts src/services/payout-resume.test.ts src/app/api/teachers src/app/api/processor` and `pnpm exec vitest run --project components src/components/settings/mollie-connection-section.test.tsx` → PASS.

- [ ] **Step 7: Prove the guards bite.** (a) Remove `state.sessionId !== input.sessionId` *and* the `sessionId` in `deleteMany`'s where; rerun; case 4's other-session test fails — record; restore. (b) Remove the connection from `payoutFingerprint`; case 14 fails — record; restore. Then digest only `organizationId`; case 14's two-profiles assertion fails — record; restore. (c) In the profile filter, keep test profiles in live mode; add a case if none caught it.

- [ ] **Step 8: Commit**

```bash
git add src/services/processor-connection.ts src/services/processor-connection.test.ts "src/app/api/teachers/[id]/processor" src/app/api/processor src/components/settings/mollie-connection-section.tsx src/components/settings/mollie-connection-section.test.tsx "src/app/(teacher)/settings/profile/page.tsx" src/lib/payout-fingerprint.ts src/lib/payout-fingerprint.test.ts src/services/payout-resume.ts src/services/payout-resume.test.ts src/lib/api-error-codes.ts src/lib/schemas.ts
git commit -m "feat: connect and disconnect Mollie by OAuth (#896)"
```

---

## Task 7: Mollie rows on the pay page, and starting an attempt

**Files:**
- Modify: `src/lib/payment-methods.ts` (union member, copy row, `paymentMethodLabel`)
- Create: `src/services/pay-page-methods.ts`, `src/services/pay-page-methods.test.ts`
- Create: `src/services/processor-attempts.ts` (this task: `createAttempt`), `src/services/processor-attempts.test.ts`
- Create: `src/app/api/payments/[id]/processor-attempt/route.ts` and `route.test.ts`
- Create: `src/components/pay/processor-pay-button.tsx` (+ `.test.tsx`)
- Modify: `src/app/(student)/bookings/[classId]/pay/page.tsx` (`MethodPanel` case; load via `payPageMethods`; row labels and keys)
- Modify: every other exhaustive switch over `PaymentMethod['kind']` that `tsc` names
- Modify: `src/lib/api-error-codes.ts` (`PROCESSOR_METHOD_UNAVAILABLE: 409`)
- Test: `tests/integration/pay-page.test.ts` (one new case)

**Interfaces:**
- Consumes: `listOfferedMethods` (Task 4), `getAccessToken` (Task 5), `MOLLIE_METHODS`/`isAllowedMollieMethod` (Task 4).
- Produces:

```ts
// payment-methods.ts
export type PaymentMethod = /* existing members */ | { kind: 'processor'; method: AllowedMollieMethod };
export function paymentMethodLabel(method: PaymentMethod): string;

// pay-page-methods.ts
export const payPageTeacherSelect: /* teacherPaymentSelect + processorConnection: { select: { id, profileId, testmode, disconnectedAt } } */;
export function payPageMethods(db: PrismaClient, deps: MollieDeps | null, teacher: PayPageTeacher, currency: Currency, amount: Prisma.Decimal): Promise<PaymentMethodsAnswer>;

// processor-attempts.ts
export type AttemptRefusal = Extract<CodedRefusal, { code: 'NOT_FOUND' | 'PAYMENT_SETTLED' | 'PAYMENTS_PAUSED' | 'PROCESSOR_NOT_CONNECTED' | 'PROCESSOR_METHOD_UNAVAILABLE' }>;
export type CreateAttemptOutcome = { kind: 'checkout'; attemptId: string; checkoutUrl: string } | { kind: 'refused'; refusal: AttemptRefusal } | { kind: 'unavailable' };
export function createAttempt(db: PrismaClient, deps: MollieDeps | null, input: { paymentId: string; studentId: string; method: string; now?: Date }): Promise<CreateAttemptOutcome>;
export function processorReturnUrl(appUrl: string, paymentId: string, attemptId: string): string; // `${appUrl}/api/payments/${paymentId}/processor-return?attempt=${attemptId}`
export function processorWebhookUrl(appUrl: string): string | null; // null when the host is localhost/127.0.0.1
```

- [ ] **Step 1: Write the failing tests**

`pay-page-methods.test.ts` (unit, real DB, fake client):
1. No connection → exactly `paymentMethodsForTeacher(teacher, currency)`.
2. `deps` null with a live connection → the same.
3. Live connection, Mollie offers `['twint','ideal']` → `{ kind: 'methods', methods: [processor ideal, processor twint, ...the Level 1 methods in their existing order] }`.
4. Mollie unavailable → the Level 1 answer, unchanged.
5. Paused teacher → `{ kind: 'paused' }` and no Mollie call.
6. Disconnected connection (`disconnectedAt` set, tokens still present) → no Mollie call, Level 1 answer.
7. Connection without a profile → no Mollie call.

`processor-attempts.test.ts` (`createAttempt`):
1. Creates a Mollie payment with the **class's** currency and the payment's amount after the teacher switched `Teacher.currency` (Review Focus 2): seed a EUR class, then update the teacher to `GBP`; assert `fake.createPayment` received `amount: { value: '10.00', currency: 'EUR' }`, `method: 'ideal'`, `profileId`, `metadata.paymentId`, a `redirectUrl` from `processorReturnUrl`, and the stored attempt row has `status: 'open'`, `currency: 'EUR'`, `expiresAt`, `checkoutUrl`.
2. Reuses an `open` attempt for the same method, made under the connection's current `profileId` and `testmode`, whose `expiresAt` is more than a minute ahead: no Mollie call, same `attemptId`.
3. Does not reuse an attempt for another method, one expiring within a minute, one made under another profile, or one made in the other mode.
4. Refuses: another student's payment → `NOT_FOUND`; `paid`/`not_charged` → `PAYMENT_SETTLED`; paused → `PAYMENTS_PAUSED`; no live connection → `PROCESSOR_NOT_CONNECTED` (also when `deps` is null — check the connection first so the answer does not depend on config); `klarna` and `ideal`-not-in-overlap → `PROCESSOR_METHOD_UNAVAILABLE`.
5. `createPayment` throwing `MollieUnavailable` → `unavailable`, no row.
6. `processorWebhookUrl('http://localhost:3000')` is null; `processorWebhookUrl('https://fair.yoga')` is `https://fair.yoga/api/webhooks/mollie`.

`tests/integration/pay-page.test.ts`, new case: a teacher **with no connection** renders exactly the rows it rendered before this change (assert the same headings the existing cases assert, and that no element names "iDEAL").

- [ ] **Step 2: Run, see them fail.**

- [ ] **Step 3: Implement.**
- `payment-methods.ts`: add the member; `PAYMENT_METHOD_COPY.processor = { label: 'Pay online', hint: 'Opens your teacher’s payment provider' }`; `paymentMethodLabel(m)` = `m.kind === 'processor' ? MOLLIE_METHODS[m.method].label : PAYMENT_METHOD_COPY[m.kind].label`. `paymentMethodsFor` is unchanged — it never returns `processor`. For each other switch `tsc` names (email copy, reminders), the `processor` case is unreachable from their source; handle it the way that switch handles the closest existing kind (`payment_link`), never with a silent default.
- `pay-page-methods.ts`: as the interface says; live = `disconnectedAt === null && profileId !== null`.
- `createAttempt`: load the payment with `registration.studentId`, `class.currency`, the entry's `classType` and `date`, and the teacher's `paymentsPausedAt` and connection, in one read. Check order: ownership → status → paused → connection → `deps` (null → `unavailable`) → `isAllowedMollieMethod` → reuse → overlap (`listOfferedMethods`, `unavailable` → `unavailable`) → token → `createPayment` with `id = randomUUID()` chosen first so the redirect URL can carry it → insert the attempt with that id, its `profileId` and `testmode` taken from the connection. Description: the pay page's reference, `${entry.classType} ${formatDayHeader(entry.date)}` — move that expression into a shared `paymentReference(entry)` in `src/lib/payment-methods.ts` and use it in both places.
- Route `POST /api/payments/[id]/processor-attempt` `{ method }` (`processorAttemptSchema`: `z.object({ method: z.string().min(1).max(32) }).strict()`): `requireStudent`; `checkout` → `respondOk({ checkoutUrl })`; `refused` → `respondRefusal`; `unavailable` → 503 `PROCESSOR_UNAVAILABLE`.
- `ProcessorPayButton` (client): a full-width button labelled `Pay with ${label}`; on click POST, then `window.location.assign(checkoutUrl)`; a refusal shows its message inline; while pending the button is disabled with "Opening ${label}…". Follow how `MarkSentControl` posts and shows errors.
- Pay page: load the teacher with `payPageTeacherSelect`, call `payPageMethods(prisma, mollieDeps(), teacher, cls.currency, payment.amount)`; `MethodPanel` `case 'processor': return <ProcessorPayButton paymentId={payment.id} method={method.method} label={MOLLIE_METHODS[method.method].label} />;`; chooser labels via `paymentMethodLabel`; React keys `${m.kind}:${m.kind === 'processor' ? m.method : ''}`.

- [ ] **Step 4: Run, see them pass.** Unit and components for the touched files; integration: `pnpm exec vitest run --project integration tests/integration/pay-page.test.ts` (the dev server must be running; warm `/bookings/x/pay` with a curl first).

- [ ] **Step 5: Prove the guards bite.** (a) Use `teacher.currency` instead of `class.currency` in `createAttempt`; Review Focus 2's test fails — record; restore. (b) Skip the overlap check; the `klarna`/not-in-overlap refusals fail — record; restore. (c) Delete the `processor` key from `PAYMENT_METHOD_COPY`; `tsc` fails with the `satisfies` error — record the message; restore.

- [ ] **Step 6: Commit**

```bash
git add src/lib/payment-methods.ts src/services/pay-page-methods.ts src/services/pay-page-methods.test.ts src/services/processor-attempts.ts src/services/processor-attempts.test.ts "src/app/api/payments/[id]/processor-attempt" src/components/pay "src/app/(student)/bookings/[classId]/pay/page.tsx" src/lib/api-error-codes.ts src/lib/schemas.ts tests/integration/pay-page.test.ts
# plus any switch file tsc named
git commit -m "feat: Mollie rows on the pay page and the attempt route (#896)"
```

---

## Task 8: Settling — the webhook, the return route, and "in progress"

**Files:**
- Modify: `src/services/processor-attempts.ts` (add `syncAttempt`, `decideSync`, `decideRefundSync`, `completeRefund`)
- Modify: `src/services/processor-attempts.test.ts`
- Modify: `src/services/payments.ts` (`PaidMethod`, `markPaymentPaid` takes a transaction client, `reopenPayment` → `reopenInTransaction`, which refuses a Mollie-settled payment unless a refund names its attempt; `PaymentRefusal` gains `PAYMENT_SETTLED_BY_PROCESSOR`)
- Modify: `src/lib/api-error-codes.ts` (`PAYMENT_SETTLED_BY_PROCESSOR: 409`)
- Modify: `src/lib/schemas.ts` (`markPaidSchema.method` → `z.literal('manual')`)
- Modify: `tests/integration/payments-api.test.ts` (requests that send `method: 'cash'`/`'bank_transfer'` send `'manual'`; the different-method refusal moves to a unit test with `'mollie'`)
- Create: `src/app/api/webhooks/mollie/route.ts` and `route.test.ts`; delete `src/app/api/webhooks/.gitkeep`
- Create: `src/app/api/payments/[id]/processor-return/route.ts` and `route.test.ts`
- Modify: `src/app/(student)/bookings/[classId]/pay/page.tsx` (the `?attempt=` banner and "processing" state)
- Modify: the teacher outstanding list ordering (`getOutstandingPayments` in `src/services/payments.ts`) so an attempt in `pending`/`authorized` sorts with claimed rows
- Test: `tests/integration/mollie-webhook.test.ts`

**Interfaces:**
- Consumes: `getAccessToken`, `MollieDeps`, `createNotification`.
- Produces:

```ts
export type PaidMethod = 'manual' | 'mollie';
export function markPaymentPaid(db: PrismaClient | Prisma.TransactionClient, paymentId: string, method: PaidMethod): Promise<PaymentOutcome>;
export function reopenInTransaction(tx: Prisma.TransactionClient, paymentId: string, opts?: { refundAttemptId?: string }): Promise<PaymentOutcome>;

export type SyncResult = 'settled' | 'unchanged' | 'paid_twice' | 'charged_back' | 'status_only' | 'unknown';
export function syncAttempt(db: PrismaClient, deps: MollieDeps | null, processorPaymentId: string): Promise<SyncResult | 'unavailable'>;
// pure, for the table test:
export type SyncDecision = { attemptStatus: ProcessorPaymentStatus; settle: boolean; notifyPaidTwice: boolean; recordChargeback: boolean; result: SyncResult };
export function decideSync(input: {
  mollieStatus: ProcessorPaymentStatus; previousStatus: ProcessorPaymentStatus; paymentStatus: PaymentStatus;
  settledByThis: boolean; chargedBack: boolean; alreadyChargedBack: boolean;
}): SyncDecision;
export function inProgress(payment: { studentReportedAt: Date | null; processorAttempts: readonly { status: ProcessorPaymentStatus }[] }): boolean;

// refunds: pure, for the table test
export type RefundSyncDecision =
  | { kind: 'unchanged' }
  | { kind: 'status'; status: ProcessorRefundStatus; complete: boolean; notifyFailed: boolean };
export function decideRefundSync(input: { storedStatus: ProcessorRefundStatus; mollieStatus: ProcessorRefundStatus }): RefundSyncDecision;
// Applies a completed refund's outcome and tells the student. With outcome 'reopened' the caller's
// transaction must not have locked the payment before the TeacherStudent link.
export type CompletionResult = 'applied' | 'missed' | 'no_outcome';
export function completeRefund(tx: Prisma.TransactionClient, input: { paymentId: string; attemptId: string; outcome: RefundOutcome | null; now: Date }): Promise<CompletionResult>;
```

- [ ] **Step 1: Write the failing tests**

`decideSync` table (pure): one `it.each` row per spec §5 row (`chargedBack` and `alreadyChargedBack` false and `recordChargeback: false` unless the row says otherwise) —
- paid, `chargedBack`, not `alreadyChargedBack` / was paid / payment paid / settledByThis → `{ attemptStatus: 'paid', settle: false, notifyPaidTwice: false, recordChargeback: true, result: 'charged_back' }`; the same not settledByThis (a duplicate), and the same with payment `pending` and was open (the first webhook arrives after the chargeback: no settle).
- paid, `chargedBack`, `alreadyChargedBack` → `unchanged`, `recordChargeback: false`.
- paid / was open / payment pending → `{ attemptStatus: 'paid', settle: true, notifyPaidTwice: false, recordChargeback: false, result: 'settled' }`; same with overdue.
- paid / was paid / payment paid / settledByThis → `unchanged`.
- paid / was open / payment paid, not by this → `paid_twice` with `notifyPaidTwice: true`; with payment `not_charged` likewise.
- paid / was paid / payment paid, not by this → `unchanged` (already notified).
- pending, authorized, canceled, expired, failed / any → `status_only`, `settle: false`; when the status equals `previousStatus` → `unchanged`.

`syncAttempt` (unit, real DB, fake client):
1. Unknown Mollie id → `unknown`, no Mollie call.
2. Attempt whose connection is gone (`connectionId` null; Review Focus 4) → `unknown`, no Mollie call.
3. Paid → `settled`: attempt `paid`, `paidAt`, `settledPayment: true`; `Payment` `paid`, `method: 'mollie'`, `paidAt` set.
4. Same webhook again → `unchanged`, nothing written (`updatedAt` unchanged).
5. Payment already `paid` with `manual` → `paid_twice`: attempt `paid`, `settledPayment: false`, payment untouched, one `payment_paid_twice` teacher notification; repeat → `unchanged`, still one notification.
6. `getPayment` null → `unknown`; `MollieUnavailable` → `unavailable`; `deps` null with a known attempt → `unavailable`.
7. Refunds (seed a settled attempt and a fair.yoga `ProcessorRefund` with `processorRefundId: 're_1'`, status `queued`):
   - outcome null (a duplicate's refund), Mollie says `refunded` → row `refunded`, `Payment` untouched, one `payment_refunded` student notification; the same webhook again → nothing more.
   - outcome `waived`, Mollie says `refunded` → `Payment` `not_charged`, `notChargedAt` set, `studentReportedAt` null; attempt `settledPayment: false`; one `payment_refunded`.
   - outcome `reopened`, Mollie says `refunded` → `Payment` `pending`, `method`/`paidAt` null, attempt `settledPayment: false`, one `payment_refunded` (the transaction took the link lock first).
   - Mollie says `processing` → row `processing`, `Payment` still `paid`, attempt still settling, no notification.
   - Mollie says `failed` → row `failed`, `Payment` still `paid`, attempt still settling, one `refund_failed` teacher notification ("A refund didn't go through. Check your Mollie balance and try again from the payment.").
   - CAS miss: outcome `waived`, the payment set to `pending` before the sync, Mollie says `refunded` → row `refunded`, payment left `pending`, one `log.warn`, `payment_refunded` still sent (the money went back).
   - A Mollie refund id with no row, and no fair.yoga refund on the attempt awaiting its id (a dashboard refund) → ignored, no row created, the sync answers its usual result.
   - A Mollie refund id with no row while a fair.yoga refund on the attempt has `processorRefundId` null → `unavailable`, that refund row untouched, no `payment_refunded`.
   - Link-lock race (a): a fair.yoga refund with outcome `reopened` and `processorRefundId` null, the view reporting `re_1` as `refunded`. Pass `syncAttempt` a `db` whose `$transaction` first stores `processorRefundId: 're_1', status: 'queued'` on that row and then delegates to `prisma.$transaction` (what `refundAttempt` storing its id between the pre-read and the lock looks like): the pre-read saw no row for `re_1`, so no link lock was taken; inside, the row is newly complete with `reopened` → `unavailable`, the row still `queued`, `Payment` still `paid`, no `payment_refunded`. The same webhook again, with the plain client → the link lock is taken and the refund completes (`Payment` `pending`).
8. Review Focus 5: settle via the return route's call first, then the webhook's → second is `unchanged`.
9. Chargeback: a settled attempt, Mollie answers `paid` with `amountChargedBack: { value: '4.00', … }` (partial) → `charged_back`: attempt `chargedBackAt` set, `settledPayment: false`; `Payment` still `paid`; one `payment_charged_back` teacher notification whose body ends "You can mark the payment unpaid to ask again."; the same webhook again → `unchanged`, still one notification. A duplicate attempt charged back → `charged_back`, notification without that sentence.

`decideRefundSync` table (pure): stored equals Mollie's → `unchanged`; any stored non-terminal → `refunded` gives `complete: true`; → `failed` gives `notifyFailed: true`; → `queued`/`pending`/`processing`/`canceled` gives neither; a stored `refunded` or `failed` row is never moved again (`unchanged`).

`reopenPayment` (extend its existing test):
- (a) reopening a Mollie-settled payment is refused `PAYMENT_SETTLED_BY_PROCESSOR`; the payment stays `paid` and the attempt keeps `settledPayment`.
- (b) after a chargeback (attempt `chargedBackAt` set, `settledPayment: false`), the reopen succeeds, and a second Mollie attempt can then settle the payment.
- (c) `reopenInTransaction(tx, paymentId, { refundAttemptId })` on a Mollie-settled payment reopens it and clears that attempt's `settledPayment` (the refund's ask-again path).

`markPaymentPaid` unit test: paid with `manual`, then `mollie` → refused `PAYMENT_ALREADY_PAID`.

Webhook `route.test.ts` (services mocked): form body `id=tr_x` → calls `syncAttempt` with `'tr_x'`; answers 200 for every `SyncResult`, 503 for `unavailable`; a body without `id`, or an id not matching `^tr_[A-Za-z0-9]+$` → 200 and no call; a JSON body → 200 and no call.

`processor-return` `route.test.ts`: the student who owns the payment → `syncAttempt` called with the attempt's Mollie id, then 303 to `/bookings/<classId>/pay?attempt=<id>`; another student's attempt → 303 to the pay page without syncing; `unavailable` still redirects.

`tests/integration/mollie-webhook.test.ts`: `POST ${BASE_URL}/api/webhooks/mollie` with `Content-Type: application/x-www-form-urlencoded`, body `id=tr_doesnotexist<suffix>` → 200 (no outbound call: the id is unknown). And with no body → 200.

- [ ] **Step 2: Run, see them fail.**

- [ ] **Step 3: Implement.**
- `markPaymentPaid`: widen `db` to `PrismaClient | Prisma.TransactionClient`, type `method: PaidMethod`; update the docblock's example values to `'manual'`/`'mollie'`. `markPaidSchema`: `method: z.literal('manual')`.
- `reopenPayment`: move its transaction body into exported `reopenInTransaction(tx, paymentId, opts?: { refundAttemptId?: string })` (the link lock stays its first statement, unchanged). After the link lock and a `Payment FOR UPDATE`: `if (await tx.processorPayment.count({ where: { paymentId, settledPayment: true, ...(opts?.refundAttemptId ? { id: { not: opts.refundAttemptId } } : {}) } }) > 0)` answer `{ kind: 'refused', refusal: codedRefusal('PAYMENT_SETTLED_BY_PROCESSOR', 'Mollie confirmed this payment. Refund it instead.') }` (Decision 17). When `refundAttemptId` is given, after the CAS succeeds: `await tx.processorPayment.updateMany({ where: { id: opts.refundAttemptId, paymentId }, data: { settledPayment: false } })`. Add `'PAYMENT_SETTLED_BY_PROCESSOR'` to `PaymentRefusal`'s codes and register it in `api-error-codes.ts`. `reopenPayment` becomes `db.$transaction((tx) => reopenInTransaction(tx, paymentId))` plus its existing refusal handling; its route already answers a refusal with `respondRefusal`, so the 409 needs no route change.
- `syncAttempt`: find the attempt by `processorPaymentId` (select id, paymentId, connectionId, status, `connection.testmode`, `payment.registration.studentId`, `payment.registration.class.calendarEntry.teacherId`); unknown or `connectionId` null → `unknown`; `deps` null → `unavailable`; token (`disconnected` → `log.warn` and `unknown`; `unavailable` → `unavailable`); `getPayment` (null → `unknown`; `MollieUnavailable` → `logDegraded('MOLLIE_UNAVAILABLE', …)` and `unavailable`); map Mollie's status string with a `z.enum` of `ProcessorPaymentStatus` (an unparseable status → `log.warn`, `unknown`). Before opening the transaction, decide the link lock from the fetched view: read the attempt's fair.yoga refund rows (`processorRefundId`, `status`, `outcome`) and set `takesLinkLock` = some refund in the view is newly `refunded` (`decideRefundSync` answers `complete`) and its row has `outcome: 'reopened'` (spec *Locks*). Then one transaction: when `takesLinkLock`, first `lockTeacherStudentLink(tx, { teacherId, studentId })` (the statement `reopenInTransaction` itself starts with, so its own re-lock of the held row is a no-op); then `SELECT … FROM "Payment" WHERE id = … FOR UPDATE` via `$queryRaw`, re-read the attempt and the payment status inside it, `decideSync`, with `chargedBack = view.amountChargedBack !== null && new Prisma.Decimal(view.amountChargedBack.value).greaterThan(0)` and `alreadyChargedBack = attempt.chargedBackAt !== null` (re-read inside the transaction with `settledPayment`), then write: attempt `status`, `method` (Mollie's if present), `paidAt`; if `recordChargeback`, attempt `chargedBackAt: now, settledPayment: false` and `createNotification(tx, { recipientType: 'teacher', recipientId: teacherId, type: 'payment_charged_back', title: 'Payment disputed', body: '<student first name> disputed <view.amountChargedBack, in the attempt’s currency> with their bank and it was taken back.' + (settledByThis ? ' You can mark the payment unpaid to ask again.' : ''), relatedClassId })`; if `settle`, `markPaymentPaid(tx, paymentId, 'mollie')` and — only when it answers `applied` — `settledPayment: true` (an answer other than `applied` downgrades the result to `paid_twice` and notifies); if `notifyPaidTwice`, `createNotification(tx, { recipientType: 'teacher', recipientId: teacherId, type: 'payment_paid_twice', title: 'Paid twice', body: '<student first name> also paid <amount> by <method label>. You can refund it from the payment.', relatedClassId })`. Refunds, in the same transaction, for each `view.refunds`:
  - **No fair.yoga row:** when one of this attempt's `ProcessorRefund` rows still has `processorRefundId` null (`refundAttempt` is between Mollie's answer and storing it), mark the sync `deferred`; otherwise it is a refund made in Mollie's dashboard — ignore it.
  - **A row:** re-read it and `decideRefundSync`. When the decision is `complete`, the outcome is `reopened` and the sync did not take the link lock (the row changed between the fetch and the lock), write nothing for this refund and mark the sync `deferred` — never take the link lock after the payment. Otherwise, on `status`, `updateMany({ where: { id, status: storedStatus }, data: { status } })` (a count of 0 means another sync moved it: skip); when `complete`, `completeRefund(tx, { paymentId, attemptId, outcome, now })`; when `notifyFailed`, a `refund_failed` notification ("A refund didn't go through. Check your Mollie balance and try again from the payment."). A failed refund changes no `Payment`.
  - The transaction commits the attempt's own writes and every refund it could apply; a `deferred` sync then answers `'unavailable'`, so the webhook answers 503 and Mollie retries (the return route still redirects). A retry finds those writes `unchanged`.
- `completeRefund`: `reopened` → `reopenInTransaction(tx, paymentId, { refundAttemptId: attemptId })` first, `applied` when it answers `applied`; `waived` → `tx.payment.updateMany({ where: { id: paymentId, status: 'paid' }, data: { status: 'not_charged', notChargedAt: now, studentReportedAt: null } })` and, when it wrote a row, `tx.processorPayment.updateMany({ where: { id: attemptId, paymentId }, data: { settledPayment: false } })`; null → `no_outcome`. A CAS miss → `log.warn({ paymentId, attemptId, outcome }, …)` and `missed`. Then, whatever the result, the `payment_refunded` student notification ("<teacher first name> refunded <amount>. It goes back the way you paid.").
- Webhook route: `export const POST = withErrorHandler(async (request) => { … })`. Read the body with `request.text()` and `new URLSearchParams(text).get('id')` (avoids a throwing `formData()` on a wrong content type). Answer `new NextResponse(null, { status })`. Its docblock states why it is unauthenticated and unthrottled (spec §5) in one paragraph.
- Return route `GET /api/payments/[id]/processor-return?attempt=…`: `requireStudent`; look up the attempt where `id = attempt AND paymentId = id AND payment.registration.studentId = session.studentId`; if found, `await syncAttempt(…)`; always `NextResponse.redirect(new URL(`/bookings/${classId}/pay?attempt=${attemptId}`, request.url), 303)` (class id from the payment; when the payment is not the student's, redirect to `/bookings`).
- Pay page: read `searchParams.attempt`; when it names an attempt of this payment, show above the rows: status `paid` → "Paid — thank you." (and the page's own paid state already applies); `pending`/`authorized` → "Processing — we'll let you know."; `canceled`/`expired`/`failed` → "That payment didn't go through. You can try again below."; `open` → nothing. Independently, when `inProgress(payment)` and no claim is standing, show the same "processing" state the #898 claim shows.
- `getOutstandingPayments`: include `processorAttempts: { select: { status: true } }` and sort `inProgress` rows with claimed ones.

- [ ] **Step 4: Run, see them pass.** Unit for the touched files; `pnpm exec vitest run --project integration tests/integration/mollie-webhook.test.ts tests/integration/payments-api.test.ts` (curl `/api/webhooks/mollie` once first to warm it).

- [ ] **Step 5: Prove the guards bite.** (a) Remove the `PAYMENT_SETTLED_BY_PROCESSOR` refusal from `reopenInTransaction`; reopen test (a) fails — record; restore. (b) Remove the `settledPayment: false` from the chargeback write; `syncAttempt` case 9's `settledPayment: false` assertion fails — record; restore. (c) Make `completeRefund` run for a refund Mollie reports `processing`; case 7's `processing` assertion (payment still `paid`) fails — record; restore. (d) Treat a Mollie refund id with no row as a dashboard refund even while a fair.yoga refund awaits its id; case 7's awaiting-id assertion (`unavailable`) fails — record; restore. (e) Make the webhook trust a `status` field in the body instead of fetching; add the test "a body claiming paid does not settle" if not already present, see it fail, restore. (f) Remove the `FOR UPDATE`; no test is expected to catch a race deterministically — say so in the PR body rather than claiming coverage.

- [ ] **Step 6: Commit**

```bash
git add src/services/processor-attempts.ts src/services/processor-attempts.test.ts src/services/payments.ts src/services/payments.test.ts src/lib/schemas.ts tests/integration/payments-api.test.ts src/app/api/webhooks "src/app/api/payments/[id]/processor-return" "src/app/(student)/bookings/[classId]/pay/page.tsx" tests/integration/mollie-webhook.test.ts
git rm src/app/api/webhooks/.gitkeep
git commit -m "feat: settle Mollie payments by webhook and on return (#896)"
```

(Use the actual test file names for `payments.ts`'s tests if they differ.)

---

## Task 9: Refunds

**Files:**
- Create: `src/services/processor-refunds.ts`, `src/services/processor-refunds.test.ts`
- Create: `src/app/api/payments/[id]/refund/route.ts` and `route.test.ts`
- Create: `src/components/payments/refund-dialog.tsx` (+ `.test.tsx`)
- Modify: the teacher payment row component(s) — find them with `grep -rln "usePaymentActions\|use-payment-actions" src/components src/app`; the received row renders `MarkUnpaidButton` (`src/components/class/mark-unpaid-button.tsx`) — to show **Refund** on a row with a `paid` attempt that has no live refund and no `chargedBackAt`, and the refund's status otherwise ("Refund pending" while `queued`, `pending` or `processing`; "Refunded"; "Refund failed", with Refund offered again); and to hide "Mark unpaid" while an attempt with `settledPayment` exists (Decision 17), Refund standing in its place. Component test in the row's existing test file: a Mollie-settled row shows Refund and no "Mark unpaid"; a row whose settling attempt was charged back shows "Mark unpaid" and no Refund; a manually paid row is unchanged.
- Modify: `TeacherPaymentRow` (`src/services/payments.ts`) and its loaders to carry `processorAttempts: { id, method, status, settledPayment, chargedBackAt, amount, refunds: { status }[] }[]`
- Modify: `src/lib/api-error-codes.ts` (`REFUND_NOT_ALLOWED: 409`, `REFUND_ALREADY_REQUESTED: 409`, `REFUND_REFUSED: 409`)
- Modify: `src/lib/schemas.ts` (`refundSchema`)

**Interfaces:**
- Consumes: `getAccessToken`, `completeRefund` (Task 8), `createNotification`, `loadOwnedPayment` (`src/app/api/payments/[id]/shared.ts`).
- Produces:

```ts
export type RefundChoice = 'waive' | 'ask_again';
export type RefundRefusal = Extract<CodedRefusal, { code: 'NOT_FOUND' | 'REFUND_NOT_ALLOWED' | 'REFUND_ALREADY_REQUESTED' | 'REFUND_REFUSED' | 'PROCESSOR_NOT_CONNECTED' }>;
export type RefundResult =
  // `outcomeApplied`: the refund completed in this call (Mollie answered `refunded`) and its outcome applied.
  | { kind: 'requested'; refundStatus: ProcessorRefundStatus; outcomeApplied: boolean }
  | { kind: 'invalid'; message: string }
  | { kind: 'refused'; refusal: RefundRefusal }
  | { kind: 'unavailable' };
export function refundAttempt(db: PrismaClient, deps: MollieDeps | null, input: { paymentId: string; attemptId: string; choice: RefundChoice | null; now?: Date }): Promise<RefundResult>;
```

- [ ] **Step 1: Write the failing tests** (unit, real DB, fake client)
1. Settling attempt, `waive`, Mollie answers `queued` → `createRefund` called with the attempt's amount and currency; refund row `outcome: 'waived'`, `processorRefundId` stored, status `queued`; `Payment` still `paid`, attempt still `settledPayment: true`; no `payment_refunded`; result `requested` with `outcomeApplied: false`. Then `syncAttempt` with the refund `refunded` → `Payment` `not_charged`, `notChargedAt` set, `studentReportedAt` null, `settledPayment: false`, one `payment_refunded`.
2. Settling attempt, `ask_again`, Mollie answers `queued` → `Payment` still `paid`, `outcome: 'reopened'`; then `syncAttempt` with the refund `refunded` → `Payment` `pending`, `method`/`paidAt` null (reopen's columns), `settledPayment: false` — through `reopenInTransaction`'s `refundAttemptId`, so `PAYMENT_SETTLED_BY_PROCESSOR` does not refuse it.
2a. Settling attempt, `waive`, Mollie's create answer already `refunded` → applied in the call: `Payment` `not_charged`, `settledPayment: false`, one `payment_refunded`, `outcomeApplied: true`; a later `syncAttempt` with the refund `refunded` → nothing more (still one notification). The same with `ask_again` → `Payment` `pending`.
3. Duplicate attempt (`settledPayment: false`), `choice: null` → refund created, `Payment` untouched, `outcome: null`.
4. `choice` required: settling attempt with `null` → `invalid`; duplicate with `waive` → `invalid`; no Mollie call either way.
5. `REFUND_NOT_ALLOWED`: attempt `open`/`failed`; an attempt with `chargedBackAt` set (no Mollie call); attempt of another payment → `NOT_FOUND`.
6. `REFUND_ALREADY_REQUESTED`: two concurrent calls → exactly one `createRefund` call; the other refused (the partial unique index turns the second insert into P2002 — catch `Prisma.PrismaClientKnownRequestError` with code `P2002` only).
7. Mollie refuses (`{ kind: 'refused', detail: 'Insufficient balance' }`) → `REFUND_REFUSED` with a message naming the balance, the queued row deleted, `Payment` untouched; `MollieUnavailable` → `unavailable`, row deleted.
8. A refund that fails: `ask_again` accepted as `queued`, then `syncAttempt` with the refund `failed` → `Payment` still `paid`, attempt still settling, one `refund_failed`; a second `refundAttempt` on the same attempt is accepted (the live-refund index excludes `failed`) and still requires a choice. (The completion's CAS miss is Task 8's `syncAttempt` case 7.)
9. Guard: `markPaymentNotCharged` on a `paid` payment is still refused `PAYMENT_ALREADY_PAID` (Decision 9's narrowing — a refund's completion is the only writer of `paid → not_charged`).

Route test: teacher ownership via `loadOwnedPayment` (another teacher → 403/404 as that helper answers), each `RefundResult` mapped (`requested` 200 with the row, `invalid` 400, `refused` `respondRefusal`, `unavailable` 503 `PROCESSOR_UNAVAILABLE`); body `refundSchema` = `z.object({ attemptId: z.string().uuid(), choice: z.enum(['waive', 'ask_again']).nullable() }).strict()`.

Dialog component test: for a settling attempt it offers **Refund and waive** and **Refund and ask again** with the amount ("€10.00 goes back to <student> from your Mollie balance."); for a duplicate it offers **Refund duplicate payment**; it POSTs the chosen body and shows a refusal's message.

- [ ] **Step 2: Run, see them fail.**

- [ ] **Step 3: Implement `refundAttempt`** in the spec §6 order:

```ts
export async function refundAttempt(db: PrismaClient, deps: MollieDeps | null, input: { paymentId: string; attemptId: string; choice: RefundChoice | null; now?: Date }): Promise<RefundResult> {
  const now = input.now ?? new Date();
  // 1. Record the intent under the payment's row lock; the partial unique index stops a second one.
  const intent = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Payment" WHERE id = ${input.paymentId} FOR UPDATE`;
    const attempt = await tx.processorPayment.findFirst({
      where: { id: input.attemptId, paymentId: input.paymentId },
      select: { id: true, status: true, settledPayment: true, chargedBackAt: true, amount: true, currency: true, processorPaymentId: true, connectionId: true, connection: { select: { testmode: true } }, payment: { select: { status: true } } },
    });
    if (!attempt) return { kind: 'refused', refusal: codedRefusal('NOT_FOUND', 'This payment no longer exists.') } as const;
    if (attempt.status !== 'paid') return { kind: 'refused', refusal: codedRefusal('REFUND_NOT_ALLOWED', 'Only a completed Mollie payment can be refunded.') } as const;
    if (attempt.chargedBackAt !== null) return { kind: 'refused', refusal: codedRefusal('REFUND_NOT_ALLOWED', 'The student’s bank already took this payment back.') } as const;
    if (attempt.connectionId === null) return { kind: 'refused', refusal: codedRefusal('PROCESSOR_NOT_CONNECTED', 'Mollie is no longer connected.') } as const;
    const settles = attempt.settledPayment && attempt.payment.status === 'paid';
    if (settles !== (input.choice !== null)) {
      return { kind: 'invalid', message: settles ? 'Choose whether to waive the payment or ask again.' : 'This payment was a duplicate; there is nothing to waive.' } as const;
    }
    try {
      const refund = await tx.processorRefund.create({
        data: { attemptId: attempt.id, amount: attempt.amount, status: 'queued', outcome: input.choice === null ? null : input.choice === 'waive' ? 'waived' : 'reopened' },
        select: { id: true },
      });
      return { kind: 'recorded', refundId: refund.id, attempt } as const;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return { kind: 'refused', refusal: codedRefusal('REFUND_ALREADY_REQUESTED', 'A refund for this payment is already on its way.') } as const;
      }
      throw err;
    }
  });
  if (intent.kind !== 'recorded') return intent;
  // 2. The money: outside any transaction.
  // 3. Mollie's answer decides whether the intent stays; the outcome applies only once the refund is `refunded`.
  …
}
```

Steps 2–3 as the spec says: `deps` null or token not `token` → delete the row, `unavailable`. `createRefund` → `refused`: delete the row, `REFUND_REFUSED` with `detail` mapped to copy (a detail mentioning balance → "Your Mollie balance is too low for this refund. Top it up in Mollie, then try again."; else "Mollie didn't accept this refund: <detail>"). `MollieUnavailable`: delete the row, `unavailable`. `created`: one transaction — when Mollie's status is `refunded`, `completeRefund(tx, { paymentId, attemptId: attempt.id, outcome, now })` **first** (for `reopened` it takes the link lock first, the order `reopenPayment` uses); then update the refund row with `processorRefundId` and the mapped status. Any other status writes only the refund row: the payment stays `paid`, its attempt still settling, and Task 8's `syncAttempt` completes the refund when Mollie reports it `refunded`. Answer `requested` with `outcomeApplied` = `completeRefund` answered `applied`.

Update `markPaymentNotCharged`'s docblock sentence "a paid one is refused, because waiving it would be a refund" to state what is true now: a paid one is refused here; waiving after a real refund is `completeRefund`'s, in the transaction that records the refund as `refunded`.

- [ ] **Step 4: UI.** Rows and dialog as *Files* says. The dialog is a sheet (the one place shadows are allowed); copy states the amount and that the money comes from the teacher's Mollie balance; after success the row shows "Refund pending" until the refund completes, then "Refunded" and, for `waive`, "Not charged".

- [ ] **Step 5: Run, see them pass.**

- [ ] **Step 6: Prove the guards bite.** (a) Drop the partial unique index in the test DB; case 6 fails with two `createRefund` calls — record; recreate. (b) Make `markPaymentNotCharged` accept `paid`; case 9 fails — record; restore. (c) Move the `createRefund` call inside the first transaction; no test fails (a lock held across a network call is invisible to these tests) — state that in the PR body; restore.

- [ ] **Step 7: Commit**

```bash
git add src/services/processor-refunds.ts src/services/processor-refunds.test.ts "src/app/api/payments/[id]/refund" src/components/payments/refund-dialog.tsx src/components/payments/refund-dialog.test.tsx src/services/payments.ts src/lib/api-error-codes.ts src/lib/schemas.ts
# plus the payment row component files changed
git commit -m "feat: refund Mollie payments in full, with the teacher's choice of outcome (#896)"
```

---

## Task 10: Erasure, export, and the revocation sweep

**Files:**
- Modify: `src/services/gdpr.ts` (teacher erasure; student and teacher export)
- Modify: `src/services/auth-cleanup.ts` (expired `OAuthState` rows)
- Create: `src/services/processor-revocation.ts`, `src/services/processor-revocation.test.ts`
- Modify: `src/lib/scheduler.ts` and `src/app/api/cron/daily-cleanup/route.ts` (register the sweep), `src/lib/scheduler.test.ts`
- Modify: the GDPR tests that pin erasure and export shapes (find with `grep -rln "processorAccountId\|exportStudentData\|exportTeacherData" src tests`)

**Interfaces:**
- Consumes: `revokeConnection` (Task 6), `mollieDeps`.
- Produces: `revokeDueConnections(db: PrismaClient, now?: Date, deps?: MollieDeps | null): Promise<{ revoked: number; failed: number; skipped: number }>`.

- [ ] **Step 1: Write the failing tests**
1. `revokeDueConnections`: a disconnected row with `revokeAfter <= now` → `fake.revoke` called with its refresh token, row nulled and `revokedAt = now`; `revokeAfter > now` → untouched; already revoked → untouched; `revoke` throwing → `failed: 1`, row untouched; `deps` null → `skipped` equals the due count, nothing written. A Mollie answer meaning "already revoked" (per Task 0) counts as revoked.
2. `cleanupExpiredAuth` deletes `OAuthState` rows past `expiresAt` and keeps live ones; its return gains `oauthStates`.
3. Teacher erasure: the connection row is deleted in the erasure transaction; attempts and refunds remain with their payments, `connectionId` null; after commit the refresh token is revoked fire-and-forget (assert `fake.revoke` called via `vi.waitFor`, with the module mocked as `payout-notice-delivery.test.ts` mocks email).
4. Student export: each payment lists `processorAttempts` (`method`, `status`, `amount`, `currency`, `paidAt`) and their `refunds` (`amount`, `status`, `requestedAt`); no Mollie ids.
5. Teacher export: `processorConnection` (`processor`, `organizationId`, `profileId`, `testmode`, `connectedAt`, `disconnectedAt`) and never a token field — assert the exported object has no key matching `/token/i`.

- [ ] **Step 2: Run, see them fail.**

- [ ] **Step 3: Implement.** `revokeDueConnections` reads due rows (`disconnectedAt not null, revokedAt null, revokeAfter <= now`), and for each, sequentially: open the refresh token (unreadable → `failed`, `PROCESSOR_TOKEN_UNREADABLE`), `await deps.client.revoke(…)`, then `updateMany({ where: { id, revokedAt: null }, data: { accessToken: null, refreshToken: null, accessTokenExpiresAt: null, revokedAt: now } })`. Its signature puts `now` second so it fits `isolatedSweeps`' `(db, now)` shape; `deps` defaults to `mollieDeps()`. Register it in the `daily-cleanup` job list and the cron route as the other sweeps are. In erasure: read and open the refresh token before deleting the row, delete it in the transaction, and after commit call a `FireAndForget` that revokes (skipped when `deps` is null).

- [ ] **Step 4: Run, see them pass.** Including `src/lib/scheduler.test.ts` and the daily-cleanup route test.

- [ ] **Step 5: Prove the guard bites.** Export the full connection row instead of the selected fields; test 5 fails on the token key — record; restore.

- [ ] **Step 6: Commit**

```bash
git add src/services/gdpr.ts src/services/auth-cleanup.ts src/services/processor-revocation.ts src/services/processor-revocation.test.ts src/lib/scheduler.ts src/lib/scheduler.test.ts src/app/api/cron/daily-cleanup/route.ts
# plus the GDPR test files changed
git commit -m "feat: revoke Mollie access on disconnect and erasure; export attempts and refunds (#896)"
```

---

## Task 11: Docs

**Files:**
- Modify: `docs/product-concept.md` (§7 Level 2: `:243`, and `:244` against `:256`)
- Modify: `docs/technical-architecture.md` (stack row `:13`; *Unauthenticated API routes* table and its counts, re-derived with the section's own command; the token cipher under *The Services Layer*; the env block; the Level 2 retry note)
- Modify: `docs/data-model.md` (the four tables; the dropped columns at `:172-176` and `:962`; the Payment section's `processor_ref` mention at `:973`; the narrowed #47 rule; Decision 17's reopen rule and its chargeback exception)
- Modify: `docs/lock-order.md` (connection writers under the teacher lock; payment-then-attempt; completing a `reopened` refund takes reopen's order, so that sync starts with the link lock)
- Modify: `CLAUDE.md` (*Payment Model*: Level 2's line describes the allowlist and refunds; the grace-policy sentence "never a refund (`paid → not_charged` is refused)" states the refund exception; a Mollie-settled payment leaves `paid` only by refund until a chargeback, Decision 17)

- [ ] **Step 1:** Write each edit. Product concept §7: replace "iDEAL, credit card, and other payment methods supported by the processor" with the allowlist rule and its reasoning (the spec's Decision 1 and the issue's four bullets, condensed); replace "Automatic charging after class" with a sentence that v1 has no automatic charging and that recurring payments are a later concept decision (consent, notice, SEPA refund right), which makes `:256` consistent. Technical architecture's stack row: "Level 2 uses the Mollie Payments API with one method per payment — no card-on-file, no subscriptions."
- [ ] **Step 2:** Re-derive the unauthenticated-routes counts with the doc's own loop and write the numbers it prints, with the arithmetic (`N routes, M unguarded, K rate-limited`), adding rows for `webhooks/mollie` (why it is correct: unknown id costs one indexed read; a known id's status is only ever believed from an authenticated fetch) and `processor/mollie/callback` (session-bound single-use state).
- [ ] **Step 3: Sweep for what this branch invalidated.** `grep -rn "paymentLevel\|payment_level\|processorAccountId\|processor_account_id\|processorRef\|processor_ref\|MOLLIE_API_KEY\|PaymentLevel" docs src tests CLAUDE.md --exclude-dir=generated` — give every hit a verdict (fixed, or a legitimate survivor such as a spec quoting the old state). Then read, whole, the docblocks of every function this branch changed in `src/services/payments.ts` and `src/lib/payment-methods.ts`, since a grep finds stale names, not stale descriptions.
- [ ] **Step 4: Commit**

```bash
git add docs/product-concept.md docs/technical-architecture.md docs/data-model.md docs/lock-order.md CLAUDE.md
git commit -m "docs: Mollie Connect, the allowlist and refunds across the reference docs (#896)"
```

---

## After the tasks

- [ ] Whole-branch review on the most capable model (cross-task: does every `NotificationType` added in Task 1 have a writer by Task 9; does the fingerprint from Task 6 see Task 10's erasure; does any consumer of `PaymentMethod` still assume Level 1 kinds only), one fix wave, one scoped re-review.
- [ ] `pnpm run verify` green, and `pnpm run build` (a client import of `server-only` modules — the cipher, the client — only fails there).
- [ ] Manual, in Mollie test mode, before merge: connect, see the rows, pay with iDEAL (test), see it settle via return (localhost, no webhook), refund it with each choice. Record what was done in the PR body.
