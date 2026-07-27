'use client';

import { type FormEvent, type ReactNode, useRef, useState } from 'react';
import type {
  ApiErrorResponse,
  ChatResponse,
  SpeakResponse,
  SupportedLanguageCode,
  TranscriptionResponse,
} from '../lib/api-contracts';
import { audioFilename, selectRecorderFormat } from '../lib/audio-recording';
import { stripFactMarkers } from '../lib/safe-localization';

type Stage = 'idle' | 'recording' | 'transcribing' | 'thinking' | 'speaking';

interface Message {
  id: string;
  role: 'agent' | 'user';
  text: string;
  audioDataUrl?: string;
}

interface LanguageOption {
  code: SupportedLanguageCode;
  label: string;
  nativeLabel: string;
  sample: string;
}

const LANGUAGES: readonly LanguageOption[] = [
  { code: 'kn-IN', label: 'Kannada', nativeLabel: 'ಕನ್ನಡ', sample: 'ಒಂದು ಲೀಟರ್ ಹಾಲು ಹುಡುಕಿ' },
  { code: 'ta-IN', label: 'Tamil', nativeLabel: 'தமிழ்', sample: 'ஒரு லிட்டர் பால் தேடுங்கள்' },
  { code: 'mr-IN', label: 'Marathi', nativeLabel: 'मराठी', sample: 'एक लिटर दूध शोधा' },
  { code: 'hi-IN', label: 'Hindi', nativeLabel: 'हिन्दी', sample: 'एक लीटर दूध खोजें' },
  { code: 'en-IN', label: 'English', nativeLabel: 'English', sample: 'Find one litre of milk' },
];

const STAGE_LABELS: Record<Stage, string> = {
  idle: 'Ready when you are',
  recording: 'Listening… tap to finish',
  transcribing: 'Understanding your language…',
  thinking: 'Hermes is working on your errand…',
  speaking: 'Preparing your spoken response…',
};

const INITIAL_MESSAGES: readonly Message[] = [{
  id: 'welcome',
  role: 'agent',
  text: 'Namaskara. Tell me what you need in the language you use at home. I will prepare the errand and show the exact terms before anything happens.',
}];

const createId = (): string => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;

const requestJson = async <T,>(url: string, init: RequestInit): Promise<T> => {
  const response = await fetch(url, init);
  const body = await response.json() as T | ApiErrorResponse;
  if (!response.ok) {
    const error = body as ApiErrorResponse;
    throw new Error(error.error || 'The request could not be completed.');
  }
  return body as T;
};

function SparkIcon(): ReactNode {
  return <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 2c.7 5.4 4.6 9.3 10 10-5.4.7-9.3 4.6-10 10-.7-5.4-4.6-9.3-10-10 5.4-.7 9.3-4.6 10-10Z" /></svg>;
}

function VoiceIcon(): ReactNode {
  return <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 15.5a4 4 0 0 0 4-4V6a4 4 0 1 0-8 0v5.5a4 4 0 0 0 4 4Zm-7-4a7 7 0 0 0 14 0M12 18.5V22M8.5 22h7" /></svg>;
}

function SpeakerIcon(): ReactNode {
  return <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5 9v6h4l5 4V5L9 9H5Zm12.5-.5a5 5 0 0 1 0 7M19.8 6.2a8.2 8.2 0 0 1 0 11.6" /></svg>;
}

function ArrowIcon(): ReactNode {
  return <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5 12h13M14 7l5 5-5 5" /></svg>;
}

