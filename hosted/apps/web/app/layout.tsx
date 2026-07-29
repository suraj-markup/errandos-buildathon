import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'JaldiAI — Personal errands by voice or chat',
  description: 'A multilingual, transaction-safe voice interface for everyday errands in India.',
};

export const viewport = {
  themeColor: '#102f3c',
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>): ReactNode {
  return <html lang="en-IN"><body>{children}</body></html>;
}
