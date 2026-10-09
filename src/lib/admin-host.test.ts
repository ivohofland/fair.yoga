import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { REDIRECT_MAX_LENGTH } from './safe-path';
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

describe('adminHost, malformed or colliding settings', () => {
  it.each([
    'https://admin.fair.yoga',
    'admin.fair.yoga/admin',
    'admin.fair.yoga/',
    'admin fair.yoga',
    'admin.fair.yoga:',
    'admin.fair.yoga:abc',
    'admin_fair.yoga',
    '//admin.fair.yoga',
  ])('treats %j as off', (value) => {
    vi.stubEnv('ADMIN_HOST', value);
    expect(adminHost()).toBeNull();
    expect(isAdminHost(value)).toBe(false);
    expect(adminOrigin()).toBeNull();
  });

  it('accepts host and host:port', () => {
    vi.stubEnv('ADMIN_HOST', 'admin-1.fair.yoga');
    expect(adminHost()).toBe('admin-1.fair.yoga');
    vi.stubEnv('ADMIN_HOST', 'admin.localhost:3127');
    expect(adminHost()).toBe('admin.localhost:3127');
  });

  it('is off when it equals the host of the app URL', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://fair.yoga');
    vi.stubEnv('ADMIN_HOST', 'fair.yoga');
    expect(adminHost()).toBeNull();
  });

  it('is off when it equals the default app host', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '');
    vi.stubEnv('ADMIN_HOST', 'localhost:3000');
    expect(adminHost()).toBeNull();
  });

  it('is off when it equals the app host in a different case', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3127');
    vi.stubEnv('ADMIN_HOST', 'LOCALHOST:3127');
    expect(adminHost()).toBeNull();
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

  it('is null, not a throw, when the app URL does not parse', () => {
    vi.stubEnv('ADMIN_HOST', 'admin.fair.yoga');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'not a url');
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
    expect(adminReturnPath('/admin?x=1')).toBe('/admin?x=1');
  });

  it('refuses sign-in itself, with or without a query', () => {
    expect(adminReturnPath('/admin/sign-in?redirect=%2Fadmin')).toBe('/admin');
  });

  it('takes the first of a repeated parameter', () => {
    expect(adminReturnPath(['/admin/rooms', '/schedule'])).toBe('/admin/rooms');
    expect(adminReturnPath(['/schedule', '/admin/rooms'])).toBe('/admin');
    expect(adminReturnPath([])).toBe('/admin');
  });

  it('falls back when longer than the redirect schema accepts', () => {
    const atLimit = `/admin/${'a'.repeat(REDIRECT_MAX_LENGTH - '/admin/'.length)}`;
    expect(adminReturnPath(atLimit)).toBe(atLimit);
    expect(adminReturnPath(`${atLimit}a`)).toBe('/admin');
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
