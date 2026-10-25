/**
 * The chat's microphone (src/app/assistant/dictation.ts, in the Mac app src/desktop/dictation.ts):
 * what was heard joins what was typed, the recognizer listens in the person's language, and only a
 * real failure shows a line. Each test names the wrong behaviour it catches.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { PassThrough } from 'node:stream';
import { dictationError, dictationLang, onDevice, recognizer, withHeard } from '../src/app/assistant/dictation.js';
import { dictate, isLang, parseEvent } from '../src/desktop/dictation.js';
import type { DesktopBridge, DictationEvent } from '../src/types/desktop.js';
import { messages } from '../src/app/i18n/locales/de.js';

test('what was heard follows what was typed, one space between, never glued or doubled', () => {
  assert.equal(withHeard('', ' buch das  auf Telefon '), 'buch das auf Telefon');
  assert.equal(withHeard('Swisscom:', 'immer auf 6510'), 'Swisscom: immer auf 6510', 'glued to the typed word');
  assert.equal(withHeard('Swisscom: ', 'immer auf 6510'), 'Swisscom: immer auf 6510', 'a second space');
  assert.equal(withHeard('Swisscom', '  '), 'Swisscom', 'silence must not touch what was typed');
});

test('the recognizer listens in the person\'s language, the Swiss variant where there is one', () => {
  assert.deepEqual(['de', 'fr', 'it', 'en'].map(dictationLang), ['de-CH', 'fr-CH', 'it-CH', 'en-US']);
});

test('a pause or a stop is no error; a refused microphone and an unreachable service are told apart', () => {
  assert.equal(dictationError('no-speech'), undefined, 'a pause must not show an error line');
  assert.equal(dictationError('aborted'), undefined, 'the person\'s own stop must not show an error line');
  assert.equal(dictationError('not-allowed'), 'denied');
  assert.equal(dictationError('audio-capture'), 'denied');
  assert.equal(dictationError('network'), 'unreachable');
  assert.equal(dictationError('language-not-supported'), 'failed');
});

test('without a speech engine (no window, as in Firefox) there is no recognizer, so no button', () => {
  assert.equal(recognizer(), undefined);
});

test('in the Mac app the button shows only where the app found its own recognizer, never the browser\'s online one', () => {
  const g = globalThis as { window?: unknown };
  g.window = { SpeechRecognition: class {} };
  try {
    assert.equal(recognizer({} as DesktopBridge), undefined, 'an app without its recognizer must not fall back to the online one');
    const ear = recognizer({ dictate: () => () => {} } as unknown as DesktopBridge);
    assert.equal(ear?.online, false, 'the Mac app hears on the Mac: no «online» notice');
    assert.equal(recognizer(undefined)?.online, true, 'the browser keeps its own');
  } finally {
    delete g.window;
  }
});

/** A bridge whose recognizer the test drives by hand, and a window whose blur it can fire. */
function macEar() {
  let send: (e: DictationEvent) => void = () => {};
  let stops = 0;
  const blurs = new Set<() => void>();
  const win = { addEventListener: (_: string, f: () => void) => blurs.add(f), removeEventListener: (_: string, f: () => void) => blurs.delete(f) };
  const ear = onDevice({ dictate: (_lang, listener) => { send = listener; return () => { stops++; }; } }, win as never);
  const log: string[] = [];
  ear.start('de-CH', (t) => log.push(`heard ${t}`), (e) => log.push(`ended ${e ?? ''}`), (p) => log.push(`preparing ${p}`));
  return { send: (e: DictationEvent) => send(e), blur: () => [...blurs].forEach((f) => f()), stops: () => stops, log, blurs };
}

test('on the Mac: loading the language shows, what was heard grows, a refusal names its cause', () => {
  const m = macEar();
  m.send({ kind: 'preparing' });
  m.send({ kind: 'listening' });
  m.send({ kind: 'heard', text: 'Buch die' });
  m.send({ kind: 'heard', text: 'Buch die Swisscom' });
  m.send({ kind: 'ended', error: 'micDenied' });
  assert.deepEqual(m.log, ['preparing true', 'preparing false', 'heard Buch die', 'heard Buch die Swisscom', 'preparing false', 'ended micDenied']);
});

