/**
 * A phone-wide window (r8c-8): the page says itself when it is as narrow as a phone (src/app/shell/look.ts,
 * like `.tight`), and the shell then lays out one column (list or detail, «←» back) with the dock
 * along the bottom (src/app/styles/shell.css under `html.phone`, src/app/shell/Shell.tsx `data-phone`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { phone } from '../src/app/shell/look.js';

test('a phone, or a small window zoomed in, is phone-wide; a tablet or a desktop is not', () => {
  assert.equal(phone(390, 1), true);
  assert.equal(phone(1100, 2), true);
  assert.equal(phone(1024, 1), false);
  assert.equal(phone(1440, 1.6), false);
});

test('the shell lays out one column on a phone: the other column hidden, the dock at the bottom, a way back to the list', () => {
  const css = readFileSync('src/app/styles/shell.css', 'utf8');
  assert.match(css, /html\.phone main\b[^{]*\{[^}]*grid-template-columns: minmax\(0, 1fr\)/, 'one column');
  assert.match(css, /html\.phone main\[data-phone="list"\] \.detail[^{]*\{[^}]*display: none/, 'the detail waits behind the list');
  assert.match(css, /html\.phone main\[data-phone="detail"\] \.list[^{]*\{[^}]*display: none/, 'the list steps aside for the detail');
  assert.match(css, /html\.phone \.activity\b[^{]*\{[^}]*bottom: 0/, 'the dock lies along the bottom');
  const shell = readFileSync('src/app/shell/Shell.tsx', 'utf8');
  assert.match(shell, /data-phone=\{/, 'the shell says which column shows');
  assert.match(shell, /className="phoneback"/, 'the detail has «←» back to the list');
});
