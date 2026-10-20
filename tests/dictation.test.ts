/**
 * The chat's microphone (src/app/assistant/dictation.ts): what was heard joins what was typed, the
 * recognizer listens in the person's language, and only a real failure shows a line. Each test
 * names the wrong behaviour it catches.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dictationError, dictationLang, recognizer, withHeard } from '../src/app/assistant/dictation.js';

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
