import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

describe('the offline disabled look', () => {
  it('is a rule in globals.css keyed on the snapshot fieldset attribute', () => {
    const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');
    const rule = /fieldset\[data-offline-fieldset\]:disabled :is\(button, input, select, textarea\):disabled\s*\{([^}]*)\}/.exec(css);
    expect(rule).not.toBeNull();
    expect(rule?.[1]).toMatch(/opacity:\s*0\.5/);
    expect(rule?.[1]).toMatch(/cursor:\s*not-allowed/);
  });
});
