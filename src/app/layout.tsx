import type { Metadata } from 'next';
import { Atkinson_Hyperlegible } from 'next/font/google';
import './globals.css';

const atkinson = Atkinson_Hyperlegible({
  subsets: ['latin'],
  weight: ['400', '700'],
  variable: '--font-atkinson',
});

export const metadata: Metadata = {
  title: 'fair.yoga',
  description: 'Ethical pricing for independent yoga teachers',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`h-full antialiased ${atkinson.variable}`}>
      <body className="min-h-full flex flex-col">
        <div className="mx-auto w-full max-w-lg px-6 pt-8 pb-12 flex-1 flex flex-col">
          {children}
        </div>
      </body>
    </html>
  );
}
