# Teacher Profile Photo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A teacher uploads a profile photo on `/settings/profile`; it is stored downscaled in Postgres, served by an immutable per-upload URL, shown as a round avatar on the public teacher page and the Schedule header (initials when absent), deleted by erasure and carried by the data export.

**Architecture:** Bytes live in a 1:1 `TeacherPhoto` table (never on `Teacher`, whose rows many queries load whole). `src/services/teacher-photo.ts` owns processing (sharp → 400×400 WebP, metadata stripped) and persistence (an upsert gated by a `Teacher FOR SHARE` lock so an upload cannot outlive a concurrent erasure). Thin routes wrap it: `POST/DELETE /api/teachers/[id]/photo`, public `GET /api/teacher-photos/[photoId]`. One server-safe `<Avatar>` renders both placements.

**Tech Stack:** Next.js 16 App Router route handlers, Prisma 6 / PostgreSQL, sharp 0.35.4, vitest (unit / unit-sweeps / integration / components tiers), Playwright.

**Spec:** `docs/superpowers/specs/2026-09-29-teacher-profile-photo-design.md` — read it before any task. Where this plan and the spec differ, the plan's "Deviations from the spec" section says why.

## Global Constraints

- TypeScript `strict`; no `any`; no `as` casts to widen a type past a guard.
- Services (`src/services/`) import no `next/*` and no HTTP concepts.
- `src/lib/teacher-photo-limits.ts` imports **nothing** at runtime — client code value-imports it.
- `@/lib/log` is server-only; never let it reach a `'use client'` module's import chain.
- Stored bytes: always WebP, 400×400, quality 80. Accepted input formats: `jpeg`, `png`, `webp` (sharp's detected format — never the client's MIME type or filename).
- App limit: 8 MB per file (`MAX_PHOTO_BYTES = 8 * 1024 * 1024`); request limit `MAX_PHOTO_BYTES + 64 * 1024`; nginx `client_max_body_size 10m` on the photo route only.
- Input pixel ceiling: `MAX_INPUT_PIXELS = 50_000_000`.
- Rate limit: 10 uploads per 15 minutes per teacher, prefix `'teacher-photo'`.
- Photo URL: `/api/teacher-photos/<photoId>`; response headers `Content-Type: image/webp`, `Cache-Control: public, max-age=31536000, immutable`.
- An upload racing erasure answers **404 "Teacher not found"** — no new error code.
- Avatar: circle (`rounded-pill`); sizes exactly `40 | 72`; initials fallback teal Georgia bold on `bg-teal-tint`; no ring, border, shadow or hover step.
- Comment discipline (CLAUDE.md): comments annotate their own code; no counts or member rosters in prose; no correction history.
- Test teardown: never `deleteMany({ where: { id: x } })` with a `beforeAll`-assigned variable — collect ids into an array right after each create, delete with `{ in: ids }`, skip when empty.
- Stage exact paths; quote paths containing `(teacher)` / `(public)`.
- Never write "does not close #N" (or any close/fixes/resolves keyword before `#N`) anywhere.
- Every commit message ends with the trailer `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>` (the commit commands below show the subject line only).
- A mutation proof ends with the mutation reverted and `git status` showing only the task's intended changes; commit the task's work before mutating a file that also holds uncommitted work.

## Deviations from the spec

1. **`onDelete: Cascade` on `TeacherPhoto.teacher`.** The spec left the relation's delete rule unstated. Erasure anonymises rather than deletes, so production never hard-deletes a teacher; tests do (`teardownTeacher`, many `afterAll`s), and without a cascade each would fail on the FK once a photo exists. Task 1 updates the spec to match.
2. **Size checks: request header then file size.** The spec's "`Content-Length` above 8 MB" is refined to `MAX_PHOTO_BYTES + 64 KB` for the header (multipart framing adds bytes around the file), then `file.size > MAX_PHOTO_BYTES` after parsing.
3. **No "oversize by body" integration test.** `fetch` computes `Content-Length` itself and will not send a false one, so the post-parse `file.size` branch is not reachable over HTTP from a test; it stays as defence. Task 1 updates the spec's testing list.
4. **A named `lockLiveTeacher` helper** in `src/lib/db-locks.ts` (the spec described the raw `SELECT … FOR SHARE`). Same SQL; the helper follows `lockLiveStudent`'s shape and gets a line in `db-locks.ts`'s header register, and is what the race test spies on.

## Review Focus

1. **A teacher whose name starts with an astral character** (emoji, CJK Extension B) — expect a whole first character in the initials, never half a surrogate pair. Pinned in Task 5 (`initialsOf` test).
2. **A decompression bomb** — a tiny PNG whose header claims 10 000 × 10 000 px — expect a 400 refusal before any decode allocates. Pinned in Task 2 (hand-built PNG header test).
3. **A phone photo taken sideways** (EXIF orientation 6) — expect the stored avatar upright. Pinned in Task 2 (orientation test).
4. **The same teacher uploading twice at once** (double-tap) — expect one photo row, no 500 from a unique violation. Pinned in Task 3 (concurrent `saveTeacherPhoto` test).
5. **A multipart request with no `photo` field, or a JSON body** — expect 400 "Choose a photo to upload.", not a 500 from `formData()` throwing. Pinned in Task 4.

## Task order is load-bearing

1 → 2 → 3 → 4 → 5. Task 1 creates the table every later task writes; Task 2's `processTeacherPhoto` and Task 3's persistence are what Task 4's routes wrap; Task 5 renders what Task 4 serves.

## File map

| File | Responsibility | Task |
|---|---|---|
| `prisma/schema.prisma` | `TeacherPhoto` model; `Teacher.photo` relation; drop `Teacher.photoUrl` | 1 |
| `prisma/migrations/20260929120000_teacher_photo/migration.sql` | create table, FK, unique; drop column | 1 |
| `src/lib/schemas.ts`, `src/lib/schemas.test.ts` | `photoUrl` leaves the update schema and the server-owned register | 1 |
| `src/services/gdpr.ts` | drop `photoUrl: null` (T1); delete photo after anonymising; export photo (T3) | 1, 3 |
| `src/components/settings/profile-form.tsx` (+ test, + `settings/profile/page.tsx`) | field pins against `updateTeacherSchema` | 1 |
| `docs/data-model.md` | `TeacherPhoto` entry | 1 |
| `package.json`, `pnpm-lock.yaml` | `sharp` as a direct dependency | 2 |
| `src/lib/teacher-photo-limits.ts` | client-safe constants, refusal copy, photo path | 2 |
| `src/services/teacher-photo.ts` (+ `.test.ts`) | processing (T2); save / remove / read (T3) | 2, 3 |
| `src/lib/db-locks.ts` | `lockLiveTeacher` | 3 |
| `src/services/teacher-photo-lock-order.test.ts`, `vitest.tiers.ts` | the two erasure-race orderings | 3 |
| `docs/lock-order.md` | "The `Teacher` row is the photo upload's gate (#46)" | 3 |
| `src/lib/rate-limit.ts` | `'teacher-photo'` prefix | 4 |
| `src/app/api/teachers/[id]/photo/route.ts` | POST / DELETE | 4 |
| `src/app/api/teacher-photos/[photoId]/route.ts` | public GET | 4 |
| `tests/integration/teacher-photo-api.test.ts` | route matrix, erasure, export | 4 |
| `deploy/nginx.conf.example`, `DEPLOYMENT.md` | body-size location | 4 |
| `src/components/ui/avatar.tsx` (+ test) | the primitive | 5 |
| `src/components/settings/profile-photo-field.tsx` (+ test) | upload / replace / remove | 5 |
| `src/app/(teacher)/schedule/page.tsx`, `src/app/(public)/[slug]/page.tsx`, `src/app/(teacher)/settings/profile/page.tsx` | placements | 5 |
| `tests/e2e/teacher-photo.spec.ts`; visual baselines | e2e and screenshots | 5 |
| `docs/design-brief.md` | Avatar entry | 5 |

## Before Task 1 (controller, once)

In the worktree: `pnpm install --frozen-lockfile` (done), `pnpm run worktree:setup`, `pnpm run worktree:up`. Integration and e2e read `INTEGRATION_BASE_URL` automatically. Never touch a dev server on `:3000`.

---

### Task 1: `TeacherPhoto` table; `photoUrl` leaves; `profile-form` gets its pins