export function VoiceOrderConsole(): ReactNode {
  const [messages, setMessages] = useState<Message[]>([...INITIAL_MESSAGES]);
  const [input, setInput] = useState('');
  const [languageCode, setLanguageCode] = useState<SupportedLanguageCode>('kn-IN');
  const [stage, setStage] = useState<Stage>('idle');
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const busy = stage !== 'idle' && stage !== 'recording';
  const selectedLanguage = LANGUAGES.find((language) => language.code === languageCode) ?? LANGUAGES[0];

  const playAudio = async (audioDataUrl: string): Promise<void> => {
    try {
      await new Audio(audioDataUrl).play();
    } catch {
      setError('Your browser blocked autoplay. Use the speaker button to hear the response.');
    }
  };

  const sendMessage = async (message: string, requestedLanguage: SupportedLanguageCode): Promise<void> => {
    const cleanMessage = message.trim();
    if (!cleanMessage || busy) return;

    setError(null);
    setInput('');
    setLanguageCode(requestedLanguage);
    setMessages((current) => [...current, { id: createId(), role: 'user', text: cleanMessage }]);
    setStage('thinking');

    try {
      const chat = await requestJson<ChatResponse>('/api/agent/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: cleanMessage, languageCode: requestedLanguage }),
      });
      const agentMessageId = createId();
      setMessages((current) => [
        ...current,
        { id: agentMessageId, role: 'agent', text: stripFactMarkers(chat.reply) },
      ]);
      setStage('speaking');

      try {
        const speech = await requestJson<SpeakResponse>('/api/voice/speak', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: chat.reply, languageCode: requestedLanguage }),
        });
        setMessages((current) => current.map((item) => item.id === agentMessageId
          ? { ...item, text: speech.localizedText, audioDataUrl: speech.audioDataUrl }
          : item));
        await playAudio(speech.audioDataUrl);
      } catch (speechError) {
        setError(speechError instanceof Error
          ? `${speechError.message} The written response is still available.`
          : 'Audio is unavailable. The written response is still available.');
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Nothing was ordered. Please try again.');
    } finally {
      setStage('idle');
    }
  };

  const handleVoiceBlob = async (blob: Blob): Promise<void> => {
    setStage('transcribing');
    setError(null);
    try {
      const form = new FormData();
      const audioType = blob.type || 'audio/webm';
      form.set('audio', new File([blob], audioFilename(audioType), { type: audioType }));
      const transcription = await requestJson<TranscriptionResponse>('/api/voice/transcribe', {
        method: 'POST',
        body: form,
      });
      await sendMessage(transcription.transcript, transcription.languageCode);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'I could not understand that recording.');
      setStage('idle');
    }
  };

  const toggleRecording = async (): Promise<void> => {
    if (stage === 'recording') {
      recorderRef.current?.stop();
      return;
    }
    if (busy) return;

    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError('Voice recording is not supported in this browser. You can type your request below.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      streamRef.current = stream;
      chunksRef.current = [];
      const format = selectRecorderFormat((type) => MediaRecorder.isTypeSupported(type));
      const recorder = format
        ? new MediaRecorder(stream, { mimeType: format.mimeType })
        : new MediaRecorder(stream);
      recorderRef.current = recorder;
      recorder.ondataavailable = (event): void => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = (): void => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        streamRef.current?.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        recorderRef.current = null;
        void handleVoiceBlob(blob);
      };
      recorder.start(250);
      setStage('recording');
    } catch {
      setError('Microphone access is unavailable. Allow access or type your request below.');
      setStage('idle');
    }
  };

  const submitText = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void sendMessage(input, languageCode);
  };

  return (
    <main className="app-shell">
      <div className="paper-noise" />
      <header className="topbar">
        <a className="brand" href="#top" aria-label="JaldiAI Voice home">
          <span className="brand-mark"><SparkIcon /></span>
          <span>Jaldi<span>AI</span></span>
        </a>
        <div className="topbar-note">
          <span className="status-dot" />
          Prepare-first mode
        </div>
        <div className="edition">Sarvam Epoch · Builder Edition</div>
      </header>

      <section className="hero" id="top">
        <div className="hero-copy">
          <p className="eyebrow">Your language. Your errands. Your control.</p>
          <h1>Speak it.<br /><em>Review it.</em><br />Get it done.</h1>
          <p className="hero-description">
            A voice-first personal operations layer for India—built to understand the language you
            live in, and careful enough to show every rupee before acting.
          </p>
        </div>

        <div className="voice-stage" aria-live="polite">
          <div className={`sound-orbit ${stage === 'recording' ? 'is-recording' : ''}`}>
            <span /><span /><span />
            <button
              className="voice-button"
              type="button"
              onClick={() => void toggleRecording()}
              disabled={busy}
              aria-label={stage === 'recording' ? 'Stop recording' : 'Start voice recording'}
            >
              <VoiceIcon />
              <strong>{stage === 'recording' ? 'Finish' : 'Speak'}</strong>
            </button>
          </div>
          <p className="stage-label">{STAGE_LABELS[stage]}</p>
          <p className="language-hint">Auto-detects 22 Indian languages</p>
        </div>
      </section>

      <section className="workspace" aria-label="Voice errand workspace">
        <div className="conversation-column">
          <div className="language-strip" aria-label="Response language">
            <span>Try it in</span>
            <div>
              {LANGUAGES.map((language) => (
                <button
                  key={language.code}
                  className={language.code === languageCode ? 'is-selected' : ''}
                  type="button"
                  onClick={() => setLanguageCode(language.code)}
                  disabled={busy || stage === 'recording'}
                  title={language.label}
                >
                  {language.nativeLabel}
                </button>
              ))}
            </div>
          </div>

          <div className="conversation" aria-live="polite">
            {messages.map((message) => (
              <article key={message.id} className={`message message-${message.role}`}>
                <div className="message-meta">{message.role === 'agent' ? 'JaldiAI' : 'You'}</div>
                <p>{message.text}</p>
                {message.audioDataUrl ? (
                  <button
                    className="listen-button"
                    type="button"
                    onClick={() => void playAudio(message.audioDataUrl as string)}
                  >
                    <SpeakerIcon /> Hear this
                  </button>
                ) : null}
              </article>
            ))}
            {busy ? (
              <div className="thinking-line"><span /><span /><span />{STAGE_LABELS[stage]}</div>
            ) : null}
          </div>

          {error ? <div className="error-note" role="alert">{error}</div> : null}

          <form className="composer" onSubmit={submitText}>
            <label htmlFor="errand-request">Or type your request</label>
            <div className="composer-row">
              <input
                id="errand-request"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder={selectedLanguage?.sample ?? 'Tell me what you need'}
                disabled={busy || stage === 'recording'}
                autoComplete="off"
              />
              <button type="submit" disabled={busy || stage === 'recording' || input.trim().length === 0}>
                <span>Send</span><ArrowIcon />
              </button>
            </div>
          </form>
        </div>

        <aside className="trust-rail">
          <div className="rail-number">03</div>
          <p className="rail-kicker">Built for trust</p>
          <h2>Nothing moves<br />without you.</h2>
          <ol>
            <li><span>01</span><div><strong>Speak naturally</strong><p>Sarvam hears native and code-mixed speech.</p></div></li>
            <li><span>02</span><div><strong>Review exact terms</strong><p>Prices, quantities and delivery details stay unchanged.</p></div></li>
            <li><span>03</span><div><strong>Confirm explicitly</strong><p>Preparation is not an order. You make the final call.</p></div></li>
          </ol>
          <div className="safety-stamp">
            <SparkIcon />
            <span>Powered by Sarvam<br />Orchestrated by Hermes</span>
          </div>
        </aside>
      </section>

      <footer>
        <p>JaldiAI · Personal operations, in your own words.</p>
        <p>Live purchase actions remain protected by separate safety gates.</p>
      </footer>
    </main>
  );
}
