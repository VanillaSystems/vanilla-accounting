/**
 * The shell's keyboard (src/app/shell/keyboard.ts): which focused element keeps Enter and Space for
 * itself. A button, a link, a tab and a details summary do (the KI sidebar's «+», r7h-25); a list
 * row (`role=option`) does not, so ↵ on a selected row still opens the entry (r8c-7).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { takesOwnEnter } from '../src/app/shell/keyboard.js';

/** An element as `closest` sees it: its tag, its role, its attributes; nothing above it matches. */
const element = (tag: string, attrs: Record<string, string> = {}) => ({
  closest: (selectors: string) => (selectors.split(',').map((s) => s.trim()).some((s) => {
    const m = /^([a-z]*)((?:\[[^\]]+\])*)$/.exec(s);
    if (!m) return false;
    const [, name, attrPart] = m;
    if (name && name !== tag) return false;
    return [...attrPart.matchAll(/\[(\w+)(?:="([^"]*)")?\]/g)].every(([, k, v]) => (v === undefined ? k in attrs : attrs[k] === v));
  }) ? {} : null),
});

test('a focused button, link, tab or summary keeps Enter: the shell fires no shortcut (r7h-25)', () => {
  assert.equal(takesOwnEnter(element('button')), true);
  assert.equal(takesOwnEnter(element('a', { href: '/x' })), true);
  assert.equal(takesOwnEnter(element('div', { role: 'button' })), true);
  assert.equal(takesOwnEnter(element('button', { role: 'option' })), true, 'a customer option in the invoice dialog is a button');
  assert.equal(takesOwnEnter(element('summary')), true);
});

test('a focused list row (role=option) does not: ↵ on the selected row opens the entry (r8c-7)', () => {
  assert.equal(takesOwnEnter(element('div', { role: 'option', tabindex: '0' })), false);
  assert.equal(takesOwnEnter(element('div')), false);
  assert.equal(takesOwnEnter(null), false);
});