**Files:**
- Modify: `prisma/schema.prisma` (Teacher model; new TeacherPhoto model)
- Create: `prisma/migrations/20260929120000_teacher_photo/migration.sql`
- Modify: `src/lib/schemas.ts` (`updateTeacherSchema`)
- Modify: `src/lib/schemas.test.ts` (`SERVER_OWNED_FIELDS`, `EXPECTED`, curated-list assertion)
- Modify: `src/services/gdpr.ts` (erasure `updateMany` data)
- Modify: `src/components/settings/profile-form.tsx`, `src/components/settings/profile-form.test.tsx`, `src/app/(teacher)/settings/profile/page.tsx`
- Modify: `docs/data-model.md`, `docs/superpowers/specs/2026-09-29-teacher-profile-photo-design.md`

**Interfaces:**
- Produces: Prisma model `TeacherPhoto { id: string; teacherId: string; bytes: Uint8Array; createdAt: Date }`, relation `Teacher.photo: TeacherPhoto | null`, client accessor `prisma.teacherPhoto`. `ProfileFormValues` (exported from `profile-form.tsx`).

- [ ] **Step 1: Schema edit.** In `prisma/schema.prisma`, delete the `photoUrl String?` line from `model Teacher`, add `photo TeacherPhoto?` to its relation list, and add:

```prisma
/// A teacher's avatar, downscaled and re-encoded on upload. `id` is regenerated
/// on every upload and is the photo's URL, so a replaced photo's old URL stops
/// resolving.
model TeacherPhoto {
  id        String   @id @default(uuid())
  teacherId String   @unique
  bytes     Bytes
  createdAt DateTime @default(now())

  teacher Teacher @relation(fields: [teacherId], references: [id], onDelete: Cascade)
}
```

- [ ] **Step 2: Generate the migration SQL without a shadow DB.** `prisma migrate dev` refuses a non-interactive shell. Run:

```bash
pnpm exec prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script
```

Expected: a `CREATE TABLE "TeacherPhoto"`, a unique index on `"teacherId"`, an `ADD CONSTRAINT … FOREIGN KEY … ON DELETE CASCADE`, and `ALTER TABLE "Teacher" DROP COLUMN "photoUrl"`. Write that output verbatim to `prisma/migrations/20260929120000_teacher_photo/migration.sql`. Comments in it may describe only its own SQL (it becomes immutable on merge). It contains no `UPDATE`/`DELETE`, so `migration-remediation-trace.test.ts` needs no notice block — confirm by reading the file.

- [ ] **Step 3: Apply.** `pnpm exec prisma migrate deploy` then `pnpm exec prisma generate`. Expected: "1 migration applied"; `pnpm exec prisma migrate status` reports the schema up to date.

