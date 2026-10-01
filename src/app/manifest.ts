import type { MetadataRoute } from 'next';

/** `--color-cream` in globals.css, the page background: the status bar and
 *  the splash screen then read as the page itself. */
export const THEME_COLOR = '#F7F4EF';

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/start',
    name: 'fair.yoga',
    short_name: 'fair.yoga',
    description: 'Ethical pricing for independent yoga teachers',
    start_url: '/start',
    scope: '/',
    display: 'standalone',
    background_color: THEME_COLOR,
    theme_color: THEME_COLOR,
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
