export type EmbedSnippetOptions = {
  origin: string;
  key: string;
  slug: string;
  theme: 'themed' | 'unstyled';
  colorScheme: 'light' | 'dark' | 'auto';
};

const ESCAPES: Record<string, string> = { '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' };
const esc = (value: string): string => value.replace(/[&"<>]/g, (c) => ESCAPES[c] ?? c);

/** The code a teacher pastes into their site. The link inside the element is what shows if the script never runs. */
export function buildEmbedSnippet(o: EmbedSnippetOptions): string {
  const scheme = o.theme === 'themed' ? ` color-scheme="${o.colorScheme}"` : '';
  return [
    `<script type="module" src="${esc(o.origin)}/embed/v1.js"></script>`,
    `<fair-yoga-schedule schedule-key="${esc(o.key)}" theme="${o.theme}"${scheme}>`,
    `  <a href="${esc(o.origin)}/${esc(o.slug)}">See my schedule</a>`,
    '</fair-yoga-schedule>',
  ].join('\n');
}
