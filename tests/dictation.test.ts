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
import { dictated, dictationError, dictationLang, fieldAt, follow, onDevice, recognizer, webHeard } from '../src/app/assistant/dictation.js';
import { dictate, isLang, parseEvent } from '../src/desktop/dictation.js';
import type { DesktopBridge, DictationEvent } from '../src/types/desktop.js';
import type { Field } from '../src/app/assistant/dictation.js';
import { messages } from '../src/app/i18n/locales/de.js';
import { elapsed } from '../src/app/assistant/Recording.js';

const said = (text: string, partial = '') => ({ text, partial });
/** The field with the caret between `before` and `after`. */
const caretAt = (before: string, after = '') => fieldAt(before + after, before.length, before.length);
const value = (before: string, heard: { text: string; partial: string }, after = '') => dictated(caretAt(before, after), heard).field.text;
/** The field's provisional words, as the person sees them paler. */
const provisional = (before: string, heard: { text: string; partial: string }, after = '') => {
  const d = dictated(caretAt(before, after), heard);
  return d.field.text.slice(d.partial.start, d.partial.end);
};

test('what was heard follows what was typed, one space between, never glued or doubled', () => {
  assert.equal(value('', said(' buch das  auf Telefon ')), 'buch das auf Telefon');
  assert.equal(value('Swisscom:', said('immer auf 6510')), 'Swisscom: immer auf 6510', 'glued to the typed word');
  assert.equal(value('Swisscom: ', said('immer auf 6510')), 'Swisscom: immer auf 6510', 'a second space');
  assert.equal(value('Swisscom', said('  ')), 'Swisscom', 'silence must not touch what was typed');
});

test('what was heard goes where the caret was: the typed text after it stays after it', () => {
  assert.equal(value('Buch ', said('die Swisscom'), 'auf 6510'), 'Buch die Swisscom auf 6510', 'glued to the text after the caret');
  assert.equal(value('Buch', said('die Swisscom'), ' auf 6510'), 'Buch die Swisscom auf 6510', 'a second space before the text after');
  assert.equal(value('Buch ', said(''), 'auf 6510'), 'Buch auf 6510', 'nothing heard yet leaves the text as it was');
  const d = dictated(caretAt('Buch', ' auf 6510'), said('die Swisscom'));
  assert.equal(d.caret, 'Buch die Swisscom'.length, 'after dictating, the caret follows what was heard, not the end');
});

test('a selection is replaced by what was heard, and kept while nothing was heard', () => {
  const selected = fieldAt('Buch die Migros auf 6510', 9, 15);
  assert.equal(dictated(selected, said('Swisscom')).field.text, 'Buch die Swisscom auf 6510');
  assert.equal(dictated(selected, said('')).field.text, 'Buch die Migros auf 6510', 'silence must not delete the selected words');
  assert.equal(dictated(selected, said('  ', ' ')).field.text, 'Buch die Migros auf 6510');
});

test('the words still being spoken show as provisional; settled words never twice, the guess replaced', () => {
  assert.equal(value('', said('', 'Guten')), 'Guten');
  assert.equal(provisional('', said('', 'Guten')), 'Guten', 'the guess must look provisional');
  assert.equal(value('', said('Guten Tag,', ' ich möchte')), 'Guten Tag, ich möchte', 'settled and guess together, once each');
  assert.equal(provisional('', said('Guten Tag,', ' ich möchte')), ' ich möchte', 'only the guess is pale, not the settled words');
  assert.equal(value('', said('Guten Tag, ich möchte eine Rechnung buchen.')), 'Guten Tag, ich möchte eine Rechnung buchen.', 'the settled words replace the guess, not join it');
  assert.equal(provisional('', said('Guten Tag, ich möchte eine Rechnung buchen.')), '', 'settled words are no longer pale');
  assert.equal(provisional('Notiz:', said('Guten ', ' Tag'), ' Ende'), ' Tag', 'a space at the seam is not counted twice');
  assert.equal(value('Notiz:', said('Guten ', ' Tag'), ' Ende'), 'Notiz: Guten Tag Ende');
});

/**
 * The composer between recognizer updates: the person may type, leaving the field at `now`, before
 * the next snapshot arrives. Each update gives the field after it, or undefined once dictation let go.
 */
function session(start: Field) {
  let field: Field | undefined = start;
  return {
    heard(h: { text: string; partial: string }, now = field?.text ?? '') {
      const typed = field && follow(field, now);
      field = typed && dictated(typed, h).field;
      return field?.text;
    },
  };
}

test('typing before the dictated words between two updates is kept; the next words go where the dictation is', () => {
  const s = session(caretAt('Buch ', 'auf 6510'));
  assert.equal(s.heard(said('', 'die')), 'Buch die auf 6510');
  assert.equal(s.heard(said('die Swisscom'), 'Bitte: Buch die auf 6510'), 'Bitte: Buch die Swisscom auf 6510', 'the typed «Bitte:» must survive the next update');
});

test('typing after the dictated words between two updates is kept after them', () => {
  const s = session(caretAt(''));
  assert.equal(s.heard(said('', 'Guten')), 'Guten');
  assert.equal(s.heard(said('Guten Tag'), 'Guten, danke'), 'Guten Tag, danke', 'the typed «, danke» must survive the next update');
  assert.equal(s.heard(said('Guten Tag', ' ich'), 'Guten Tag, danke!'), 'Guten Tag ich, danke!', 'a second edit after a second update is kept too');
});

