import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { adminHost, isAdminHost, adminOrigin, isAdminPath, adminReturnPath } from './admin-host';

afterEach(() => vi.unstubAllEnvs());

describe('adminHost / isAdminHost', () => {
  it('is off when ADMIN_HOST is unset or blank', () => {
    vi.stubEnv('ADMIN_HOST', '');
    expect(adminHost()).toBeNull();
    expect(isAdminHost('admin.localhost:3000')).toBe(false);
  });

  it('matches the Host header case-insensitively, trimming the setting', () => {
    vi.stubEnv('ADMIN_HOST', ' Admin.Localhost:3000 ');
    expect(isAdminHost('admin.localhost:3000')).toBe(true);
    expect(isAdminHost('ADMIN.LOCALHOST:3000')).toBe(true);
  });

  it('does not match another port, the main host, or a missing header', () => {
    vi.stubEnv('ADMIN_HOST', 'admin.localhost:3000');
    expect(isAdminHost('admin.localhost:3001')).toBe(false);
    expect(isAdminHost('localhost:3000')).toBe(false);
    expect(isAdminHost(null)).toBe(false);
  });
});

describe('adminOrigin', () => {
  it('borrows the app URL scheme', () => {
    vi.stubEnv('ADMIN_HOST', 'admin.fair.yoga');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://fair.yoga');
    expect(adminOrigin()).toBe('https://admin.fair.yoga');
  });

  it('is null when the surface is off', () => {
    vi.stubEnv('ADMIN_HOST', '');
    expect(adminOrigin()).toBeNull();
  });
});

describe('isAdminPath', () => {
  it('is /admin and below, not a lookalike', () => {
    expect(isAdminPath('/admin')).toBe(true);
    expect(isAdminPath('/admin/sign-in')).toBe(true);
    expect(isAdminPath('/administrator')).toBe(false);
    expect(isAdminPath('/')).toBe(false);
  });
});

describe('adminReturnPath', () => {
  it('keeps a safe path inside the admin tree', () => {
    expect(adminReturnPath('/admin')).toBe('/admin');
    expect(adminReturnPath('/admin/rooms?x=1')).toBe('/admin/rooms?x=1');
  });

  it('falls back to /admin for anything else', () => {
    for (const raw of [undefined, '', 'https://evil.example/admin', '//evil.example/admin', '/schedule', '/administrator', '/admin/sign-in']) {
      expect(adminReturnPath(raw)).toBe('/admin');
    }
  });
});

describe('proxy-weight imports', () => {
  function importSpecifiers(file: string): string[] {
    const source = readFileSync(path.resolve(__dirname, file), 'utf8');
    return [...source.matchAll(/^import\s[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1] ?? '');
  }

  it('admin-host reaches only the dependency-free path guard', () => {
    const specifiers = importSpecifiers('admin-host.ts');
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.every((s) => s === '@/lib/safe-path')).toBe(true);
  });

  it('safe-path imports nothing', () => {
    expect(importSpecifiers('safe-path.ts')).toEqual([]);
  });
});