- [ ] **Step 4: Prove `_serverOwnedNamesExist` bites.** Before touching `schemas.test.ts`, run `pnpm run typecheck`. Expected: FAIL in `src/lib/schemas.test.ts` naming `"photoUrl"` (the name is no longer a column on any model in `AnyModelKey`), plus failures wherever `photoUrl` is still written — `src/services/gdpr.ts` (`photoUrl: null`) and `src/app/api/teachers/[id]/route.ts` (it hands `updateTeacherSchema`'s output to `prisma.teacher.update`). Record the exact `schemas.test.ts` error text for the PR body.

- [ ] **Step 5: Remove `photoUrl` everywhere it was a live claim.**
  - `src/lib/schemas.ts`: delete `photoUrl: z.string().url().nullable().optional(),` from `updateTeacherSchema`.
  - `src/lib/schemas.test.ts`: remove `'photoUrl'` from `SERVER_OWNED_FIELDS`; remove the `updateTeacherSchema: ['photoUrl'],` entry **and its two-line KNOWN GAP comment** from `EXPECTED`; remove `'photoUrl',` from the curated-list assertion.
  - `src/services/gdpr.ts`: delete `photoUrl: null,` from the erasure `updateMany`.
  - Then `grep -rn photoUrl src prisma/schema.prisma tests` — expected: no hits. (Hits in the init migration and in older `docs/superpowers/` plans/specs are historical records; leave them.)

- [ ] **Step 6: Run** `pnpm run typecheck` and `pnpm exec vitest run --project unit src/lib/schemas.test.ts`. Expected: PASS.

- [ ] **Step 7: Pin `profile-form.tsx`.** Its `initial` carries `email`, which is shown read-only and is not in the schema, so a reverse pin over `initial` would fail naming `email`. Split it:

```ts
import type { z } from 'zod';
import type { updateTeacherSchema } from '@/lib/schemas';
import type { NoneOf } from '@/lib/type-pins';

type UpdateTeacherWire = z.infer<typeof updateTeacherSchema>;

/** Every field this form edits and sends. `email` is shown, not edited, so it is a separate prop. */
export interface ProfileFormValues {
  firstName: string;
  lastName: string;
  bio: string;
  pageSlug: string;
  defaultCurrency: string;
  defaultTimezone: string;
  defaultReminder: string;
  bankIban: string | null;
  bankAccountName: string | null;
}

/**
 * Forward: a field added to `updateTeacherSchema` with no input here fails the
 * build, naming it. Reverse: a field this form sends that the schema dropped —
 * `.strict()` would 400 it at runtime; this catches it at compile time.
 */
const _formCoversSchema: NoneOf<Exclude<keyof UpdateTeacherWire, keyof ProfileFormValues>> = true;
const _formHasNoExtras: NoneOf<Exclude<keyof ProfileFormValues, keyof UpdateTeacherWire>> = true;
void _formCoversSchema;
void _formHasNoExtras;
```

Change `ProfileFormProps` to `{ teacherId: string; email: string; initial: ProfileFormValues; timeZoneOptions: TimeZoneOptions }`, read `email` from the prop where the form renders it, and update `src/app/(teacher)/settings/profile/page.tsx` to pass `email={teacher.email}` beside an `initial` without `email`. Update `profile-form.test.tsx`'s fixture the same way. No rendered input, label or submitted key changes.

- [ ] **Step 8: Prove both pins bite.** (a) Temporarily add `photoUrl: z.string().optional(),` back to `updateTeacherSchema`; `pnpm run typecheck` must fail at `_formCoversSchema` naming `"photoUrl"`. Restore. (b) Temporarily add `nickname: string;` to `ProfileFormValues`; typecheck must fail at `_formHasNoExtras` naming `"nickname"`. Restore. Record both error texts. Run `git diff --stat` and confirm only the intended files differ.

- [ ] **Step 9: Run** `pnpm exec vitest run --project components src/components/settings/profile-form.test.tsx` and `pnpm run typecheck`. Expected: PASS.

- [ ] **Step 10: Docs.** `docs/data-model.md`: add a `TeacherPhoto` entry beside `Teacher` (fields, the 1:1 unique `teacherId`, cascade, "id regenerated per upload is the URL", bytes always WebP 400×400, deleted by erasure). Spec: apply deviations 1 and 3 from this plan (cascade in the Data model block; drop "and by body" from the Testing list and state why beside the size-check step).

- [ ] **Step 11: Commit.**

```bash
git add prisma/schema.prisma prisma/migrations/20260929120000_teacher_photo/migration.sql src/lib/schemas.ts src/lib/schemas.test.ts src/services/gdpr.ts src/components/settings/profile-form.tsx src/components/settings/profile-form.test.tsx "src/app/(teacher)/settings/profile/page.tsx" docs/data-model.md docs/superpowers/specs/2026-09-29-teacher-profile-photo-design.md
git commit -m "feat(teacher-photo): TeacherPhoto table; photoUrl leaves; profile-form pinned to its schema (#46)"
```

---

### Task 2: Image processing — `processTeacherPhoto`

**Files:**
- Modify: `package.json` (`"sharp": "^0.35.4"` in `dependencies`), `pnpm-lock.yaml`
- Create: `src/lib/teacher-photo-limits.ts`
- Create: `src/services/teacher-photo.ts`
- Test: `src/services/teacher-photo.test.ts` (unit tier)

**Interfaces:**
- Produces (`src/lib/teacher-photo-limits.ts`, imports nothing):
  - `MAX_PHOTO_BYTES: number`, `MAX_PHOTO_REQUEST_BYTES: number`, `ACCEPTED_PHOTO_TYPES: string`
  - `type PhotoRefusal = 'not-an-image' | 'too-many-pixels'`
  - `type PhotoProblem = PhotoRefusal | 'no-photo' | 'too-large'`
  - `PHOTO_MESSAGES: Record<PhotoProblem, string>`
  - `teacherPhotoPath(photoId: string): string`
- Produces (`src/services/teacher-photo.ts`):
  - `PHOTO_EDGE_PX = 400`, `MAX_INPUT_PIXELS = 50_000_000`
  - `type ProcessedPhoto = { ok: true; bytes: Buffer } | { ok: false; reason: PhotoRefusal }`
  - `processTeacherPhoto(input: Uint8Array): Promise<ProcessedPhoto>`

- [ ] **Step 1: Add the dependency.** Add `"sharp": "^0.35.4"` to `dependencies` in `package.json` (alphabetical), then `pnpm install`. Expected: lockfile gains sharp under the root importer only; no new package versions resolved (0.35.4 is already locked via `next`); no `allowBuilds` error. Confirm `node_modules/sharp` now exists and `pnpm run check-lockfile` passes.

- [ ] **Step 2: Write the limits module.**

```ts
// src/lib/teacher-photo-limits.ts
/**
 * The photo upload's limits and copy, shared by the route and the upload
 * control. Imports nothing: client code value-imports this module.
 */
export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

/** Room for the multipart framing around a file at the limit. */
export const MAX_PHOTO_REQUEST_BYTES = MAX_PHOTO_BYTES + 64 * 1024;

export const ACCEPTED_PHOTO_TYPES = 'image/jpeg,image/png,image/webp';

export type PhotoRefusal = 'not-an-image' | 'too-many-pixels';
export type PhotoProblem = PhotoRefusal | 'no-photo' | 'too-large';

export const PHOTO_MESSAGES = {
  'no-photo': 'Choose a photo to upload.',
  'too-large': `That photo is over ${MAX_PHOTO_BYTES / (1024 * 1024)} MB. Choose a smaller one.`,
  'not-an-image': 'That file isn’t a JPEG, PNG or WebP image.',
  'too-many-pixels': 'That image is too large to process. Choose a smaller one.',
} as const satisfies Record<PhotoProblem, string>;

export function teacherPhotoPath(photoId: string): string {
  return `/api/teacher-photos/${encodeURIComponent(photoId)}`;
}
```

- [ ] **Step 3: Write the failing tests.** `src/services/teacher-photo.test.ts` — fixtures are generated with sharp at test time:

```ts
import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { crc32, deflateSync } from 'node:zlib';
import { processTeacherPhoto, PHOTO_EDGE_PX } from './teacher-photo';

async function solidJpeg(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: '#1A5653' } }).jpeg().toBuffer();
}

/** A PNG whose IHDR claims `width`×`height` but whose pixel data is one empty row — a decompression bomb's header. */
function pngHeaderClaiming(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 0; // 8-bit greyscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.alloc(1))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('processTeacherPhoto', () => {
  it('re-encodes a JPEG to a square WebP at the avatar edge', async () => {
    const out = await processTeacherPhoto(await solidJpeg(1200, 800));
    if (!out.ok) throw new Error(`refused: ${out.reason}`);
    const meta = await sharp(out.bytes).metadata();
    expect({ format: meta.format, width: meta.width, height: meta.height })
      .toEqual({ format: 'webp', width: PHOTO_EDGE_PX, height: PHOTO_EDGE_PX });
  });

  it('accepts PNG and WebP input', async () => {
    const png = await sharp({ create: { width: 500, height: 500, channels: 3, background: '#C4A96A' } }).png().toBuffer();
    const webp = await sharp({ create: { width: 500, height: 500, channels: 3, background: '#C4A96A' } }).webp().toBuffer();
    expect((await processTeacherPhoto(png)).ok).toBe(true);
    expect((await processTeacherPhoto(webp)).ok).toBe(true);
  });

  it('drops EXIF, GPS included', async () => {
    const input = await sharp(await solidJpeg(800, 800))
      .withExif({ IFD0: { Copyright: 'fixture' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '52/1 5/1 0/1' } })
      .jpeg().toBuffer();
    expect((await sharp(input).metadata()).exif).toBeDefined(); // the fixture really carries EXIF
    const out = await processTeacherPhoto(input);
    if (!out.ok) throw new Error(`refused: ${out.reason}`);
    expect((await sharp(out.bytes).metadata()).exif).toBeUndefined();
  });

  it('applies the EXIF orientation before cropping', async () => {
    // Left half red, right half blue; orientation 6 means "rotate 90° clockwise to display",
    // which puts the left (red) half on top.
    const red = await sharp({ create: { width: 400, height: 400, channels: 3, background: '#ff0000' } }).png().toBuffer();
    const input = await sharp({ create: { width: 800, height: 400, channels: 3, background: '#0000ff' } })
      .composite([{ input: red, left: 0, top: 0 }])
      .withMetadata({ orientation: 6 })
      .jpeg().toBuffer();
    const out = await processTeacherPhoto(input);
    if (!out.ok) throw new Error(`refused: ${out.reason}`);
    const { data, info } = await sharp(out.bytes).raw().toBuffer({ resolveWithObject: true });
    const px = (x: number, y: number) => {
      const i = (y * info.width + x) * info.channels;
      return { r: data[i] ?? 0, b: data[i + 2] ?? 0 };
    };
    const top = px(200, 50);
    const bottom = px(200, 350);
    expect(top.r > top.b && bottom.b > bottom.r).toBe(true);
  });

  it.each([
    ['an SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>')],
    ['random bytes', Buffer.from('definitely not an image')],
  ])('refuses %s as not-an-image', async (_label, input) => {
    expect(await processTeacherPhoto(input)).toEqual({ ok: false, reason: 'not-an-image' });
  });

  it('refuses a GIF as not-an-image', async () => {
    const gif = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#000' } }).gif().toBuffer();
    expect(await processTeacherPhoto(gif)).toEqual({ ok: false, reason: 'not-an-image' });
  });

  it('refuses a header claiming more pixels than the ceiling, before decoding', async () => {
    expect(await processTeacherPhoto(pngHeaderClaiming(10_000, 10_000)))
      .toEqual({ ok: false, reason: 'too-many-pixels' });
  });
});
```

If `withExif`'s tag shape or `withMetadata({ orientation })` is rejected by sharp 0.35's types, adjust the fixture call to the version's documented API — the assertions stay as written. The EXIF test's precondition line must remain: without it the test passes on an input that never had EXIF.

- [ ] **Step 4: Run to see them fail.** `pnpm exec vitest run --project unit src/services/teacher-photo.test.ts` — expected: FAIL, module `./teacher-photo` not found.

- [ ] **Step 5: Implement.**

```ts
// src/services/teacher-photo.ts
import sharp from 'sharp';
import { log } from '@/lib/log';
import type { PhotoRefusal } from '@/lib/teacher-photo-limits';

/** The stored avatar's edge, in pixels: covers the largest placement at 3× density. */
export const PHOTO_EDGE_PX = 400;

/** Refused before decoding — the guard against a small file that inflates to gigabytes. */
export const MAX_INPUT_PIXELS = 50_000_000;

const ACCEPTED_FORMATS: ReadonlySet<string> = new Set(['jpeg', 'png', 'webp']);

export type ProcessedPhoto = { ok: true; bytes: Buffer } | { ok: false; reason: PhotoRefusal };

/**
 * Decodes an uploaded image and re-encodes it as the stored avatar: upright
 * (EXIF orientation applied), centre-cropped square, WebP. sharp writes no
 * input metadata unless asked, so EXIF — GPS included — does not survive.
 * The format is sharp's own detection, never the client's claim.
 */
export async function processTeacherPhoto(input: Uint8Array): Promise<ProcessedPhoto> {
  let meta: sharp.Metadata;
  try {
    meta = await sharp(input).metadata();
  } catch {
    return { ok: false, reason: 'not-an-image' };
  }
  if (meta.format === undefined || !ACCEPTED_FORMATS.has(meta.format)) {
    return { ok: false, reason: 'not-an-image' };
  }
  if (meta.width === undefined || meta.height === undefined) {
    return { ok: false, reason: 'not-an-image' };
  }
  if (meta.width * meta.height > MAX_INPUT_PIXELS) {
    return { ok: false, reason: 'too-many-pixels' };
  }

  try {
    const bytes = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .resize(PHOTO_EDGE_PX, PHOTO_EDGE_PX, { fit: 'cover' })
      .webp({ quality: 80 })
      .toBuffer();
    return { ok: true, bytes };
  } catch (err) {
    // A header that parsed but a body that will not decode — a truncated or
    // corrupt upload. Logged, because the same catch would also see a failure
    // that is not the file's fault.
    log.warn({ err }, 'teacher photo: decode failed after the header parsed');
    return { ok: false, reason: 'not-an-image' };
  }
}
```

- [ ] **Step 6: Run the tests.** Same command. Expected: PASS.

- [ ] **Step 7: Prove each guard bites** (one at a time, restore after each, record the failing test name):
  - add `.keepMetadata()` after `.rotate()` → "drops EXIF, GPS included" fails;
  - add `'svg'` and `'gif'` to `ACCEPTED_FORMATS` → both refusal tests fail (SVG may instead pass through and fail on shape — record what happens);
  - delete the `meta.width * meta.height > MAX_INPUT_PIXELS` check → "refuses a header claiming…" fails (the pipeline's `limitInputPixels` would still throw, but returns `not-an-image`, which the test distinguishes);
  - delete `.rotate()` → the orientation test fails.
  If a classifier refuses a test run while a guard is weakened, ask the user for permission; never disguise the mutation. After the sweep, `git status` must show only this task's intended changes.

- [ ] **Step 8: Commit.**

```bash
git add package.json pnpm-lock.yaml src/lib/teacher-photo-limits.ts src/services/teacher-photo.ts src/services/teacher-photo.test.ts
git commit -m "feat(teacher-photo): process uploads to a square WebP with metadata stripped (#46)"
```

---

### Task 3: Persistence, the erasure gate, export

**Files:**
- Modify: `src/lib/db-locks.ts` (new `lockLiveTeacher`; header register line)
- Modify: `src/services/teacher-photo.ts` (save / remove / read)
- Modify: `src/services/teacher-photo.test.ts` (persistence tests)
- Modify: `src/services/gdpr.ts` (`deleteTeacherAccount` closing transaction; `exportTeacherData`)
- Create: `src/services/teacher-photo-lock-order.test.ts` (unit-sweeps tier)
- Modify: `vitest.tiers.ts` (`LOCK_CONTENTION_TESTS`)
- Modify: `docs/lock-order.md`

**Interfaces:**
- Consumes: `processTeacherPhoto` (Task 2); `prisma.teacherPhoto` (Task 1).
- Produces:
  - `lockLiveTeacher(tx: TransactionClientOnly, teacherId: string): Promise<boolean>` — `true` when the teacher exists and is not erased, holding `FOR SHARE` on its row.
  - `type SavePhotoResult = { saved: true; photoId: string } | { saved: false; reason: 'teacher-gone' }`
  - `saveTeacherPhoto(db: PrismaClient, teacherId: string, bytes: Uint8Array): Promise<SavePhotoResult>`
  - `removeTeacherPhoto(db: PrismaClient, teacherId: string): Promise<'removed' | 'none'>`
  - `readTeacherPhoto(db: PrismaClient, photoId: string): Promise<Uint8Array | null>`
  - `exportTeacherData(...)`'s `profile.photo: { contentType: 'image/webp'; base64: string } | null`

- [ ] **Step 1: Write the failing persistence tests** (append to `src/services/teacher-photo.test.ts`; it runs in the `unit` tier against the test DB). Use a real teacher per test, created inline like `gdpr.test.ts` does, with ids collected into an array and a guarded `afterAll`:

```ts
import { PrismaClient } from '@prisma/client';
import { saveTeacherPhoto, removeTeacherPhoto, readTeacherPhoto } from './teacher-photo';
import { uniqueSuffix } from '../../tests/helpers';

const prisma = new PrismaClient();
const teacherIds: string[] = [];

async function makeTeacher(): Promise<string> {
  const s = uniqueSuffix();
  const t = await prisma.teacher.create({
    data: {
      firstName: 'Photo', lastName: 'Teacher', email: `photo-${s}@test.local`,
      account: { create: { email: `photo-${s}@test.local` } }, bio: '', pageSlug: `photo-${s}`,
    },
  });
  teacherIds.push(t.id);
  return t.id;
}

afterAll(async () => {
  if (teacherIds.length > 0) {
    const accounts = await prisma.teacher.findMany({ where: { id: { in: teacherIds } }, select: { accountId: true } });
    await prisma.teacher.deleteMany({ where: { id: { in: teacherIds } } }); // cascades TeacherPhoto
    await prisma.account.deleteMany({ where: { id: { in: accounts.map((a) => a.accountId) } } });
  }
  await prisma.$disconnect();
});

describe('saveTeacherPhoto / readTeacherPhoto / removeTeacherPhoto', () => {
  const bytes = Buffer.from('stored-bytes');

  it('stores, reads back, and issues a new id on replace', async () => {
    const teacherId = await makeTeacher();
    const first = await saveTeacherPhoto(prisma, teacherId, bytes);
    if (!first.saved) throw new Error('first save refused');
    expect(Buffer.from((await readTeacherPhoto(prisma, first.photoId)) ?? [])).toEqual(bytes);

    const second = await saveTeacherPhoto(prisma, teacherId, Buffer.from('replacement'));
    if (!second.saved) throw new Error('second save refused');
    expect(second.photoId).not.toBe(first.photoId);
    expect(await readTeacherPhoto(prisma, first.photoId)).toBeNull();
    expect(await prisma.teacherPhoto.count({ where: { teacherId } })).toBe(1);
  });

  it('two concurrent saves for one teacher leave one row and no error', async () => {
    const teacherId = await makeTeacher();
    const results = await Promise.all([
      saveTeacherPhoto(prisma, teacherId, Buffer.from('a')),
      saveTeacherPhoto(prisma, teacherId, Buffer.from('b')),
    ]);
    expect(results.every((r) => r.saved)).toBe(true);
    expect(await prisma.teacherPhoto.count({ where: { teacherId } })).toBe(1);
  });

  it('refuses an erased teacher and writes nothing', async () => {
    const teacherId = await makeTeacher();
    await prisma.teacher.update({ where: { id: teacherId }, data: { deletedAt: new Date() } });
    expect(await saveTeacherPhoto(prisma, teacherId, bytes)).toEqual({ saved: false, reason: 'teacher-gone' });
    expect(await prisma.teacherPhoto.count({ where: { teacherId } })).toBe(0);
  });

  it('does not serve an erased teacher\'s photo even if a row survived', async () => {
    const teacherId = await makeTeacher();
    const saved = await saveTeacherPhoto(prisma, teacherId, bytes);
    if (!saved.saved) throw new Error('save refused');
    await prisma.teacher.update({ where: { id: teacherId }, data: { deletedAt: new Date() } });
    expect(await readTeacherPhoto(prisma, saved.photoId)).toBeNull();
  });

  it('remove answers removed, then none', async () => {
    const teacherId = await makeTeacher();
    await saveTeacherPhoto(prisma, teacherId, bytes);
    expect(await removeTeacherPhoto(prisma, teacherId)).toBe('removed');
    expect(await removeTeacherPhoto(prisma, teacherId)).toBe('none');
  });
});
```

Add `beforeAll`/`afterAll` to the existing vitest import. Also append to `src/services/gdpr.test.ts`'s teacher-erasure coverage (a new `it`, own teacher, same guarded teardown pattern that file already uses):

```ts
it('teacher erasure deletes the stored photo and the export carried it', async () => {
  // create teacher `teacherId` as the surrounding tests do
  const saved = await saveTeacherPhoto(prisma, teacherId, Buffer.from('face'));
  if (!saved.saved) throw new Error('save refused');
  const exported = await exportTeacherData(prisma, teacherId);
  expect(exported.profile.photo).toEqual({ contentType: 'image/webp', base64: Buffer.from('face').toString('base64') });
  await expectErased(deleteTeacherAccount(prisma, teacherId));
  expect(await prisma.teacherPhoto.count({ where: { teacherId } })).toBe(0);
});
```

(`expectErased` is from `tests/erasure-assertions.ts`.) Also assert `profile.photo` is `null` for a teacher without one, in the same file.

- [ ] **Step 2: Run to see them fail.** `pnpm exec vitest run --project unit src/services/teacher-photo.test.ts src/services/gdpr.test.ts` — expected: FAIL (functions not exported; `profile.photo` undefined).

- [ ] **Step 3: `lockLiveTeacher`** in `src/lib/db-locks.ts`, beside `lockLiveStudent`, and one line in the file's header register naming it and its mode:

```ts
/**
 * The photo upload's gate (#46): the teacher's row `FOR SHARE`, with the shared
 * bounded wait. `FOR SHARE` conflicts with the `FOR NO KEY UPDATE` erasure's
 * anonymising `UPDATE` takes, so an upload and an erasure serialise on this row;
 * `FOR KEY SHARE` would not. Answers whether the teacher is live, read under
 * the lock. `docs/lock-order.md`, "The `Teacher` row is the photo upload's gate".
 */
export async function lockLiveTeacher(
  tx: TransactionClientOnly,
  teacherId: string,
): Promise<boolean> {
  await setLockTimeout(tx);
  const rows = await tx.$queryRaw<Array<{ deletedAt: Date | null }>>`
    SELECT "deletedAt" FROM "Teacher" WHERE id = ${teacherId} FOR SHARE`;
  const row = rows[0];
  return row !== undefined && row.deletedAt === null;
}
```

- [ ] **Step 4: Persistence** in `src/services/teacher-photo.ts`:

```ts
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { lockLiveTeacher } from '@/lib/db-locks';

export type SavePhotoResult = { saved: true; photoId: string } | { saved: false; reason: 'teacher-gone' };

/**
 * Stores `bytes` as the teacher's photo under a fresh id, replacing any earlier
 * one. The `upsert` resolves two concurrent saves last-write-wins through
 * `ON CONFLICT` rather than a unique violation. Gated on `lockLiveTeacher`,
 * whose placement against erasure is `docs/lock-order.md`'s.
 */
export async function saveTeacherPhoto(
  db: PrismaClient,
  teacherId: string,
  bytes: Uint8Array,
): Promise<SavePhotoResult> {
  return db.$transaction(async (tx): Promise<SavePhotoResult> => {
    if (!(await lockLiveTeacher(tx, teacherId))) return { saved: false, reason: 'teacher-gone' };
    const photoId = randomUUID();
    await tx.teacherPhoto.upsert({
      where: { teacherId },
      create: { id: photoId, teacherId, bytes },
      update: { id: photoId, bytes },
    });
    return { saved: true, photoId };
  });
}

export async function removeTeacherPhoto(db: PrismaClient, teacherId: string): Promise<'removed' | 'none'> {
  const { count } = await db.teacherPhoto.deleteMany({ where: { teacherId } });
  return count === 0 ? 'none' : 'removed';
}

/** The stored bytes for `photoId`, or `null` when unknown or its teacher is erased. */
export async function readTeacherPhoto(db: PrismaClient, photoId: string): Promise<Uint8Array | null> {
  const row = await db.teacherPhoto.findFirst({
    where: { id: photoId, teacher: { deletedAt: null } },
    select: { bytes: true },
  });
  return row?.bytes ?? null;
}
```

- [ ] **Step 5: Erasure and export** in `src/services/gdpr.ts`:
  - In `deleteTeacherAccount`'s closing transaction, directly after `if (erased.count === 0) throw new AlreadyErasedError('teacher');` and before `return skipped;`:

```ts
      // After the anonymising UPDATE, never before it: that UPDATE is what
      // waits out an upload holding the teacher row (`lockLiveTeacher`), and
      // this DELETE's own snapshot then sees the row that upload wrote.
      await tx.teacherPhoto.deleteMany({ where: { teacherId } });
```

  - In `exportTeacherData`, add `photo: { select: { bytes: true } }` to the `include`, and to `profile`:

```ts
      photo: teacher.photo
        ? { contentType: 'image/webp' as const, base64: Buffer.from(teacher.photo.bytes).toString('base64') }
        : null,
```

- [ ] **Step 6: Run.** Same command as Step 2. Expected: PASS.

- [ ] **Step 7: The race tests.** Create `src/services/teacher-photo-lock-order.test.ts` with the header marker `@serial-tier lock-contention` in its top docblock (one sentence of reason: it holds the `Teacher` row on a second connection), and add its path to `LOCK_CONTENTION_TESTS` in `vitest.tiers.ts`. Copy `latch`, `ownPid` and `waiterOf` verbatim from `src/app/api/teachers/[id]/route-lock-order.test.ts` (the repo keeps them per-file). Two tests:

  **(A) Upload holds the gate; erasure arrives.** Spy on the gate so the upload pauses while holding it:

```ts
import * as dbLocks from '@/lib/db-locks';
// …
it('an erasure that waits behind an upload still deletes what the upload wrote', async () => {
  const teacherId = await makeTeacher();           // same helper/teardown shape as Task 3 Step 1
  const reached = latch(); const release = latch();
  let uploadPid = 0;
  const original = dbLocks.lockLiveTeacher;
  vi.spyOn(dbLocks, 'lockLiveTeacher').mockImplementation(async (tx, id) => {
    const live = await original(tx, id);
    uploadPid = await ownPid(tx);
    reached.open();
    await release.promise;
    return live;
  });

  const upload = saveTeacherPhoto(prisma, teacherId, Buffer.from('racing'));
  await reached.promise;
  let erasureSettled = false;
  const erasure = deleteTeacherAccount(prisma, teacherId).finally(() => { erasureSettled = true; });
  void erasure.catch(() => undefined);

  const waiter = await waiterOf(uploadPid, () => erasureSettled);
  expect(waiter).not.toBeNull();                   // erasure is parked on the upload's FOR SHARE
  release.open();

  expect(await upload).toMatchObject({ saved: true });
  await expectErased(erasure);
  expect(await prisma.teacherPhoto.count({ where: { teacherId } })).toBe(0);
});
```

  **(B) Erasure holds the row; upload arrives.** A holder on a second client takes erasure's mode, writes `deletedAt`, and holds:

```ts
it('an upload that waits behind an erasure is refused and writes nothing', async () => {
  const teacherId = await makeTeacher();
  const holder = new PrismaClient();
  const held = latch(); const release = latch();
  let holderPid = 0;
  const holding = holder.$transaction(async (tx) => {
    holderPid = await ownPid(tx);
    await tx.$executeRaw`UPDATE "Teacher" SET "deletedAt" = now() WHERE id = ${teacherId}`;
    held.open();
    await release.promise;
  }, { timeout: 20_000 });
  try {
    await Promise.race([held.promise, holding]);
    let settled = false;
    const upload = saveTeacherPhoto(prisma, teacherId, Buffer.from('late')).finally(() => { settled = true; });
    void upload.catch(() => undefined);
    expect(await waiterOf(holderPid, () => settled)).not.toBeNull(); // parked on the uncommitted erasure
    release.open();
    await holding;
    expect(await upload).toEqual({ saved: false, reason: 'teacher-gone' });
    expect(await prisma.teacherPhoto.count({ where: { teacherId } })).toBe(0);
  } finally {
    release.open();
    await holding.catch(() => undefined);
    await holder.$disconnect();
  }
});
```

  Restore spies in `afterEach` (`vi.restoreAllMocks()`). Teardown as in Step 1.

- [ ] **Step 8: Run.** `pnpm exec vitest run --project unit-sweeps src/services/teacher-photo-lock-order.test.ts` and `pnpm exec vitest run --project unit src/lib/serial-tier-membership.test.ts`. Expected: PASS. Then confirm the harness really overlaps (memory: a hold can serialise): add temporary `console.log(Date.now(), …)` at hook-reached, erasure start, erasure end and release in (A); the erasure's end must come after release. Remove the logs.

- [ ] **Step 9: Prove both orderings bite.** (a) Move `tx.teacherPhoto.deleteMany(...)` in `gdpr.ts` to the top of the closing transaction → test (A) fails on the final count (1, not 0). Restore. (b) Change `FOR SHARE` to `FOR KEY SHARE` in `lockLiveTeacher` → test (B) fails (`waiterOf` returns `null`, and/or the upload saves). Restore. Record both failure texts. `git status` must show only this task's intended changes.

- [ ] **Step 10: `docs/lock-order.md`.** Add a section after "The `TeacherStudent` row is the archive's gate (#265)", titled "The `Teacher` row is the photo upload's gate (#46)", in that section's style: the race it closes (an upload still in sharp when erasure commits); the lock (`lockLiveTeacher`, `FOR SHARE`) and why not `FOR KEY SHARE` (the upsert's FK check already takes that and it does not conflict with `FOR NO KEY UPDATE`); both orderings, as in the spec; the placement rule (erasure's `deleteMany` after its `updateMany`); order `Teacher` → `TeacherPhoto`, and that the upload takes no other lock so no cycle is possible; the two tests that pin it. If the "Every site that bounds a lock wait" census lists `setLockTimeout` call sites, re-run its command and update the list it keeps (it ships with its command — follow it).

- [ ] **Step 11: Commit.**

```bash
git add src/lib/db-locks.ts src/services/teacher-photo.ts src/services/teacher-photo.test.ts src/services/gdpr.ts src/services/gdpr.test.ts src/services/teacher-photo-lock-order.test.ts vitest.tiers.ts docs/lock-order.md
git commit -m "feat(teacher-photo): gated save, erasure deletes the photo after anonymising, export carries it (#46)"
```

---

### Task 4: Routes, rate limit, nginx

**Files:**
- Modify: `src/lib/rate-limit.ts` (`RateLimitPrefix`, `PREFIX_CAPACITIES`)
- Create: `src/app/api/teachers/[id]/photo/route.ts`
- Create: `src/app/api/teacher-photos/[photoId]/route.ts`
- Test: `tests/integration/teacher-photo-api.test.ts`
- Modify: `deploy/nginx.conf.example`, `DEPLOYMENT.md`

**Interfaces:**
- Consumes: `processTeacherPhoto`, `saveTeacherPhoto`, `removeTeacherPhoto`, `readTeacherPhoto` (Tasks 2–3); `MAX_PHOTO_BYTES`, `MAX_PHOTO_REQUEST_BYTES`, `PHOTO_MESSAGES`, `teacherPhotoPath` (Task 2).
- Produces: `POST /api/teachers/[id]/photo` → 200 `{ data: { photoId: string } }`; `DELETE /api/teachers/[id]/photo` → 200 `{ data: { photoId: null } }` or 200 `{ data: { photoId: null }, outcome: 'unchanged' }`; `GET /api/teacher-photos/[photoId]` → `image/webp` bytes or 404.

- [ ] **Step 1: Rate-limit prefix.** Add `| 'teacher-photo'` to `RateLimitPrefix` and `'teacher-photo': 1_000,` to `PREFIX_CAPACITIES` (its `satisfies` forces both). It is keyed by teacher id, so it does not join `IpRateLimitPrefix`.

- [ ] **Step 2: Write the failing integration tests.** `tests/integration/teacher-photo-api.test.ts`. Fixtures inline (no `makeTeacherWithSession` wrapper — see `docs/technical-architecture.md`, Testing conventions); ids collected into arrays; `afterAll` deletes sessions, then teachers by `{ in: ids }` (cascade removes photos), then accounts, each skipped when empty.

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import sharp from 'sharp';
import { BASE_URL, cookie, uniqueSuffix, seedSession } from '../helpers';
import { expectApplied, expectUnchanged } from '../api-assertions';

const prisma = new PrismaClient();
const teacherIds: string[] = [];
const accountIds: string[] = [];

async function makeTeacher(): Promise<{ id: string; token: string; accountId: string }> {
  const s = uniqueSuffix();
  const t = await prisma.teacher.create({
    data: {
      firstName: 'Photo', lastName: 'Route', email: `photo-route-${s}@test.local`,
      account: { create: { email: `photo-route-${s}@test.local` } }, bio: '', pageSlug: `photo-route-${s}`,
    },
  });
  teacherIds.push(t.id);
  accountIds.push(t.accountId);
  return { id: t.id, accountId: t.accountId, token: await seedSession(prisma, t.accountId) };
}

async function jpeg(): Promise<Blob> {
  const buf = await sharp({ create: { width: 600, height: 600, channels: 3, background: '#1A5653' } }).jpeg().toBuffer();
  return new Blob([new Uint8Array(buf)], { type: 'image/jpeg' });
}

function upload(teacherId: string, token: string | null, file: Blob | null): Promise<Response> {
  const form = new FormData();
  if (file) form.append('photo', file, 'me.jpg');
  return fetch(`${BASE_URL}/api/teachers/${teacherId}/photo`, {
    method: 'POST', headers: token ? cookie(token) : {}, body: form,
  });
}
```

Cases (one `it` each):
- no cookie → 401; another teacher's token → 403; both write no row.
- a JPEG → `expectApplied`, `photoId` is a string; `GET ${BASE_URL}/api/teacher-photos/<id>` → 200, `content-type` `image/webp`, `cache-control` `public, max-age=31536000, immutable`, body decodes (sharp metadata) as 400×400 webp.
- a second upload → a different `photoId`; the first URL → 404.
- a 9 MB blob → 400 with `error.message` equal to `PHOTO_MESSAGES['too-large']`.
- a text file (`new Blob(['hello'], { type: 'image/jpeg' })`) → 400 `PHOTO_MESSAGES['not-an-image']` (the lying MIME type is the point).
- a form with no `photo` field → 400 `PHOTO_MESSAGES['no-photo']`; a JSON body (`Content-Type: application/json`, `{}`) → 400 `PHOTO_MESSAGES['no-photo']`.
- DELETE with a photo → `expectApplied`; DELETE again → `expectUnchanged`; another teacher's DELETE → 403 and the owner's photo still reads.
- rate limit: a fresh teacher uploads 10 times (each `expectApplied`), the 11th → 429.
- erasure: a teacher with a photo calls `DELETE /api/account` (the body/confirmation that `tests/integration/account-api.test.ts` sends — copy it); afterwards `TeacherPhoto` count for the teacher is 0 and the old photo URL → 404.
- export: `GET /api/account/export` for a teacher with a photo → `profile.photo.contentType === 'image/webp'` and `base64` decodes to the bytes `GET /api/teacher-photos/<id>` served.

Assert messages via `PHOTO_MESSAGES` imported from `@/lib/teacher-photo-limits` (or the relative path the other integration files use for `src/lib`), never a literal string.

- [ ] **Step 3: Run to see them fail.** `pnpm exec vitest run --project integration tests/integration/teacher-photo-api.test.ts` — expected: FAIL (404s from missing routes).

- [ ] **Step 4: The owner's route.** `src/app/api/teachers/[id]/photo/route.ts`:

```ts
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk, respondUnchanged, respondError, requireTeacher, isErrorResponse, withErrorHandler,
} from '@/lib/api-utils';
import { checkRateLimit, rateLimitKey, respondRateLimited } from '@/lib/rate-limit';
import { MAX_PHOTO_BYTES, MAX_PHOTO_REQUEST_BYTES, PHOTO_MESSAGES } from '@/lib/teacher-photo-limits';
import { processTeacherPhoto, saveTeacherPhoto, removeTeacherPhoto } from '@/services/teacher-photo';

const UPLOADS_PER_WINDOW = 10;
const UPLOAD_WINDOW_MS = 15 * 60 * 1000;

export const POST = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;
  if (session.teacherId !== id) return respondError('Access denied', 403);

  const limit = checkRateLimit(rateLimitKey('teacher-photo', id), UPLOADS_PER_WINDOW, UPLOAD_WINDOW_MS);
  if (!limit.allowed) return respondRateLimited(limit, 'Too many photo uploads.');

  // Refused before the body is read: nothing past this line buffers more than the limit.
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_PHOTO_REQUEST_BYTES) return respondError(PHOTO_MESSAGES['too-large'], 400);

  let file: FormDataEntryValue | null;
  try {
    file = (await request.formData()).get('photo');
  } catch {
    return respondError(PHOTO_MESSAGES['no-photo'], 400);
  }
  if (!(file instanceof File) || file.size === 0) return respondError(PHOTO_MESSAGES['no-photo'], 400);
  if (file.size > MAX_PHOTO_BYTES) return respondError(PHOTO_MESSAGES['too-large'], 400);

  const processed = await processTeacherPhoto(new Uint8Array(await file.arrayBuffer()));
  if (!processed.ok) return respondError(PHOTO_MESSAGES[processed.reason], 400);

  const saved = await saveTeacherPhoto(prisma, id, processed.bytes);
  if (!saved.saved) return respondError('Teacher not found', 404);
  return respondOk({ photoId: saved.photoId });
});

