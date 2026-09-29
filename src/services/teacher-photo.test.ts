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
