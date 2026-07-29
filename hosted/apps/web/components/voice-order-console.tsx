'use client';

import { type FormEvent, type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import type {
  ApiErrorResponse,
  ChatResponse,
  SpeakResponse,
  SupportedLanguageCode,
  TranscriptionResponse,
} from '../lib/api-contracts';
import {
  audioFilename,
  MIN_RECORDING_MS,
  recordingReadyForUpload,
  selectRecorderFormat,
} from '../lib/audio-recording';
import { extractSpeakableText, hasRichMessageContent } from '../lib/message-content';
import { stripFactMarkers } from '../lib/safe-localization';
import { MessageContent } from './message-content';

type Stage = 'idle' | 'recording' | 'transcribing' | 'thinking' | 'speaking';

interface Message {
  id: string;
  role: 'agent' | 'user';
  text: string;
  audioDataUrl?: string;
  shareUrl?: string;
}

interface LanguageOption {
  code: SupportedLanguageCode;
  label: string;
  nativeLabel: string;
  sample: string;
}

const LANGUAGES: readonly LanguageOption[] = [
  { code: 'en-IN', label: 'English', nativeLabel: 'English', sample: 'Find one litre of milk' },
  { code: 'hi-IN', label: 'Hindi', nativeLabel: 'हिन्दी', sample: 'एक लीटर दूध खोजें' },
  { code: 'kn-IN', label: 'Kannada', nativeLabel: 'ಕನ್ನಡ', sample: 'ಒಂದು ಲೀಟರ್ ಹಾಲು ಹುಡುಕಿ' },
  { code: 'ta-IN', label: 'Tamil', nativeLabel: 'தமிழ்', sample: 'ஒரு லிட்டர் பால் தேடுங்கள்' },
  { code: 'mr-IN', label: 'Marathi', nativeLabel: 'मराठी', sample: 'एक लिटर दूध शोधा' },
  { code: 'te-IN', label: 'Telugu', nativeLabel: 'తెలుగు', sample: 'ఒక లీటర్ పాలు వెతకండి' },
  { code: 'bn-IN', label: 'Bengali', nativeLabel: 'বাংলা', sample: 'এক লিটার দুধ খুঁজুন' },
  { code: 'gu-IN', label: 'Gujarati', nativeLabel: 'ગુજરાતી', sample: 'એક લિટર દૂધ શોધો' },
  { code: 'ml-IN', label: 'Malayalam', nativeLabel: 'മലയാളം', sample: 'ഒരു ലിറ്റർ പാൽ കണ്ടെത്തൂ' },
  { code: 'pa-IN', label: 'Punjabi', nativeLabel: 'ਪੰਜਾਬੀ', sample: 'ਇੱਕ ਲੀਟਰ ਦੁੱਧ ਲੱਭੋ' },
  { code: 'od-IN', label: 'Odia', nativeLabel: 'ଓଡ଼ିଆ', sample: 'ଏକ ଲିଟର କ୍ଷୀର ଖୋଜନ୍ତୁ' },
  { code: 'as-IN', label: 'Assamese', nativeLabel: 'অসমীয়া', sample: 'এলিটাৰ গাখীৰ বিচাৰক' },
  { code: 'ur-IN', label: 'Urdu', nativeLabel: 'اردو', sample: 'ایک لیٹر دودھ تلاش کریں' },
  { code: 'ne-IN', label: 'Nepali', nativeLabel: 'नेपाली', sample: 'एक लिटर दूध खोज्नुहोस्' },
  { code: 'kok-IN', label: 'Konkani', nativeLabel: 'कोंकणी', sample: 'एक लिटर दूध सोद' },
  { code: 'ks-IN', label: 'Kashmiri', nativeLabel: 'کٲشُر', sample: 'Find one litre of milk' },
  { code: 'sd-IN', label: 'Sindhi', nativeLabel: 'سنڌي', sample: 'هڪ ليٽر کير ڳوليو' },
  { code: 'sa-IN', label: 'Sanskrit', nativeLabel: 'संस्कृतम्', sample: 'एकं लीटरं दुग्धं अन्विष्यतु' },
  { code: 'mai-IN', label: 'Maithili', nativeLabel: 'मैथिली', sample: 'एक लीटर दूध खोजू' },
  { code: 'doi-IN', label: 'Dogri', nativeLabel: 'डोगरी', sample: 'इक लीटर दूध तुप्पो' },
  { code: 'brx-IN', label: 'Bodo', nativeLabel: 'बड़ो', sample: 'Find one litre of milk' },
  { code: 'mni-IN', label: 'Manipuri', nativeLabel: 'মৈতৈলোন্', sample: 'Find one litre of milk' },
  { code: 'sat-IN', label: 'Santali', nativeLabel: 'ᱥᱟᱱᱛᱟᱲᱤ', sample: 'Find one litre of milk' },
];

const STAGE_LABELS: Record<Stage, string> = {
  idle: 'Ready when you are',
  recording: 'Listening… tap to finish',
  transcribing: 'Understanding your language…',
  thinking: 'JaldiAI is working on your task…',
  speaking: 'Preparing your spoken response…',
};

const welcomeMessage = (publicCartHandoff: boolean): Message => ({
  id: 'welcome',
  role: 'agent',
  text: publicCartHandoff
    ? 'Namaskara. You are using Suraj’s shared account. I can search, build a cart, and give you an official Blinkit share link. COD and order placement are not available here.'
    : 'Namaskara. I’m JaldiAI. Tell me what you need—or ask about your cart, an address, an order, or a ride. I will show the exact details before any final action.',
});

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

function HandoffIcon(): ReactNode {
  return <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M8 5h11v11M19 5 9 15M15 19H5V9" /></svg>;
}

function ChevronIcon(): ReactNode {
  return <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m8 10 4 4 4-4" /></svg>;
}

interface VoiceOrderConsoleProps {
  publicCartHandoff?: boolean;
}

const MAX_RECORDING_MS = 60_000;

export function VoiceOrderConsole({ publicCartHandoff = false }: VoiceOrderConsoleProps): ReactNode {
  const [messages, setMessages] = useState<Message[]>(() => [welcomeMessage(publicCartHandoff)]);
  const [input, setInput] = useState('');
  const [languageCode, setLanguageCode] = useState<SupportedLanguageCode>('en-IN');
  const [stage, setStage] = useState<Stage>('idle');
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recordingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recordingStartedAtRef = useRef(0);
  const conversationEndRef = useRef<HTMLDivElement | null>(null);
  const latestMessageRef = useRef<HTMLElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const busy = stage !== 'idle' && stage !== 'recording';
  const selectedLanguage = LANGUAGES.find((language) => language.code === languageCode) ?? LANGUAGES[0]!;

  useEffect(() => {
    const latestMessage = messages[messages.length - 1];
    if (latestMessage?.role === 'agent' && latestMessage.id !== 'welcome') {
      latestMessageRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    conversationEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [messages]);

  useEffect(() => {
    if (stage === 'thinking' || stage === 'transcribing') {
      conversationEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [stage]);

  useEffect((): (() => void) => (): void => {
    if (recordingTimerRef.current) clearTimeout(recordingTimerRef.current);
    streamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

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
      const displayText = stripFactMarkers(chat.reply);
      const richContent = hasRichMessageContent(displayText);
      setMessages((current) => [
        ...current,
        {
          id: agentMessageId,
          role: 'agent',
          text: displayText,
          ...(chat.shareUrl ? { shareUrl: chat.shareUrl } : {}),
        },
      ]);
      const speakableText = extractSpeakableText(chat.reply);
      if (!speakableText) return;

      setStage('speaking');
      try {
        const speech = await requestJson<SpeakResponse>('/api/voice/speak', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: speakableText, languageCode: requestedLanguage }),
        });
        setMessages((current) => current.map((item) => item.id === agentMessageId
          ? {
            ...item,
            ...(richContent ? {} : { text: speech.localizedText }),
            audioDataUrl: speech.audioDataUrl,
          }
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
      if (Date.now() - recordingStartedAtRef.current < MIN_RECORDING_MS) {
        setError('Keep speaking for at least one second, then tap the microphone again.');
        return;
      }
      if (recordingTimerRef.current) clearTimeout(recordingTimerRef.current);
      recordingTimerRef.current = null;
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
        if (recordingTimerRef.current) clearTimeout(recordingTimerRef.current);
        recordingTimerRef.current = null;
        const audioType = recorder.mimeType || chunksRef.current[0]?.type || 'audio/webm';
        const blob = new Blob(chunksRef.current, { type: audioType });
        const durationMs = Date.now() - recordingStartedAtRef.current;
        streamRef.current?.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        recorderRef.current = null;
        recordingStartedAtRef.current = 0;
        if (!recordingReadyForUpload(durationMs, blob.size)) {
          setError('I could not hear enough audio. Hold the microphone and speak for at least two seconds.');
          setStage('idle');
          return;
        }
        void handleVoiceBlob(blob);
      };
      recorder.start(250);
      recordingStartedAtRef.current = Date.now();
      recordingTimerRef.current = setTimeout(() => recorder.stop(), MAX_RECORDING_MS);
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

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (input.trim() && !busy && stage !== 'recording') void sendMessage(input, languageCode);
    }
  };

  return (
    <main className="app-shell">
      <div className="paper-noise" />
      <header className="topbar">
        <a className="brand" href="#conversation" aria-label="JaldiAI home">
          <span className="brand-mark"><SparkIcon /></span>
          <span>Jaldi<span>AI</span></span>
        </a>
        <div className="topbar-note">
          <span className="status-dot" />
          {publicCartHandoff ? 'Shared cart access · COD off' : 'Private family access'}
        </div>
        <div className="edition">Sarvam voice · Hermes intelligence</div>
      </header>

      <section className="workspace" aria-label="JaldiAI chat">
        <aside className="intro-panel">
          <div className="intro-copy">
            <p className="eyebrow">Your language. Your errands. Your control.</p>
            <h1>Say it.<br /><em>See it.</em><br />Stay in control.</h1>
            <p>
              {publicCartHandoff
                ? 'Speak naturally or type. JaldiAI can search and build a cart, then give you an official Blinkit share link to open on your own device.'
                : 'Speak naturally or type. JaldiAI can search, prepare, compare, and check status while keeping exact prices, addresses, ETAs, and final actions visible.'}
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
            <p className="language-hint">Sarvam auto-detects your spoken language</p>
          </div>

          <div className="trust-note">
            <span>01</span>
            <p>{publicCartHandoff
              ? <><strong>Cart links only.</strong> This shared account cannot place COD orders.</>
              : <><strong>Exact terms first.</strong> Nothing final happens without a clear review and authorization.</>}</p>
          </div>
        </aside>

        <section className="conversation-column" id="conversation">
          <header className="conversation-header">
            <div>
              <span className="status-dot" />
              <div>
                <strong>JaldiAI</strong>
                <p>{STAGE_LABELS[stage]}</p>
              </div>
            </div>
            <label className="language-select">
              <span>Reply in</span>
              <select
                value={languageCode}
                onChange={(event) => setLanguageCode(event.target.value as SupportedLanguageCode)}
                disabled={busy || stage === 'recording'}
                aria-label="Response language"
              >
                {LANGUAGES.map((language) => (
                  <option key={language.code} value={language.code}>
                    {language.nativeLabel} · {language.label}
                  </option>
                ))}
              </select>
              <ChevronIcon />
            </label>
          </header>

          <div className="conversation" aria-live="polite">
            {publicCartHandoff ? (
              <aside className="account-notice" aria-label="Shared account limits">
                <div>
                  <span>Shared Suraj account</span>
                  <strong>Search → build cart → share link. That’s the limit.</strong>
                </div>
                <p>
                  COD and checkout are disabled. For COD access or your own MCP server and setup,
                  contact <a href="https://sk9261712674.com" target="_blank" rel="noopener noreferrer">Suraj</a>.
                </p>
              </aside>
            ) : null}
            {messages.map((message, index) => (
              <article
                key={message.id}
                ref={index === messages.length - 1 ? latestMessageRef : undefined}
                className={`message message-${message.role}`}
              >
                <div className="message-meta">{message.role === 'agent' ? 'JaldiAI' : 'You'}</div>
                {message.role === 'agent'
                  ? <MessageContent content={message.text} />
                  : <p>{message.text}</p>}
                {message.shareUrl ? (
                  <div className="handoff-card">
                    <p>Cart handoff ready</p>
                    <a
                      className="handoff-button"
                      href={message.shareUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <span>Open in Blinkit</span><HandoffIcon />
                    </a>
                    <small>Blinkit will recheck your location, prices and delivery terms before checkout.</small>
                  </div>
                ) : null}
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
            <div ref={conversationEndRef} />
          </div>

          {error ? <div className="error-note" role="alert">{error}</div> : null}

          <form className="composer" onSubmit={submitText}>
            <div className="composer-row">
              <button
                className={`composer-voice ${stage === 'recording' ? 'is-recording' : ''}`}
                type="button"
                onClick={() => void toggleRecording()}
                disabled={busy}
                aria-label={stage === 'recording' ? 'Stop recording' : 'Record a voice request'}
                title={stage === 'recording' ? 'Finish recording' : 'Speak'}
              >
                <VoiceIcon />
              </button>
              <textarea
                ref={textareaRef}
                id="errand-request"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={handleComposerKeyDown}
                placeholder={stage === 'recording' ? 'Listening…' : selectedLanguage.sample}
                disabled={busy || stage === 'recording'}
                autoComplete="off"
                rows={1}
                aria-label="Type your errand request"
              />
              <button
                className="send-button"
                type="submit"
                disabled={busy || stage === 'recording' || input.trim().length === 0}
                aria-label="Send message"
              >
                <span>Send</span><ArrowIcon />
              </button>
            </div>
            <p>Enter to send · Shift + Enter for a new line</p>
          </form>
        </section>
      </section>

      <footer>
        <p>JaldiAI · Personal errands, in your own words.</p>
        <p>{publicCartHandoff ? (
          <>Shared-account mode creates cart links only. <a href="https://sk9261712674.com">Contact Suraj</a> for COD or a private setup.</>
        ) : 'Paid actions remain behind exact-term review and authorization.'}</p>
      </footer>
    </main>
  );
}