export const DELETE = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;
  if (session.teacherId !== id) return respondError('Access denied', 403);

  if ((await removeTeacherPhoto(prisma, id)) === 'none') {
    return respondUnchanged<{ photoId: null }>({ photoId: null });
  }
  return respondOk({ photoId: null });
});
```

The `catch` around `formData()` is deliberately narrow: that call throws a `TypeError` for a body that is not multipart, which is the client's error. Nothing else is inside it.

- [ ] **Step 5: The public route.** `src/app/api/teacher-photos/[photoId]/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { respondError, withErrorHandler } from '@/lib/api-utils';
import { readTeacherPhoto } from '@/services/teacher-photo';

// Public: the teacher's public page shows it to signed-out visitors. The id is
// regenerated on every upload, so a response for one id never changes.
export const GET = withErrorHandler(async (
  _request: NextRequest,
  { params }: { params: Promise<{ photoId: string }> },
) => {
  const { photoId } = await params;
  const bytes = await readTeacherPhoto(prisma, photoId);
  if (bytes === null) return respondError('Photo not found', 404);
  return new NextResponse(Buffer.from(bytes), {
    status: 200,
    headers: {
      'Content-Type': 'image/webp',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
});
```

- [ ] **Step 6: Run.** Warm both routes first (`curl -s -o /dev/null "$INTEGRATION_BASE_URL/api/teacher-photos/x"`; a POST without cookie), then the command from Step 3. Expected: PASS.

- [ ] **Step 7: Prove the route's guards bite** (one at a time; warm the route after each edit; restore; record the failing case): remove the ownership check on POST → the 403 case fails; remove the rate-limit check → the 429 case fails; remove the `Content-Length` check → the 9 MB case still refuses via `file.size` (expected: stays green — record this, it is the defence-in-depth branch, not a gap); remove `teacher: { deletedAt: null }` from `readTeacherPhoto` → Task 3's "does not serve an erased teacher's photo" unit test fails (run it). `git status` clean of mutations afterwards.

- [ ] **Step 8: nginx and deployment docs.** In `deploy/nginx.conf.example`, inside the 443 server, before `location /`:

```nginx
    # Teacher photo uploads. The app refuses above 8 MB itself, in JSON; this
    # limit sits above that so the app, not nginx, is the one answering.
    location ~ ^/api/teachers/[^/]+/photo$ {
        client_max_body_size 10m;
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
```

In `DEPLOYMENT.md`'s Nginx section, one paragraph: the photo route needs the larger body limit; everything else keeps nginx's 1 MB default.

- [ ] **Step 9: The runtime image carries sharp.** A worktree resolves modules through the main checkout, so only the container proves this. Run `docker build -t fairyoga-46 .` (expected: success). Then start it against the dev Postgres the way `DEPLOYMENT.md` / `docker-compose.yml` describe (or `docker run --rm fairyoga-46 node -e "require('sharp')"` from `/app` as the minimum), and confirm `require('sharp')` resolves with the `linuxmusl` binary. If it does not, add `serverExternalPackages: ['sharp']` to `next.config.ts` and rebuild. Record the command and its output for the PR body. If Docker is unavailable, say so in the report — do not claim it.

- [ ] **Step 10: Commit.**

```bash
git add src/lib/rate-limit.ts "src/app/api/teachers/[id]/photo/route.ts" "src/app/api/teacher-photos/[photoId]/route.ts" tests/integration/teacher-photo-api.test.ts deploy/nginx.conf.example DEPLOYMENT.md
git commit -m "feat(teacher-photo): upload, remove and serve routes; per-teacher upload limit; nginx body size (#46)"
```

---

### Task 5: Avatar, upload control, placements

**Files:**
- Create: `src/components/ui/avatar.tsx`, `src/components/ui/avatar.test.tsx`
- Create: `src/components/settings/profile-photo-field.tsx`, `src/components/settings/profile-photo-field.test.tsx`
- Modify: `src/app/(teacher)/schedule/page.tsx`, `src/app/(public)/[slug]/page.tsx`, `src/app/(teacher)/settings/profile/page.tsx`
- Create: `tests/e2e/teacher-photo.spec.ts`
- Modify: visual baselines `public-page` and `schedule` (regenerated); `docs/design-brief.md`

**Interfaces:**
- Consumes: `teacherPhotoPath`, `MAX_PHOTO_BYTES`, `ACCEPTED_PHOTO_TYPES`, `PHOTO_MESSAGES` (Task 2); the routes (Task 4).
- Produces: `Avatar({ firstName, lastName, photoId, size, className? })`, `type AvatarSize = 40 | 72`, `initialsOf(firstName: string, lastName: string): string`; `ProfilePhotoField({ teacherId, firstName, lastName, photoId })`.

- [ ] **Step 1: Failing Avatar tests.** `src/components/ui/avatar.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Avatar, initialsOf } from './avatar';

describe('initialsOf', () => {
  it('takes the first character of each name, uppercased', () => {
    expect(initialsOf('ivo', 'hofland')).toBe('IH');
    expect(initialsOf('élise', 'ødegaard')).toBe('ÉØ');
  });
  it('keeps an astral first character whole', () => {
    expect(initialsOf('𠮷野', 'Tanaka')).toBe('𠮷T');
  });
});

describe('Avatar', () => {
  it('renders initials, hidden from assistive tech, when there is no photo', () => {
    const { container } = render(<Avatar firstName="Visual" lastName="Teacher" photoId={null} size={72} />);
    const el = container.firstElementChild;
    expect(el?.textContent).toBe('VT');
    expect(el?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('img')).toBeNull();
  });
  it('renders the photo at its size with an empty alt', () => {
    const { container } = render(<Avatar firstName="Visual" lastName="Teacher" photoId="abc" size={40} />);
    const img = container.querySelector('img');
    expect(img?.getAttribute('src')).toBe('/api/teacher-photos/abc');
    expect(img?.getAttribute('alt')).toBe('');
    expect(img?.getAttribute('width')).toBe('40');
  });
});
```

Run `pnpm exec vitest run --project components src/components/ui/avatar.test.tsx` — expected: FAIL (module missing).

- [ ] **Step 2: Implement Avatar.**

```tsx
// src/components/ui/avatar.tsx
import Image from 'next/image';
import { teacherPhotoPath } from '@/lib/teacher-photo-limits';

export type AvatarSize = 40 | 72;

interface AvatarProps {
  firstName: string;
  lastName: string;
  photoId: string | null;
  size: AvatarSize;
  className?: string;
}

/** First character of each name, uppercased. `Array.from` splits by code point, so an astral character stays whole. */
export function initialsOf(firstName: string, lastName: string): string {
  const first = Array.from(firstName.trim())[0] ?? '';
  const last = Array.from(lastName.trim())[0] ?? '';
  return `${first}${last}`.toUpperCase();
}

// A person, not a card: round, flat, no ring or hover step. Every placement
// sits beside the person's name, so the image's alt is empty and the initials
// are hidden — the name is read once, from the text beside it.
export function Avatar({ firstName, lastName, photoId, size, className = '' }: AvatarProps) {
  if (photoId !== null) {
    return (
      <Image
        src={teacherPhotoPath(photoId)}
        alt=""
        width={size}
        height={size}
        unoptimized
        className={`rounded-pill object-cover shrink-0 ${className}`}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size }}
      className={`inline-flex items-center justify-center shrink-0 rounded-pill bg-teal-tint ${
        size === 72 ? 'type-title' : 'type-subtitle text-teal'
      } ${className}`}
    >
      {initialsOf(firstName, lastName)}
    </span>
  );
}
```

`unoptimized` because the bytes are already sized and Next's optimizer would re-process them. If `next/image` fails to render under jsdom, surface it rather than switching to a bare `<img>` silently — a bare `<img>` needs a stated reason beside it for the `@next/next/no-img-element` lint. Verify in the visual baseline (Step 9) that the 40px initials render teal, not ink — `type-subtitle` sets ink, and whether `text-teal` wins depends on utility order.

Run the Avatar tests — expected: PASS. Mutation: replace `Array.from(firstName.trim())[0]` with `firstName.trim().charAt(0)` → the astral test fails. Restore.

- [ ] **Step 3: Failing ProfilePhotoField tests.** `src/components/settings/profile-photo-field.test.tsx` — stub `fetch` per test as `profile-form.test.tsx` does; `routerRefresh` from `tests/setup/components`:

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ProfilePhotoField } from './profile-photo-field';
import { MAX_PHOTO_BYTES, PHOTO_MESSAGES } from '@/lib/teacher-photo-limits';
import { routerRefresh } from '../../../tests/setup/components';

const fetchMock = vi.fn();
afterEach(() => { fetchMock.mockReset(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function renderField(photoId: string | null = null) {
  vi.stubGlobal('fetch', fetchMock);
  render(<ProfilePhotoField teacherId="t1" firstName="Visual" lastName="Teacher" photoId={photoId} />);
  return screen.getByLabelText('Profile photo', { selector: 'input' }) as HTMLInputElement;
}

function choose(input: HTMLInputElement, file: File) {
  fireEvent.change(input, { target: { files: [file] } });
}

describe('ProfilePhotoField', () => {
  it('uploads the chosen file as multipart and refreshes', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: { photoId: 'p1' } }), { status: 200 }));
    const input = renderField();
    choose(input, new File(['x'], 'me.jpg', { type: 'image/jpeg' }));
    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/teachers/t1/photo');
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get('photo')).toBeInstanceOf(File);
  });

  it('refuses a file over the limit without a request', async () => {
    const input = renderField();
    const big = new File([new Uint8Array(MAX_PHOTO_BYTES + 1)], 'big.jpg', { type: 'image/jpeg' });
    choose(input, big);
    expect(await screen.findByRole('alert')).toHaveTextContent(PHOTO_MESSAGES['too-large']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows the server\'s message on a refusal', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { message: PHOTO_MESSAGES['not-an-image'] } }), { status: 400 }));
    choose(renderField(), new File(['x'], 'me.jpg', { type: 'image/jpeg' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(PHOTO_MESSAGES['not-an-image']);
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it('falls back to a generic message on a non-JSON error (a proxy page)', async () => {
    fetchMock.mockResolvedValue(new Response('<html>413</html>', { status: 413 }));
    choose(renderField(), new File(['x'], 'me.jpg', { type: 'image/jpeg' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t upload that photo. Try again.');
  });

  it('removes the photo and refreshes', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: { photoId: null } }), { status: 200 }));
    renderField('p1');
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
    expect((fetchMock.mock.calls[0] as [string, RequestInit])[1].method).toBe('DELETE');
  });

  it('offers Remove only when a photo exists, and names the upload button by state', () => {
    renderField(null);
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Upload photo' })).toBeInTheDocument();
  });
});
```

Run `pnpm exec vitest run --project components src/components/settings/profile-photo-field.test.tsx` — expected: FAIL.

- [ ] **Step 4: Implement ProfilePhotoField.**

```tsx
// src/components/settings/profile-photo-field.tsx
'use client';

import { useRef, useState, type ChangeEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Avatar } from '@/components/ui/avatar';
import { readErrorMessage } from '@/lib/client-errors';
import { ACCEPTED_PHOTO_TYPES, MAX_PHOTO_BYTES, PHOTO_MESSAGES } from '@/lib/teacher-photo-limits';

interface ProfilePhotoFieldProps {
  teacherId: string;
  firstName: string;
  lastName: string;
  photoId: string | null;
}

const UPLOAD_FALLBACK = 'Couldn’t upload that photo. Try again.';
const REMOVE_FALLBACK = 'Couldn’t remove the photo. Try again.';

// Saves on its own: the photo has its own endpoint, so it is not part of the
// profile form's Save.
export function ProfilePhotoField({ teacherId, firstName, lastName, photoId }: ProfilePhotoFieldProps) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<'uploading' | 'removing' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const url = `/api/teachers/${teacherId}/photo`;

  async function send(init: RequestInit, fallback: string, state: 'uploading' | 'removing') {
    setBusy(state);
    setError(null);
    try {
      const res = await fetch(url, init);
      if (!res.ok) {
        setError(await readErrorMessage(res, fallback));
        return;
      }
      router.refresh();
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setBusy(null);
    }
  }

  async function onChoose(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = ''; // choosing the same file again still fires change
    if (!file) return;
    if (file.size > MAX_PHOTO_BYTES) {
      setError(PHOTO_MESSAGES['too-large']);
      return;
    }
    const form = new FormData();
    form.append('photo', file);
    await send({ method: 'POST', body: form }, UPLOAD_FALLBACK, 'uploading');
  }

  return (
    <section className="mb-8">
      <div className="flex items-center gap-4">
        <Avatar firstName={firstName} lastName={lastName} photoId={photoId} size={72} />
        <div className="flex flex-col items-start gap-1">
          <input
            ref={inputRef}
            id="profile-photo"
            type="file"
            accept={ACCEPTED_PHOTO_TYPES}
            aria-label="Profile photo"
            className="sr-only"
            onChange={onChoose}
            disabled={busy !== null}
          />
          <button
            type="button"
            className="type-label text-teal"
            onClick={() => inputRef.current?.click()}
            disabled={busy !== null}
          >
            {busy === 'uploading' ? 'Uploading…' : photoId === null ? 'Upload photo' : 'Replace photo'}
          </button>
          {photoId !== null && (
            <button
              type="button"
              className="type-caption"
              onClick={() => send({ method: 'DELETE' }, REMOVE_FALLBACK, 'removing')}
              disabled={busy !== null}
            >
              Remove
            </button>
          )}
        </div>
      </div>
      {error && <p role="alert" className="type-caption text-danger mt-2">{error}</p>}
    </section>
  );
}
```

Match the button classes to the nearest existing text-button pattern in `src/components/settings/` (read `profile-form.tsx` and one other settings component first) — the classes above are a starting point, not a design decision. Run the tests — expected: PASS. Mutation: delete the `file.size > MAX_PHOTO_BYTES` block → "refuses a file over the limit" fails. Restore.

- [ ] **Step 5: Placements.**
  - `src/app/(teacher)/settings/profile/page.tsx`: the teacher read gains `include: { photo: { select: { id: true } } }`; render `<ProfilePhotoField teacherId={teacher.id} firstName={teacher.firstName} lastName={teacher.lastName} photoId={teacher.photo?.id ?? null} />` between `PageHeader` and `ProfileForm`.
  - `src/app/(teacher)/schedule/page.tsx`: the teacher `select` gains `firstName: true, lastName: true, photo: { select: { id: true } }`. In the header, wrap the title block:

```tsx
        <div className="flex items-center gap-3 min-w-0">
          <Link href="/settings/profile" aria-label="Profile" className="shrink-0 no-underline">
            <Avatar firstName={teacher.firstName} lastName={teacher.lastName} photoId={teacher.photo?.id ?? null} size={40} />
          </Link>
          <div>
            <h1 className="type-display">Schedule</h1>
            <p className="type-caption mt-1">{formatDayHeader(startOfLocalDay(now, session.defaultTimezone))}</p>
          </div>
        </div>
```

  Keep `+ Add class` aligned with the title as today (adjust the outer container's alignment only if the screenshot shows it drift).
  - `src/app/(public)/[slug]/page.tsx`: the `select` gains `photo: { select: { id: true } }`; replace the h1 + bio with:

```tsx
      <div className="flex items-start gap-4">
        <Avatar firstName={teacher.firstName} lastName={teacher.lastName} photoId={teacher.photo?.id ?? null} size={72} />
        <div className="min-w-0">
          <h1 className="type-display">
            {teacher.firstName} {teacher.lastName}
          </h1>
          {teacher.bio && <p className="type-body mt-2 max-w-[480px]">{teacher.bio}</p>}
        </div>
      </div>
```

- [ ] **Step 6: e2e.** `tests/e2e/teacher-photo.spec.ts`, following `tests/e2e/class-edit.spec.ts`'s shape (import `test`/`expect` from `./fixtures`; seed teacher + `seedSession`; `context.addCookies([sessionCookie(token)])`; ids collected for teardown):

```ts
test('a teacher uploads a photo and students see it on the public page', async ({ page }) => {
  const jpeg = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#1A5653' } }).jpeg().toBuffer();
  await page.goto('/settings/profile');
  await page.getByLabel('Profile photo').setInputFiles({ name: 'me.jpg', mimeType: 'image/jpeg', buffer: jpeg });
  await expect(page.getByRole('button', { name: 'Replace photo' })).toBeVisible();
  await page.goto(`/${slug}`);
  await expect(page.locator('img[src^="/api/teacher-photos/"]')).toBeVisible();
});
```

Run `pnpm exec playwright test tests/e2e/teacher-photo.spec.ts` — expected: PASS.

- [ ] **Step 7: Design brief.** `docs/design-brief.md`: an Avatar entry in the components section — circle, sizes 40 (Schedule header) and 72 (public page, profile settings), photo `object-cover` or initials in teal Georgia bold on teal-tint, no ring/border/shadow/hover, empty alt beside a visible name, not used in directory rows (text-first).

- [ ] **Step 8: Full checks.** `pnpm run typecheck`, `pnpm run lint` (expect no new warnings — in particular no `no-img-element`), `pnpm exec vitest run --project components`.

- [ ] **Step 9: Visual baselines.** `pnpm exec playwright test visual --update-snapshots` (darwin). Expected: only `public-page` and `schedule` baselines change (the seeded teacher is "Visual Teacher", so both render "VT" initials). Open both new PNGs and check them at 100%: round, teal-tint, teal initials, no ring; header alignment intact. Any other baseline changing is a finding — stop and report. Then `pnpm run check-visual-baseline-freshness` passes.

- [ ] **Step 10: Commit.**

```bash
git add src/components/ui/avatar.tsx src/components/ui/avatar.test.tsx src/components/settings/profile-photo-field.tsx src/components/settings/profile-photo-field.test.tsx "src/app/(teacher)/schedule/page.tsx" "src/app/(public)/[slug]/page.tsx" "src/app/(teacher)/settings/profile/page.tsx" tests/e2e/teacher-photo.spec.ts docs/design-brief.md tests/e2e/visual.spec.ts-snapshots/public-page-chromium-darwin.png tests/e2e/visual.spec.ts-snapshots/public-page-Mobile-Chrome-darwin.png tests/e2e/visual.spec.ts-snapshots/schedule-chromium-darwin.png tests/e2e/visual.spec.ts-snapshots/schedule-Mobile-Chrome-darwin.png
git commit -m "feat(teacher-photo): Avatar primitive, upload control, public page and schedule placements (#46)"
```

---

## After Task 5 (controller)

Whole-branch review (5 tasks) → one fix wave → one scoped re-review; `pnpm run verify` green in the worktree; push; PR; `/pr-review-toolkit:review-pr`. The PR body records: the premise table's corrections; the pin-bite error texts from Tasks 1, 2, 3 and 4; the Docker/sharp verification output; the integration files this branch adds (`tests/integration/teacher-photo-api.test.ts`); **#136 is unaffected** (closed; this finishes the pin it deferred).
