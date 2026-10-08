import { describe, it, expect } from 'vitest';
import { buildPageCsp, API_CSP, SERVICE_WORKER_CSP } from './csp';

function directive(csp: string, name: string): string | undefined {
  return csp.split('; ').find((d) => d === name || d.startsWith(`${name} `));
}

describe('buildPageCsp', () => {
  it('allows scripts only by nonce and strict-dynamic in production', () => {
    const csp = buildPageCsp('abc123', false);
    expect(directive(csp, 'script-src')).toBe("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
  });

  it('adds unsafe-eval and ws: in development only', () => {
    const csp = buildPageCsp('abc123', true);
    expect(directive(csp, 'script-src')).toBe("script-src 'self' 'nonce-abc123' 'strict-dynamic' 'unsafe-eval'");
    expect(directive(csp, 'connect-src')).toBe("connect-src 'self' ws:");
    expect(directive(buildPageCsp('n', false), 'connect-src')).toBe("connect-src 'self'");
  });

  it('never puts unsafe-inline in script-src, keeps it in style-src', () => {
    for (const isDev of [true, false]) {
      const csp = buildPageCsp('n', isDev);
      expect(directive(csp, 'script-src')).not.toContain("'unsafe-inline'");
      expect(directive(csp, 'style-src')).toBe("style-src 'self' 'unsafe-inline'");
    }
  });

  it('keeps every other directive', () => {
    const csp = buildPageCsp('n', false);
    for (const d of [
      "default-src 'self'",
      "img-src 'self' data: blob:",
      "font-src 'self'",
      "worker-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ]) {
      expect(csp.split('; ')).toContain(d);
    }
  });
});

describe('API_CSP', () => {
  it('lets a JSON response load and run nothing', () => {
    expect(API_CSP).toBe("default-src 'none'; frame-ancestors 'none'");
  });
});

describe('SERVICE_WORKER_CSP', () => {
  it('lets the worker fetch same-origin only', () => {
    expect(SERVICE_WORKER_CSP).toBe("default-src 'self'");
  });
});
