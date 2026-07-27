'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type VoiceState =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'thinking'
  | 'acting'
  | 'speaking'
  | 'error';

type GroceryOption = {
  product?: string;
  price?: string;
  size?: string;
};

type CheckoutSnapshot = {
  addressLabel?: string;
  fingerprint?: string;
  itemCount?: number;
  itemNames?: string[];
  paymentMode?: string;
  total?: number;
};

type ToolResult = {
  checkout?: CheckoutSnapshot;
  message?: string;
  ok?: boolean;
  options?: GroceryOption[];
  price?: string;
  product?: string;
  providerReference?: string;
  quantity?: string;
  request?: string;
  size?: string;
  status?: string;
};

type VoiceTurnResponse = {
  assistantState?: string;
  audioBase64?: string;
  audioType?: string;
  error?: string;
  languageCode?: string;
  ok?: boolean;
  reply?: string;
  toolEvents?: string[];
  toolResults?: ToolResult[];
  transcript?: string;
};

const stateCopy: Record<VoiceState, { kicker: string; title: string; hint: string }> = {
  acting: {
    hint: 'I’ll show what changed when it is verified.',
    kicker: 'WORKING IN BLINKIT',
    title: 'On it.',
  },
  connecting: {
    hint: 'Your microphone stays on this device.',
    kicker: 'OPENING THE MIC',
    title: 'One sec.',
  },
  error: {
    hint: 'Tap the buddy to try that again.',
    kicker: 'I HIT A SNAG',
    title: 'Still here.',
  },
  idle: {
    hint: 'Ask in English, Hindi, Hinglish, or your language.',
    kicker: 'YOUR POCKET ERRAND BUDDY',
    title: 'What should we get?',
  },
  listening: {
    hint: 'Tap again when you’re done.',
    kicker: 'I’M LISTENING',
    title: 'Tell me.',
  },
  speaking: {
    hint: 'You can interrupt with another tap when I finish.',
    kicker: 'JALDIAI SAYS',
    title: 'Here’s the update.',
  },
  thinking: {
    hint: 'Matching your words to a safe phone action.',
    kicker: 'MAKING A PLAN',
    title: 'Let me think.',
  },
};

const eventLabels: Record<string, string> = {
  confirm_cod_order: 'Confirming the reviewed order',
  open_blinkit: 'Opening Blinkit',
  phone_status: 'Checking your Pixel',
  prepare_cod_checkout: 'Reading exact checkout terms',
  prepare_grocery: 'Finding the exact product',
};

function preferredAudioType(): string | undefined {
  for (const type of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return undefined;
}

function MicIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <rect x="8" y="3" width="8" height="12" rx="4" />
      <path d="M5 11.5a7 7 0 0 0 14 0M12 18.5V22M8.5 22h7" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <rect x="5" y="10" width="14" height="11" rx="3" />
      <path d="M8.5 10V7.5a3.5 3.5 0 0 1 7 0V10" />
    </svg>
  );
}

function SparkIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M12 2c.7 5.4 4.6 9.3 10 10-5.4.7-9.3 4.6-10 10-.7-5.4-4.6-9.3-10-10 5.4-.7 9.3-4.6 10-10Z" />
    </svg>
  );
}

