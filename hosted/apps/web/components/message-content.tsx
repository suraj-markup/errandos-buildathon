'use client';

import React, { memo, type ReactNode } from 'react';
import ReactMarkdown, { type Components, type UrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface MessageContentProps {
  content: string;
}

const SAFE_IMAGE_DATA_URL = /^data:image\/(?:png|jpe?g|webp|gif);base64,[a-z0-9+/=\s]+$/i;
const SAFE_AUDIO_DATA_URL = /^data:audio\/(?:wav|x-wav|mpeg|mp3|ogg|webm|mp4|aac);base64,[a-z0-9+/=\s]+$/i;
const AUDIO_FILE_URL = /\.(?:wav|mp3|ogg|webm|m4a|aac)(?:[?#]|$)/i;

const isSafeWebUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url, globalThis.location?.origin ?? 'https://jaldiai.local');
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
};

const safeMessageUrl: UrlTransform = (url) => {
  if (SAFE_IMAGE_DATA_URL.test(url) || SAFE_AUDIO_DATA_URL.test(url)) return url;
  if (url.startsWith('/') || isSafeWebUrl(url)) return url;
  return null;
};

const isAudioSource = (source: string, label = ''): boolean => (
  SAFE_AUDIO_DATA_URL.test(source)
  || AUDIO_FILE_URL.test(source)
  || /^(?:audio|voice|recording)$/i.test(label.trim())
);

const mediaLabel = (label: string | undefined, fallback: string): string => {
  const clean = label?.trim();
  return clean && !/^(?:image|audio)$/i.test(clean) ? clean : fallback;
};

const markdownComponents: Components = {
  a: ({ children, href }) => {
    if (!href) return <span>{children}</span>;
    const label = typeof children === 'string' ? children : '';
    if (isAudioSource(href, label)) {
      return (
        <span className="message-media message-audio">
          <span>{mediaLabel(label, 'Voice response')}</span>
          <audio controls preload="metadata" src={href}>
            Your browser cannot play this audio.
          </audio>
        </span>
      );
    }
    return (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
  img: ({ alt, src }) => {
    const source = typeof src === 'string' ? src : '';
    if (!source) return null;
    if (isAudioSource(source, alt)) {
      return (
        <span className="message-media message-audio">
          <span>{mediaLabel(alt, 'Voice response')}</span>
          <audio controls preload="metadata" src={source}>
            Your browser cannot play this audio.
          </audio>
        </span>
      );
    }
    return (
      <span className="message-media message-image">
        <a href={source} target="_blank" rel="noopener noreferrer" aria-label="Open image at full size">
          {/* Provider screenshots arrive as exact data URLs, so Next Image optimization is not applicable. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={source} alt={alt ?? 'JaldiAI response image'} loading="lazy" decoding="async" />
        </a>
        <span>{mediaLabel(alt, 'Attached image')}</span>
      </span>
    );
  },
  table: ({ children, ...props }) => (
    <div className="message-table-scroll" role="region" aria-label="Response table" tabIndex={0}>
      <table {...props}>{children}</table>
    </div>
  ),
};

function MessageContentComponent({ content }: MessageContentProps): ReactNode {
  return (
    <div className="message-content">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={markdownComponents}
        urlTransform={safeMessageUrl}
        skipHtml
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

export const MessageContent = memo(MessageContentComponent);
