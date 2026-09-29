import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { crc32, deflateSync } from 'node:zlib';
import { PrismaClient } from '@prisma/client';
import {
  processTeacherPhoto,
  PHOTO_EDGE_PX,
  saveTeacherPhoto,
  removeTeacherPhoto,
  readTeacherPhoto,
} from './teacher-photo';
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

  it('refuses an unknown teacher and writes nothing', async () => {
    const teacherId = randomUUID();
    expect(await saveTeacherPhoto(prisma, teacherId, bytes)).toEqual({ saved: false, reason: 'teacher-gone' });
    expect(await prisma.teacherPhoto.count({ where: { teacherId } })).toBe(0);
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