function ResultSheet({ result }: { result?: ToolResult }) {
  if (!result) {
    return (
      <section className="starter-card" aria-label="How JaldiAI works">
        <div className="starter-heading">
          <span className="mini-spark"><SparkIcon /></span>
          <div>
            <p>TRY SAYING</p>
            <strong>“Add Amul Taaza milk, 500 ml.”</strong>
          </div>
        </div>
        <div className="safety-line">
          <span>find</span><i />
          <span>verify</span><i />
          <span>review</span>
        </div>
        <p className="starter-note">Broad requests pause for a choice. Checkout pauses again for exact terms.</p>
      </section>
    );
  }

  if (result.status === 'needs_clarification' && result.options?.length) {
    return (
      <section className="result-sheet choice-sheet">
        <div className="sheet-topline">
          <span>CHOOSE ONE</span>
          <span>{result.options.length} matches</span>
        </div>
        <h2>I found a few versions.</h2>
        <p className="sheet-help">Say the exact product and size you want.</p>
        <ol className="product-options">
          {result.options.map((option, index) => (
            <li key={`${option.product ?? 'product'}-${option.size ?? index}`}>
              <span className="option-number">{String(index + 1).padStart(2, '0')}</span>
              <div>
                <strong>{option.product ?? 'Blinkit product'}</strong>
                <p>{[option.size, option.price].filter(Boolean).join(' · ')}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>
    );
  }

  if (result.status === 'confirmation_required' && result.checkout) {
    const checkout = result.checkout;
    return (
      <section className="result-sheet checkout-sheet">
        <div className="sheet-topline">
          <span>READY FOR REVIEW</span>
          <span className="not-ordered">Not ordered</span>
        </div>
        <div className="checkout-total">
          <div>
            <p>Cash on delivery</p>
            <strong>₹{checkout.total?.toLocaleString('en-IN') ?? '—'}</strong>
          </div>
          <span className="lock-badge"><LockIcon /></span>
        </div>
        <dl className="checkout-facts">
          <div><dt>Deliver to</dt><dd>{checkout.addressLabel ?? 'Saved address'}</dd></div>
          <div><dt>Cart</dt><dd>{checkout.itemCount ?? checkout.itemNames?.length ?? '—'} item(s)</dd></div>
          <div><dt>Payment</dt><dd>Cash on delivery</dd></div>
        </dl>
        <div className="confirmation-phrase">
          <span>TO PLACE IT, SAY EXACTLY</span>
          <strong>“Confirm COD order”</strong>
        </div>
      </section>
    );
  }

  if (['added', 'already_in_cart'].includes(result.status ?? '')) {
    return (
      <section className="result-sheet success-sheet">
        <div className="sheet-topline">
          <span>VERIFIED IN CART</span>
          <span className="checkmark">✓</span>
        </div>
        <div className="product-result">
          <span className="bag-glyph">B</span>
          <div>
            <h2>{result.product ?? 'Item added'}</h2>
            <p>{[result.size, result.price, result.quantity].filter(Boolean).join(' · ')}</p>
          </div>
        </div>
        <p className="safe-caption">The cart changed. No order was placed.</p>
      </section>
    );
  }

  if (result.status === 'ordered') {
    return (
      <section className="result-sheet success-sheet order-sheet">
        <div className="sheet-topline">
          <span>ORDER VERIFIED</span>
          <span className="checkmark">✓</span>
        </div>
        <h2>It’s on the way.</h2>
        {result.providerReference ? <p>Reference · {result.providerReference}</p> : null}
      </section>
    );
  }

  if (result.status === 'not_found') {
    return (
      <section className="result-sheet neutral-sheet">
        <div className="sheet-topline"><span>NO EXACT MATCH</span><span>0 results</span></div>
        <h2>Let’s try another name.</h2>
        <p>{result.message ?? 'Blinkit did not return a product for that request.'}</p>
      </section>
    );
  }

  return (
    <section className="result-sheet neutral-sheet">
      <div className="sheet-topline">
        <span>{result.ok === false ? 'NEEDS ATTENTION' : 'PHONE UPDATE'}</span>
        <span>{result.status?.replaceAll('_', ' ') ?? 'complete'}</span>
      </div>
      <h2>{result.message ?? 'The phone action is complete.'}</h2>
      <p>Nothing paid happens without an exact review.</p>
    </section>
  );
}

export default function VoiceHome() {
  const [voiceState, setVoiceState] = useState<VoiceState>('idle');
  const [assistantText, setAssistantText] = useState('Tap me and say what you need.');
  const [latestTranscript, setLatestTranscript] = useState('');
  const [latestResult, setLatestResult] = useState<ToolResult | undefined>();
  const [toolEvents, setToolEvents] = useState<string[]>([]);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recordingTimerRef = useRef<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const releaseMicrophone = useCallback(() => {
    if (recordingTimerRef.current !== null) {
      window.clearTimeout(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
  }, []);

  const submitRecording = useCallback(async (audio: Blob) => {
    setVoiceState('thinking');
    setAssistantText('I heard you. Making a careful plan…');
    setToolEvents([]);

    try {
      const body = new FormData();
      const extension = audio.type.includes('mp4') ? 'm4a' : 'webm';
      body.set('audio', audio, `command.${extension}`);
      body.set('clientId', 'pixel-web');

      const response = await fetch('/api/voice/turn', {
        body,
        method: 'POST',
      });
      const result = await response.json() as VoiceTurnResponse;
      if (!response.ok || !result.ok) {
        throw new Error(result.error ?? 'The voice request failed.');
      }

      setLatestTranscript(result.transcript ?? '');
      setToolEvents(result.toolEvents ?? []);
      setLatestResult(result.toolResults?.[0]);
      setAssistantText(result.reply ?? 'Done.');
      setVoiceState(result.toolEvents?.length ? 'acting' : 'speaking');

      if (result.audioBase64) {
        const player = audioRef.current;
        if (player) {
          player.src = `data:${result.audioType ?? 'audio/mpeg'};base64,${result.audioBase64}`;
          player.onplay = () => setVoiceState('speaking');
          player.onended = () => setVoiceState('idle');
          await player.play();
          return;
        }
      }

      setVoiceState('idle');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The voice request failed.';
      setVoiceState('error');
      setAssistantText(message);
    }
  }, []);

  const stopRecording = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder?.state === 'recording') {
      setVoiceState('thinking');
      setAssistantText('Got it. Sending your voice securely…');
      recorder.stop();
    }
  }, []);

  const startRecording = useCallback(async () => {
    setVoiceState('connecting');
    setAssistantText('Opening your microphone…');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      streamRef.current = stream;
      chunksRef.current = [];

      const mimeType = preferredAudioType();
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      recorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const audio = new Blob(chunksRef.current, {
          type: recorder.mimeType || mimeType || 'audio/webm',
        });
        releaseMicrophone();
        void submitRecording(audio);
      };

      recorder.start();
      setVoiceState('listening');
      setAssistantText('I’m all ears.');
      recordingTimerRef.current = window.setTimeout(() => {
        if (recorder.state === 'recording') recorder.stop();
      }, 28_000);
    } catch (error) {
      releaseMicrophone();
      const message = error instanceof Error ? error.message : 'Could not open the microphone.';
      setVoiceState('error');
      setAssistantText(message);
    }
  }, [releaseMicrophone, submitRecording]);

  const toggleVoice = useCallback(() => {
    if (voiceState === 'listening') {
      stopRecording();
      return;
    }
    if (voiceState === 'idle' || voiceState === 'error') {
      void startRecording();
    }
  }, [startRecording, stopRecording, voiceState]);

  useEffect(() => () => {
    const recorder = recorderRef.current;
    if (recorder?.state === 'recording') {
      recorder.onstop = null;
      recorder.stop();
    }
    releaseMicrophone();
    audioRef.current?.pause();
  }, [releaseMicrophone]);

  const copy = stateCopy[voiceState];
  const isBusy = !['idle', 'error'].includes(voiceState);
  const canTap = ['idle', 'error', 'listening'].includes(voiceState);
  const renderedEvents = useMemo(
    () => toolEvents.map((event) => eventLabels[event] ?? event.replaceAll('_', ' ')),
    [toolEvents],
  );

  return (
    <main className={`phone-shell state-${voiceState}`}>
      <audio ref={audioRef} />
      <div className="dot-field" aria-hidden="true" />

      <header className="topbar">
        <a className="brand" href="#" aria-label="JaldiAI home">
          <span className="brand-face"><i /><i /></span>
          <span>jaldi<span>ai</span></span>
        </a>
        <div className="provider-pill">
          <span className="provider-dot" />
          Blinkit ready
        </div>
      </header>

      <section className="companion-stage" aria-live="polite">
        <p className="kicker">{copy.kicker}</p>
        <h1>{copy.title}</h1>

        <div className="buddy-wrap">
          <span className="orbit orbit-a" />
          <span className="orbit orbit-b" />
          <span className="orbit-note note-one">दूध</span>
          <span className="orbit-note note-two">milk</span>
          <button
            aria-label={voiceState === 'listening' ? 'Finish voice command' : 'Start voice command'}
            className="buddy-button"
            disabled={!canTap}
            onClick={toggleVoice}
            type="button"
          >
            <span className="buddy-shadow shadow-blue" />
            <span className="buddy-shadow shadow-pink" />
            <span className="buddy-body">
              <span className="buddy-eyes"><i /><i /></span>
              <span className="buddy-mouth">
                {voiceState === 'listening' || voiceState === 'speaking'
                  ? <span className="tiny-wave"><i /><i /><i /><i /></span>
                  : <MicIcon />}
              </span>
            </span>
          </button>
        </div>

        <div className="assistant-bubble">
          {latestTranscript ? <p className="heard">YOU SAID · “{latestTranscript}”</p> : null}
          <p>{assistantText}</p>
        </div>
        <p className="stage-hint">{copy.hint}</p>
      </section>

      {renderedEvents.length ? (
        <section className="agent-trail" aria-label="Agent activity">
          <div className="trail-heading">
            <span>AGENT TRAIL</span>
            <span>{isBusy ? 'live' : 'complete'}</span>
          </div>
          <ol>
            {renderedEvents.map((event, index) => (
              <li key={`${event}-${index}`}>
                <span className="trail-check">{index === renderedEvents.length - 1 && isBusy ? '·' : '✓'}</span>
                <span>{event}</span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      <ResultSheet result={latestResult} />

      <footer>
        <span><LockIcon /> Exact review before payment</span>
        <span className="footer-mode">{voiceState === 'listening' ? 'tap to finish' : 'tap buddy to talk'}</span>
      </footer>
    </main>
  );
}
