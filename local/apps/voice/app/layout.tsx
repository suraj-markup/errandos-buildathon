import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './styles.css';

export const metadata: Metadata = {
  applicationName: 'ErrandOS',
  description: 'A tiny voice companion for safe, real-world errands.',
  manifest: '/manifest.webmanifest',
  title: 'ErrandOS — your pocket errand buddy',
};

export const viewport: Viewport = {
  colorScheme: 'light',
  initialScale: 1,
  maximumScale: 1,
  themeColor: '#fffdf6',
  userScalable: false,
  width: 'device-width',
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>): ReactNode {
  return (
    <html lang="en-IN">
      <body>{children}</body>
    </html>
  );
}