test('on the Mac: leaving the window stops listening, but the permission prompt before it does not', () => {
  const m = macEar();
  m.blur();
  assert.equal(m.stops(), 0, 'the system\'s prompt takes the focus before listening: it must not stop the dictation');
  m.send({ kind: 'listening' });
  m.blur();
  assert.equal(m.stops(), 1, 'switching away while listening must stop the microphone');
  m.send({ kind: 'ended' });
  assert.equal(m.blurs.size, 0, 'an ended dictation leaves no listener on the window');
});

/** A recognizer process the test writes the lines of. */
function fakeHelper() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), exitCode: null as number | null, killed: false,
    kill() { this.killed = true; return true; },
  });
  let stdin = '';
  child.stdin.on('data', (d) => { stdin += d; });
  const args: string[][] = [];
  const events: DictationEvent[] = [];
  const close = (code: number | null) => { child.exitCode = code; child.stdout.end(); setImmediate(() => child.emit('close', code)); };
  return { child, args, events, close, stdin: () => stdin, run: (_b: string, a: string[]) => { args.push(a); return child as never; } };
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

test('the app reads the recognizer\'s lines, ignores what is no event, and reports exactly one end', async () => {
  const h = fakeHelper();
  dictate('/bin/vd', 'fr-CH', (e) => h.events.push(e), h.run);
  assert.deepEqual(h.args, [['--lang', 'fr-CH']]);
  h.child.stdout.write('{"kind":"listening"}\n2026-10-24 No Assistant asset\n{"kind":"heard","text":"comptabilise"}\n{"kind":"ended","error":"noOnDevice"}\n');
  await tick();
  h.close(0);
  await tick();
  assert.deepEqual(h.events, [{ kind: 'listening' }, { kind: 'heard', text: 'comptabilise' }, { kind: 'ended', error: 'noOnDevice' }]);
});

test('a microphone that gave only silence ends with its own cause and line, not as a silent end or as failed', () => {
  assert.deepEqual(parseEvent('{"kind":"ended","error":"noSound"}'), { kind: 'ended', error: 'noSound' });
  assert.match(messages['assistant.dictation.noSound'], /Mikrofon/);
});

test('a recognizer that crashes ends as failed; an unknown cause is read as failed', async () => {
  const h = fakeHelper();
  dictate('/bin/vd', 'de-CH', (e) => h.events.push(e), h.run);
  h.close(6);
  await tick();
  assert.deepEqual(h.events, [{ kind: 'ended', error: 'failed' }]);
  assert.deepEqual(parseEvent('{"kind":"ended","error":"rm -rf"}'), { kind: 'ended', error: 'failed' });
  assert.equal(parseEvent('{"kind":"heard"}'), undefined, 'a heard without text is no event');
});

test('stop asks the recognizer to finish the last words; one that hangs is killed, and that is no error', async () => {
  const h = fakeHelper();
  const stop = dictate('/bin/vd', 'de-CH', (e) => h.events.push(e), h.run, 20);
  stop();
  stop();
  await tick();
  assert.equal(h.stdin(), 'stop\n', 'the stop is said once');
  await tick(30);
  assert.equal(h.child.killed, true, 'a recognizer that does not end keeps the microphone: it must be killed');
  h.close(null);
  await tick();
  assert.deepEqual(h.events, [{ kind: 'ended' }], 'the person stopped it: no error line');
});

test('the page can only ask for a language tag, nothing the recognizer would read as an option', () => {
  assert.equal(isLang('de-CH'), true);
  assert.equal(isLang('--file'), false);
  assert.equal(isLang('de-CH --file /etc/passwd'), false);
});

test('the packed app asks with German usage texts, carries the recognizer, and may hear when signed', () => {
  const config = createRequire(import.meta.url)('../desktop/electron-builder.config.cjs');
  assert.match(config.mac.extendInfo.NSMicrophoneUsageDescription, /Mikrofon/);
  assert.match(config.mac.extendInfo.NSSpeechRecognitionUsageDescription, /Mac/);
  assert.deepEqual(config.mac.extraFiles, [{ from: 'out/desktop/vanilla-dictation', to: 'MacOS/vanilla-dictation' }]);
  assert.match(readFileSync('desktop/entitlements.mac.plist', 'utf8'), /<key>com\.apple\.security\.device\.audio-input<\/key>\s*<true\/>/);
});
