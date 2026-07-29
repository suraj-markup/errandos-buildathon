import type { ReactNode } from 'react';
import { VoiceOrderConsole } from '../components/voice-order-console';

export const dynamic = 'force-dynamic';

export default function Home(): ReactNode {
  return (
    <VoiceOrderConsole
      publicCartHandoff={process.env['ERRANDOS_PUBLIC_CART_HANDOFF'] === 'true'}
    />
  );
}
