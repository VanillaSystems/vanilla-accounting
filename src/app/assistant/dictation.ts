/**
 * Speech to text for the chat's microphone button: one recognizer per environment, the first this
 * one has. The browser's own (Chrome, Edge, Safari) hears through its maker's online service. The
 * Mac app does not use it (in Electron it needs a key only the browsers carry and fails with
 * `network`): it recognizes on the Mac (src/desktop/dictation.swift), and never goes online.
 * Firefox has none: no button.
 */
import { desktop } from '../desktop/bridge.js';
import type { DesktopBridge, DictationProblem, Heard } from '../../types/desktop.js';

export type { Heard };

/** Why listening stopped early; a pause or a stop by the person is no error. */
export type DictationError = 'denied' | 'unreachable' | DictationProblem;

export interface Listeners {
  /** Everything heard so far, each time it changes. */
  heard(heard: Heard): void;
  ended(error?: DictationError): void;
  /** True while the recognizer first loads the language onto this computer. */
  preparing?(loading: boolean): void;
  /** The microphone's loudness, 0 to 1, while listening; only where the recognizer measures it. */
  level?(level: number): void;
}

export interface Recognizer {
  /** The voice leaves this computer to be recognized. */
  online: boolean;
  /** Starts listening in `lang`; returns the stop. */
  start(lang: string, on: Listeners): () => void;
}

interface SpeechResults { length: number; [i: number]: { isFinal: boolean; 0: { transcript: string } } }
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

/** The Web Speech API's results: the final ones settled, the interim ones after them still a guess. */
export function webHeard(results: SpeechResults): Heard {
  const all = Array.from({ length: results.length }, (_, i) => results[i]);
  const words = (final: boolean) => all.filter((r) => r.isFinal === final).map((r) => r[0].transcript.trim()).filter(Boolean).join(' ');
  const text = words(true);
  const partial = words(false);
  return { text, partial: text && partial ? ` ${partial}` : partial };
}

function browser(): Recognizer | undefined {
  const w = window as unknown as { SpeechRecognition?: new () => WebSpeech; webkitSpeechRecognition?: new () => WebSpeech };
  const Speech = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  if (!Speech) return undefined;
  return {
    online: true,
    start(lang, on) {
      const r = new Speech();
      r.lang = lang;
      r.continuous = true;
      r.interimResults = true;
      let error: DictationError | undefined;
      r.onresult = (e) => on.heard(webHeard(e.results));
      r.onerror = (e) => { error = dictationError(e.error); };
      r.onend = () => on.ended(error);
      r.start();
      return () => r.stop();
    },
  };
}

/**
 * The Mac app's: heard and recognized on the Mac. Like the Mac's own dictation it stops when the
 * window loses focus, but only once listening: the system's permission prompt takes the focus first.
 */
export function onDevice(bridge: Required<Pick<DesktopBridge, 'dictate'>>, win: Pick<Window, 'addEventListener' | 'removeEventListener'> = window): Recognizer {
  return {
    online: false,
    start(lang, on) {
      const blur = () => stop();
      const stop = bridge.dictate(lang, (e) => {
        if (e.kind === 'preparing') on.preparing?.(true);
        else if (e.kind === 'listening') { on.preparing?.(false); win.addEventListener('blur', blur); }
        else if (e.kind === 'level') on.level?.(e.level);
        else if (e.kind === 'heard') on.heard({ text: e.text, partial: e.partial });
        else { on.preparing?.(false); win.removeEventListener('blur', blur); on.ended(e.error); }
      });
      return stop;
    },
  };
}

export function recognizer(bridge: DesktopBridge | undefined = desktop): Recognizer | undefined {
  if (typeof window === 'undefined') return undefined;
  if (bridge) return bridge.dictate ? onDevice({ dictate: bridge.dictate }) : undefined;
  return browser();
}

/** The language the recognizer listens in: Swiss German, French and Italian; English as in the US. */
export const dictationLang = (language: string): string => (language === 'en' ? 'en-US' : `${language}-CH`);

/**
 * The message field as dictation sees it: its text, the part dictation writes over (the selection
 * when it started, the caret where start is end; afterwards the words it wrote), and what that part
 * held when dictation started, put back while nothing is heard.
 */
export interface Field { text: string; start: number; end: number; kept: string }

/** The field when dictation starts, with its selection. */
export const fieldAt = (text: string, start: number, end: number): Field => ({ text, start, end, kept: text.slice(start, end) });

/** The field while dictating, where the provisional words sit in it, and the caret after what was heard. */
export interface Dictated { field: Field; partial: { start: number; end: number }; caret: number }

/**
 * What was heard put where the caret was, in place of a selection: the typed text before and after
 * it kept, one space between words, never glued or doubled; the partial words marked, so the field
 * can show them as provisional until the recognizer settles them. Nothing heard leaves the field as it was.
 */
export function dictated(field: Field, heard: Heard): Dictated {
  const before = field.text.slice(0, field.start);
  const after = field.text.slice(field.end);
  const squash = (s: string) => s.replace(/\s+/g, ' ').trimStart();
  const said = squash(heard.text + heard.partial).trimEnd();
  const settled = Math.min(squash(heard.text).trimEnd().length, said.length);
  if (!said) {
    const end = before.length + field.kept.length;
    return { field: { ...field, text: before + field.kept + after, end }, partial: { start: end, end }, caret: end };
  }
  const lead = before && !/\s$/.test(before) ? `${before} ` : before;
  const tail = after && !/^[\s,.;:!?)]/.test(after) ? ` ${after}` : after;
  const start = lead.length;
  const text = lead + said + tail;
  return {
    field: { ...field, text, start: before.length, end: text.length - after.length },
    partial: { start: start + settled, end: start + said.length },
    caret: start + said.length,
  };
}

/**
 * The field after the person typed in it while dictating (`now`): typing before the dictated words
 * moves them, typing after them leaves them; the next words heard replace only them. A change to the
 * dictated words themselves gives undefined: they stay as the person left them, and dictation lets go.
 */
export function follow(field: Field, now: string): Field | undefined {
  const was = field.text;
  if (now === was) return field;
  const shorter = Math.min(was.length, now.length);
  let same = 0;
  while (same < shorter && was[same] === now[same]) same++;
  let tail = 0;
  while (tail < shorter - same && was[was.length - 1 - tail] === now[now.length - 1 - tail]) tail++;
  const changedEnd = was.length - tail;
  if (changedEnd <= field.start) {
    const moved = now.length - was.length;
    return { ...field, text: now, start: field.start + moved, end: field.end + moved };
  }
  if (same >= field.end) return { ...field, text: now };
  return undefined;
}
