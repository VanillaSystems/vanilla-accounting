/**
 * A browser test's Chrome is gone after closeChrome even when Chrome never finishes closing: the process the test
 * started is killed, so the test file's process can end.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import type { Browser } from 'puppeteer-core';
import { closeChrome } from './support/browser.js';

test('a browser that never finishes closing is killed by the pid it was started with', { timeout: 10_000 }, async () => {
  const chrome = spawn('sleep', ['100000'], { stdio: 'ignore' });
  const browser = { close: () => new Promise<void>(() => {}), process: () => chrome } as unknown as Browser;
  const exited = once(chrome, 'exit');
  await closeChrome(browser, 100);
  const [, signal] = await exited;
  assert.equal(signal, 'SIGKILL');
});

test('a browser that closes is not killed', async () => {
  const chrome = spawn('sleep', ['100000'], { stdio: 'ignore' });
  const browser = { close: async () => { chrome.kill('SIGTERM'); await once(chrome, 'exit'); }, process: () => chrome } as unknown as Browser;
  await closeChrome(browser, 5_000);
  assert.equal(chrome.signalCode, 'SIGTERM');
});
