import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'fair.yoga',
  description: 'Ethical pricing for independent yoga teachers',
};

// viewportFit: 'cover' is required for env(safe-area-inset-bottom) to be
// non-zero on iOS — the bottom tab bar pads itself above the home indicator.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // suppressHydrationWarning is one element deep only: it absorbs attributes
  // browser extensions (e.g. Tag Assistant) inject into <html> before
  // hydration, without hiding real mismatches in the tree below.
  return (
    <html lang="en" className="h-full antialiased" suppressHydrationWarning>
      <body className="min-h-full flex flex-col">
        <div className="mx-auto w-full max-w-content px-4 sm:px-6 pt-6 pb-8 flex-1 flex flex-col">
          {children}
        </div>
      </body>
    </html>
  );
}
