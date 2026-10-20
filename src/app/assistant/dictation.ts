/**
 * Speech to text for the chat's microphone button: one recognizer per environment, the first this
 * one has. The browser's own (Chrome, Edge, Safari) hears through its maker's online service. The
 * Mac app does not use it: in Electron it needs a key only the browsers carry and fails with
 * `network`; the app gets its own on-device recognizer instead. Firefox has none: no button.
 */
import { desktop } from '../desktop/bridge.js';

/** Why listening stopped early; a pause or a stop by the person is no error. */
export type DictationError = 'denied' | 'unreachable' | 'failed';

export interface Recognizer {
  /** The voice leaves this computer to be recognized. */
  online: boolean;
  /** Starts listening; `heard` gets everything heard so far, each time it grows. Returns the stop. */
  start(lang: string, heard: (text: string) => void, ended: (error?: DictationError) => void): () => void;
}

interface SpeechResults { length: number; [i: number]: { 0: { transcript: string } } }
interface WebSpeech {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: { results: SpeechResults }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

/** The Web Speech API's error codes, as the person reads them. */
export function dictationError(code: string): DictationError | undefined {
  if (code === 'not-allowed' || code === 'service-not-allowed' || code === 'audio-capture') return 'denied';
  if (code === 'network') return 'unreachable';
  if (code === 'no-speech' || code === 'aborted') return undefined;
  return 'failed';
}

function browser(): Recognizer | undefined {
  const w = window as unknown as { SpeechRecognition?: new () => WebSpeech; webkitSpeechRecognition?: new () => WebSpeech };
  const Speech = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  if (!Speech) return undefined;
  return {
    online: true,
    start(lang, heard, ended) {
      const r = new Speech();
      r.lang = lang;
      r.continuous = true;
      r.interimResults = true;
      let error: DictationError | undefined;
      r.onresult = (e) => heard(Array.from({ length: e.results.length }, (_, i) => e.results[i][0].transcript).join(' '));
      r.onerror = (e) => { error = dictationError(e.error); };
      r.onend = () => ended(error);
      r.start();
      return () => r.stop();
    },
  };
}

export function recognizer(): Recognizer | undefined {
  if (typeof window === 'undefined' || desktop) return undefined;
  return browser();
}

/** The language the recognizer listens in: Swiss German, French and Italian; English as in the US. */
export const dictationLang = (language: string): string => (language === 'en' ? 'en-US' : `${language}-CH`);

/** The field's text while dictating: what was typed before, then what was heard, one space between. */
export function withHeard(before: string, heard: string): string {
  const said = heard.replace(/\s+/g, ' ').trim();
  if (!said) return before;
  return before && !/\s$/.test(before) ? `${before} ${said}` : `${before}${said}`;
}
