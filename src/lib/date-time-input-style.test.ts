import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

describe('the date and time field look', () => {
  const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');

  it('drops the native appearance so iOS honours the field height', () => {
    const rule = /input\[type="date"\],\s*input\[type="time"\]\s*\{([^}]*)\}/.exec(css);
    expect(rule).not.toBeNull();
    expect(rule?.[1]).toMatch(/-webkit-appearance:\s*none/);
    expect(rule?.[1]).toMatch(/(^|[^-])appearance:\s*none/);
  });

  it('left-aligns the value as text fields do', () => {
    const rule = /input::-webkit-date-and-time-value\s*\{([^}]*)\}/.exec(css);
    expect(rule).not.toBeNull();
    expect(rule?.[1]).toMatch(/text-align:\s*left/);
  });
});