test('a change to the dictated words themselves stays as the person made it: dictation lets go', () => {
  const s = session(caretAt('Buch ', 'auf 6510'));
  assert.equal(s.heard(said('', 'die Swisscon')), 'Buch die Swisscon auf 6510');
  assert.equal(s.heard(said('die Swisscom immer'), 'Buch die Swisscom auf 6510'), undefined, 'the person corrected a dictated word: the update must not overwrite it');
  assert.equal(follow(fieldAt('Buch die auf', 5, 8), 'Buch dXe auf'), undefined);
  assert.equal(follow(fieldAt('Buch die auf', 5, 8), 'Buch auf'), undefined, 'deleting the dictated words is the person\'s change too');
});

test('a selection replaced by dictation still is, also after typing elsewhere; silence keeps it and the typing', () => {
  const s = session(fieldAt('Buch die Migros auf 6510', 9, 15));
  assert.equal(s.heard(said('', 'Swiss')), 'Buch die Swiss auf 6510');
  assert.equal(s.heard(said('Swisscom'), 'Bitte buch die Swiss auf 6510'), 'Bitte buch die Swisscom auf 6510');
  const quiet = session(fieldAt('Buch die Migros auf 6510', 9, 15));
  assert.equal(quiet.heard(said('')), 'Buch die Migros auf 6510', 'silence must not delete the selection');
  assert.equal(quiet.heard(said(' ', ''), 'Buch die Migros auf 6510 sofort'), 'Buch die Migros auf 6510 sofort', 'silence must leave typing as it is');
  const guess = session(caretAt('Notiz: '));
  guess.heard(said('', 'Gute'));
  assert.equal(guess.heard(said('', '')), 'Notiz: ', 'a guess the recognizer takes back leaves the field as it was');
});

test('in the browser, final results are settled and interim ones the guess after them', () => {
  const results = (...r: [string, boolean][]) => Object.assign(r.map(([t, isFinal]) => ({ isFinal, 0: { transcript: t } })), { length: r.length });
  assert.deepEqual(webHeard(results(['Guten Tag', true], [' ich möchte', false])), said('Guten Tag', ' ich möchte'));
  assert.deepEqual(webHeard(results(['Guten', false])), said('', 'Guten'));
  assert.deepEqual(webHeard(results(['Guten Tag', true], ['ich buche', true])), said('Guten Tag ich buche'), 'two final results joined by one space');
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
  ear.start('de-CH', {
    heard: (h) => log.push(`heard ${h.text}|${h.partial}`),
    ended: (e) => log.push(`ended ${e ?? ''}`),
    preparing: (p) => log.push(`preparing ${p}`),
    level: (l) => log.push(`level ${l}`),
  });
  return { send: (e: DictationEvent) => send(e), blur: () => [...blurs].forEach((f) => f()), stops: () => stops, log, blurs };
}

test('on the Mac: loading the language shows, the voice\'s level and the words arrive while speaking, a refusal names its cause', () => {
  const m = macEar();
  m.send({ kind: 'preparing' });
  m.send({ kind: 'listening' });
  m.send({ kind: 'level', level: 0.7 });
  m.send({ kind: 'heard', text: '', partial: 'Buch die' });
  m.send({ kind: 'heard', text: 'Buch die Swisscom', partial: '' });
  m.send({ kind: 'ended', error: 'micDenied' });
  assert.deepEqual(m.log, ['preparing true', 'preparing false', 'level 0.7', 'heard |Buch die', 'heard Buch die Swisscom|', 'preparing false', 'ended micDenied']);
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
  h.child.stdout.write('{"kind":"listening"}\n2026-10-24 No Assistant asset\n{"kind":"level","level":0.42}\n{"partial":"compta","text":"","kind":"heard"}\n{"kind":"ended","error":"noOnDevice"}\n');
  await tick();
  h.close(0);
  await tick();
  assert.deepEqual(h.events, [{ kind: 'listening' }, { kind: 'level', level: 0.42 }, { kind: 'heard', text: '', partial: 'compta' }, { kind: 'ended', error: 'noOnDevice' }]);
});

test('a level is a loudness from 0 to 1: anything else from the recognizer is clamped or dropped', () => {
  assert.deepEqual(parseEvent('{"kind":"level","level":1.7}'), { kind: 'level', level: 1 }, 'a ring must not outgrow the button');
  assert.deepEqual(parseEvent('{"kind":"level","level":-0.2}'), { kind: 'level', level: 0 });
  assert.equal(parseEvent('{"kind":"level","level":"loud"}'), undefined);
  assert.equal(parseEvent('{"kind":"level"}'), undefined);
  assert.equal(parseEvent('null'), undefined, 'a line that is JSON but no object is no event, not a crash');
  assert.equal(parseEvent('{"kind":"heard","text":"Buch"}'), undefined, 'a heard without its partial is no event');
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

test('the recording\'s clock reads minutes and two-digit seconds', () => {
  assert.deepEqual([0, 7, 59, 60, 90, 724].map(elapsed), ['0:00', '0:07', '0:59', '1:00', '1:30', '12:04']);
});
