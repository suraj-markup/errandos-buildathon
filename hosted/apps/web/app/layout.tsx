import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'JaldiAI Voice — Speak it. Review it. Get it done.',
  description: 'A multilingual, transaction-safe voice interface for everyday errands in India.',
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>): ReactNode {
  return <html lang="en-IN"><body>{children}</body></html>;
}
