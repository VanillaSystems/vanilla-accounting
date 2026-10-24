/**
 * The chat's microphone in the Mac app (issue #150): one run of the speech recognizer
 * (src/desktop/dictation.swift, Contents/MacOS/vanilla-dictation) per dictation, its lines read as
 * DictationEvents. The recognizer hears and recognizes on the Mac; nothing here goes online.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { DictationEvent, DictationProblem } from '../types/desktop.js';

const PROBLEMS: readonly DictationProblem[] = ['micDenied', 'speechDenied', 'noOnDevice', 'notInstalled', 'failed'];

/** A language tag the recognizer takes (de-CH, en-US); anything else from the page is refused. */
export const isLang = (lang: unknown): lang is string => typeof lang === 'string' && /^[a-z]{2}-[A-Z]{2}$/.test(lang);

/** One line of the recognizer's stdout; undefined for anything else it may print. */
export function parseEvent(line: string): DictationEvent | undefined {
  let o: { kind?: unknown; text?: unknown; error?: unknown };
  try { o = JSON.parse(line); } catch { return undefined; }
  if (o.kind === 'preparing' || o.kind === 'listening') return { kind: o.kind };
  if (o.kind === 'heard' && typeof o.text === 'string') return { kind: 'heard', text: o.text };
  if (o.kind === 'ended') {
    if (o.error === undefined) return { kind: 'ended' };
    return { kind: 'ended', error: PROBLEMS.includes(o.error as DictationProblem) ? o.error as DictationProblem : 'failed' };
  }
  return undefined;
}

export type Spawn = (bin: string, args: string[]) => ChildProcessWithoutNullStreams;

/**
 * Starts the recognizer in `lang`; `send` gets its events and exactly one `ended`, also when it
 * crashes or cannot start. Returns the stop: the recognizer finishes the last words, then ends;
 * one that does not end within `grace` ms is killed.
 */
export function dictate(bin: string, lang: string, send: (e: DictationEvent) => void, run: Spawn = (b, a) => spawn(b, a), grace = 4000): () => void {
  let ended = false;
  let stopped = false;
  const finish = (e: DictationEvent & { kind: 'ended' }) => { if (!ended) { ended = true; send(e); } };
  const child = run(bin, ['--lang', lang]);
  createInterface({ input: child.stdout }).on('line', (line) => {
    const e = parseEvent(line);
    if (!e || ended) return;
    if (e.kind === 'ended') finish(e); else send(e);
  });
  child.stderr.on('data', (d: Buffer) => console.error(`dictation: ${d.toString().trim()}`));
  child.on('error', () => finish({ kind: 'ended', error: 'failed' }));
  child.on('close', (code) => finish(code === 0 || stopped ? { kind: 'ended' } : { kind: 'ended', error: 'failed' }));
  // A recognizer that already ended closes its stdin: writing the stop then is no error.
  child.stdin.on('error', () => {});
  return () => {
    if (ended || stopped) return;
    stopped = true;
    child.stdin.end('stop\n');
    setTimeout(() => { if (child.exitCode === null) child.kill(); }, grace).unref();
  };
}
