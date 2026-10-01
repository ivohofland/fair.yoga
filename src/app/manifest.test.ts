import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import manifest from './manifest';

function pngSize(file: string): string {
  const buf = readFileSync(file);
  // Bytes 1–3 of every PNG are "PNG"; the IHDR chunk's width and height are
  // big-endian at offsets 16 and 20.
  expect(buf.subarray(1, 4).toString('ascii')).toBe('PNG');
  return `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`;
}

describe('manifest', () => {
  const m = manifest();

  it('opens standalone at /start', () => {
    expect(m).toMatchObject({ id: '/start', start_url: '/start', scope: '/', display: 'standalone' });
  });

  it('uses the cream page token for both theme and background', () => {
    const css = readFileSync(path.join(process.cwd(), 'src/app/globals.css'), 'utf8');
    expect(css).toContain(`--color-cream: ${m.theme_color};`);
    expect(m.background_color).toBe(m.theme_color);
  });

  it('lists 192 and 512 any-purpose icons and a 512 maskable one', () => {
    expect((m.icons ?? []).map((i) => `${i.sizes} ${i.purpose}`)).toEqual([
      '192x192 any',
      '512x512 any',
      '512x512 maskable',
    ]);
  });

  it.each(m.icons ?? [])('ships $src at the size it claims', (icon) => {
    expect(pngSize(path.join(process.cwd(), 'public', icon.src))).toBe(icon.sizes);
  });
});
