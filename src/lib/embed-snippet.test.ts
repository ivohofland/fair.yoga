import { describe, it, expect } from 'vitest';
import { buildEmbedSnippet } from './embed-snippet';

const BASE = { origin: 'https://fair.yoga', key: 'k7Qm2xR9vT', slug: 'anna' } as const;

describe('buildEmbedSnippet', () => {
  it('writes the module script, the element with its look, and the fallback link', () => {
    expect(buildEmbedSnippet({ ...BASE, theme: 'themed', colorScheme: 'auto' })).toBe(
      [
        '<script type="module" src="https://fair.yoga/embed/v1.js"></script>',
        '<fair-yoga-schedule schedule-key="k7Qm2xR9vT" theme="themed" color-scheme="auto">',
        '  <a href="https://fair.yoga/anna">See my schedule</a>',
        '</fair-yoga-schedule>',
      ].join('\n'),
    );
  });

  it('names no attribute React reserves, so the snippet survives being pasted into JSX', () => {
    const snippet = buildEmbedSnippet({ ...BASE, theme: 'themed', colorScheme: 'auto' });
    expect(snippet).not.toMatch(/\s(key|ref)=/);
  });

  it('carries the chosen colour scheme', () => {
    expect(buildEmbedSnippet({ ...BASE, theme: 'themed', colorScheme: 'light' })).toContain('color-scheme="light"');
    expect(buildEmbedSnippet({ ...BASE, theme: 'themed', colorScheme: 'dark' })).toContain('color-scheme="dark"');
  });

  it('leaves color-scheme out for the unstyled list, which has no colours of its own', () => {
    const snippet = buildEmbedSnippet({ ...BASE, theme: 'unstyled', colorScheme: 'auto' });
    expect(snippet).not.toContain('color-scheme');
    expect(snippet).toContain('theme="unstyled"');
  });

  it('escapes markup characters in the origin, key and slug', () => {
    const snippet = buildEmbedSnippet({
      origin: 'https://fair.yoga',
      key: 'a"b<c>&d',
      slug: 'x"><script>',
      theme: 'themed',
      colorScheme: 'light',
    });
    expect(snippet).toContain('schedule-key="a&quot;b&lt;c&gt;&amp;d"');
    expect(snippet).toContain('href="https://fair.yoga/x&quot;&gt;&lt;script&gt;"');
    expect(snippet).not.toContain('<script>');
  });
});
