import { request as httpRequest, type ClientRequest } from 'node:http';
import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import sharp from 'sharp';
import { BASE_URL, cookie, uniqueSuffix, seedSession } from '../helpers';
import { expectApplied, expectUnchanged } from '../api-assertions';
import { PHOTO_MESSAGES } from '@/lib/teacher-photo-limits';

const prisma = new PrismaClient();
const teacherIds: string[] = [];
const accountIds: string[] = [];
const studentIds: string[] = [];

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

/** A student-only session: an Account carrying a Student and no Teacher. */
async function makeStudentOnly(): Promise<{ token: string }> {
  const s = uniqueSuffix();
  const email = `photo-route-student-${s}@test.local`;
  const student = await prisma.student.create({
    data: { firstName: 'Photo', lastName: 'Student', email, claimedAt: new Date(), account: { create: { email } } },
  });
  const accountId = student.accountId as string;
  studentIds.push(student.id);
  accountIds.push(accountId);
  return { token: await seedSession(prisma, accountId) };
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

afterAll(async () => {
  await prisma.session.deleteMany({ where: { accountId: { in: accountIds } } });
  if (teacherIds.length > 0) {
    await prisma.teacher.deleteMany({ where: { id: { in: teacherIds } } });
  }
  if (studentIds.length > 0) {
    await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
  }
  if (accountIds.length > 0) {
    await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  }
});

describe('POST /api/teachers/[id]/photo', () => {
  it('rejects an unauthenticated upload and writes no row', async () => {
    const teacher = await makeTeacher();
    const res = await upload(teacher.id, null, await jpeg());
    expect(res.status).toBe(401);
    expect(await prisma.teacherPhoto.count({ where: { teacherId: teacher.id } })).toBe(0);
  });

  it('rejects another teacher’s token and writes no row', async () => {
    const teacher = await makeTeacher();
    const other = await makeTeacher();
    const res = await upload(teacher.id, other.token, await jpeg());
    expect(res.status).toBe(403);
    expect(await prisma.teacherPhoto.count({ where: { teacherId: teacher.id } })).toBe(0);
  });

  it('rejects a student-only session and writes no row', async () => {
    const teacher = await makeTeacher();
    const student = await makeStudentOnly();
    const res = await upload(teacher.id, student.token, await jpeg());
    expect(res.status).toBe(403);
    expect(await prisma.teacherPhoto.count({ where: { teacherId: teacher.id } })).toBe(0);
  });

  it('accepts a JPEG, stores a 400×400 webp, and serves it publicly', async () => {
    const teacher = await makeTeacher();
    const res = await upload(teacher.id, teacher.token, await jpeg());
    const data = (await expectApplied(res)) as { photoId: string };
    expect(typeof data.photoId).toBe('string');

    const getRes = await fetch(`${BASE_URL}/api/teacher-photos/${data.photoId}`);
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get('content-type')).toBe('image/webp');
    expect(getRes.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    const bytes = new Uint8Array(await getRes.arrayBuffer());
    const meta = await sharp(bytes).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(400);
    expect(meta.height).toBe(400);
  });

  it('replaces the photo on a second upload — old id 404s', async () => {
    const teacher = await makeTeacher();
    const first = (await expectApplied(await upload(teacher.id, teacher.token, await jpeg()))) as {
      photoId: string;
    };
    const second = (await expectApplied(await upload(teacher.id, teacher.token, await jpeg()))) as {
      photoId: string;
    };
    expect(second.photoId).not.toBe(first.photoId);

    const oldRes = await fetch(`${BASE_URL}/api/teacher-photos/${first.photoId}`);
    expect(oldRes.status).toBe(404);
  });

  it('refuses a 9 MB blob as too-large', async () => {
    const teacher = await makeTeacher();
    const big = new Blob([new Uint8Array(9 * 1024 * 1024)], { type: 'image/jpeg' });
    const res = await upload(teacher.id, teacher.token, big);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe(PHOTO_MESSAGES['too-large']);
  });

  it('refuses a text file lying about its MIME type', async () => {
    const teacher = await makeTeacher();
    const fake = new Blob(['hello'], { type: 'image/jpeg' });
    const res = await upload(teacher.id, teacher.token, fake);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe(PHOTO_MESSAGES['not-an-image']);
  });

  it('refuses a form with no photo field', async () => {
    const teacher = await makeTeacher();
    const res = await upload(teacher.id, teacher.token, null);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe(PHOTO_MESSAGES['no-photo']);
  });

  it('refuses a JSON body as no-photo', async () => {
    const teacher = await makeTeacher();
    const res = await fetch(`${BASE_URL}/api/teachers/${teacher.id}/photo`, {
      method: 'POST',
      headers: { ...cookie(teacher.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe(PHOTO_MESSAGES['no-photo']);
  });

  it('refuses a body with no Content-Length as no-photo, before the body is read', async () => {
    // Node's fetch sends a chunked body (no Content-Length header) for a
    // ReadableStream body with duplex: 'half'. Not driveable through
    // FormData directly, so this constructs the multipart body by hand.
    const boundary = `----photoTestBoundary${uniqueSuffix()}`;
    const fileBytes = await jpeg().then((b) => b.arrayBuffer());
    const parts = [
      `--${boundary}\r\n`,
      'Content-Disposition: form-data; name="photo"; filename="me.jpg"\r\n',
      'Content-Type: image/jpeg\r\n\r\n',
    ];
    const head = new TextEncoder().encode(parts.join(''));
    const tail = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
    const bodyBytes = new Uint8Array(head.length + fileBytes.byteLength + tail.length);
    bodyBytes.set(head, 0);
    bodyBytes.set(new Uint8Array(fileBytes), head.length);
    bodyBytes.set(tail, head.length + fileBytes.byteLength);

    const teacher = await makeTeacher();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bodyBytes);
        controller.close();
      },
    });

    let res: Response;
    try {
      res = await fetch(`${BASE_URL}/api/teachers/${teacher.id}/photo`, {
        method: 'POST',
        headers: { ...cookie(teacher.token), 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body: stream,
        // @ts-expect-error -- required by Node's fetch for a streaming body, not in the DOM lib types
        duplex: 'half',
      });
    } catch (err) {
      // A thrown fetch here is not an expected "unsupported environment"
      // case to route around — this environment's fetch has always been able
      // to send a streaming body with no Content-Length. `toBeUndefined()`
      // fails the test loudly, naming the error, rather than skipping it.
      expect(err).toBeUndefined();
      return;
    }
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe(PHOTO_MESSAGES['no-photo']);
  });

  it('refuses an oversized declared length while the body is still unfinished', async () => {
    // A layer that buffers the body before the route runs would wait on bytes
    // that never arrive; the route's own refusal needs only the headers.
    const teacher = await makeTeacher();
    const url = new URL(`${BASE_URL}/api/teachers/${teacher.id}/photo`);
    let req: ClientRequest | undefined;
    const outcome = await new Promise<{ status: number; message: string } | 'no-response'>((resolve) => {
      const timer = setTimeout(() => resolve('no-response'), 4000);
      req = httpRequest(
        {
          hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST',
          headers: {
            ...cookie(teacher.token),
            'Content-Type': 'multipart/form-data; boundary=x',
            'Content-Length': String(50 * 1024 * 1024),
          },
        },
        (res) => {
          let raw = '';
          res.on('data', (c: Buffer) => { raw += c.toString(); });
          res.on('end', () => {
            clearTimeout(timer);
            const parsed = JSON.parse(raw) as { error: { message: string } };
            resolve({ status: res.statusCode ?? 0, message: parsed.error.message });
          });
        },
      );
      req.on('error', () => undefined);
      req.write('--x\r\n');
    });
    req?.destroy();
    expect(outcome).toEqual({ status: 400, message: PHOTO_MESSAGES['too-large'] });
  });
});

describe('DELETE /api/teachers/[id]/photo', () => {
  it('removes the photo, answers unchanged on a repeat, and refuses another teacher', async () => {
    const teacher = await makeTeacher();
    const other = await makeTeacher();
    await expectApplied(await upload(teacher.id, teacher.token, await jpeg()));

    const res = await fetch(`${BASE_URL}/api/teachers/${teacher.id}/photo`, {
      method: 'DELETE',
      headers: cookie(teacher.token),
    });
    expect(await expectApplied(res)).toEqual({ photoId: null });

    const again = await fetch(`${BASE_URL}/api/teachers/${teacher.id}/photo`, {
      method: 'DELETE',
      headers: cookie(teacher.token),
    });
    expect(await expectUnchanged(again)).toEqual({ photoId: null });

    // Another teacher's photo is untouched by an owner-scoped delete attempt.
    const uploaded = (await expectApplied(await upload(other.id, other.token, await jpeg()))) as {
      photoId: string;
    };
    const forbidden = await fetch(`${BASE_URL}/api/teachers/${other.id}/photo`, {
      method: 'DELETE',
      headers: cookie(teacher.token),
    });
    expect(forbidden.status).toBe(403);
    const stillThere = await fetch(`${BASE_URL}/api/teacher-photos/${uploaded.photoId}`);
    expect(stillThere.status).toBe(200);
  });
});

describe('teacher-photo rate limit', () => {
  it('allows 10 uploads then refuses the 11th', async () => {
    const teacher = await makeTeacher();
    for (let i = 0; i < 10; i++) {
      const res = await upload(teacher.id, teacher.token, await jpeg());
      await expectApplied(res);
    }
    const eleventh = await upload(teacher.id, teacher.token, await jpeg());
    expect(eleventh.status).toBe(429);
  }, 30_000);
});

describe('erasure removes the photo', () => {
  it('DELETE /api/account deletes the row and 404s the old URL', async () => {
    const teacher = await makeTeacher();
    const uploaded = (await expectApplied(await upload(teacher.id, teacher.token, await jpeg()))) as {
      photoId: string;
    };

    const res = await fetch(`${BASE_URL}/api/account`, {
      method: 'DELETE',
      headers: cookie(teacher.token),
    });
    expect(await expectApplied(res)).toEqual({ deleted: true });

    expect(await prisma.teacherPhoto.count({ where: { teacherId: teacher.id } })).toBe(0);
    const oldRes = await fetch(`${BASE_URL}/api/teacher-photos/${uploaded.photoId}`);
    expect(oldRes.status).toBe(404);
  });
});

describe('export carries the photo', () => {
  it('GET /api/account/export includes the served bytes as webp base64', async () => {
    const teacher = await makeTeacher();
    const uploaded = (await expectApplied(await upload(teacher.id, teacher.token, await jpeg()))) as {
      photoId: string;
    };
    const servedRes = await fetch(`${BASE_URL}/api/teacher-photos/${uploaded.photoId}`);
    const servedBytes = Buffer.from(await servedRes.arrayBuffer());

    const res = await fetch(`${BASE_URL}/api/account/export`, { headers: cookie(teacher.token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { profile: { photo: { contentType: string; base64: string } } };
    expect(body.profile.photo.contentType).toBe('image/webp');
    expect(Buffer.from(body.profile.photo.base64, 'base64').equals(servedBytes)).toBe(true);
  });
});
