import { z } from 'zod';

export const SupportedLanguageCodeSchema = z.enum([
  'as-IN',
  'bn-IN',
  'brx-IN',
  'doi-IN',
  'en-IN',
  'gu-IN',
  'hi-IN',
  'kn-IN',
  'kok-IN',
  'ks-IN',
  'mai-IN',
  'ml-IN',
  'mni-IN',
  'mr-IN',
  'ne-IN',
  'od-IN',
  'pa-IN',
  'sa-IN',
  'sat-IN',
  'sd-IN',
  'ta-IN',
  'te-IN',
  'ur-IN',
]);

export const ChatRequestSchema = z.object({
  message: z.string().trim().min(1).max(4_000),
  languageCode: SupportedLanguageCodeSchema.default('en-IN'),
}).strict();

export const SpeakRequestSchema = z.object({
  text: z.string().trim().min(1).max(8_000),
  languageCode: SupportedLanguageCodeSchema,
}).strict();

export type SupportedLanguageCode = z.infer<typeof SupportedLanguageCodeSchema>;

export interface TranscriptionResponse {
  transcript: string;
  languageCode: SupportedLanguageCode;
  languageProbability?: number;
}

export interface ChatResponse {
  reply: string;
}

export interface SpeakResponse {
  localizedText: string;
  audioDataUrl: string;
}

export interface ApiErrorResponse {
  error: string;
  category: 'configuration' | 'invalid_request' | 'upstream_unavailable' | 'operation_failed';
}
