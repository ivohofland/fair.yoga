export type EmbedSnippetOptions = {
  origin: string;
  key: string;
  slug: string;
  theme: 'themed' | 'unstyled';
  colorScheme: 'light' | 'dark' | 'auto';
};

/** The code a teacher pastes into their site. The link inside the element is what shows if the script never runs. */
export function buildEmbedSnippet(o: EmbedSnippetOptions): string {
  const scheme = o.theme === 'themed' ? ` color-scheme="${o.colorScheme}"` : '';
  return [
    `<script type="module" src="${o.origin}/embed/v1.js"></script>`,
    `<fair-yoga-schedule key="${o.key}" theme="${o.theme}"${scheme}>`,
    `  <a href="${o.origin}/${o.slug}">See my schedule</a>`,
    '</fair-yoga-schedule>',
  ].join('\n');
}
