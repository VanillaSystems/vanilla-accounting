/**
 * The company's own Chrome per session (src/platform/browser/chrome.ts): the first open starts the
 * installed Chrome on the session's profile folder, a second open finds it running and attaches
 * instead of starting another; what a page set (a cookie) is still there for the second; close ends
 * it. Skipped where no Chromium browser is installed. Headless, against a local page.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { closeSession, openSession, sessionDir } from '../src/platform/browser/chrome.js';
import { findBrowser } from '../src/invoices/pdf.js';

process.env.VANILLA_BROWSER_DIR = mkdtempSync(join(tmpdir(), 'browser-sessions-'));

test('a session starts Chrome once, a second open attaches, the profile keeps its cookie, close ends it', { skip: !findBrowser() && 'no Chromium browser installed' }, async () => {
  const server = createServer((_q, r) => { r.setHeader('set-cookie', 'signed=yes; Max-Age=3600'); r.end('<h1>in</h1>'); }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  try {
    const first = await openSession('test-shop', { url, headless: true });
    assert.equal(first.started, true);
    const page = first.browser.contexts()[0].pages()[0];
    await page.waitForLoadState('load');
    await first.detach();

    const second = await openSession('test-shop', { headless: true });
    assert.equal(second.started, false, 'the running Chrome is found through its profile folder');
    const cookies = await second.browser.contexts()[0].cookies(url);
    assert.deepEqual(cookies.map((c) => `${c.name}=${c.value}`), ['signed=yes']);
    await second.detach();

    assert.equal(await closeSession('test-shop'), true);
    assert.equal(await closeSession('test-shop'), false, 'nothing runs after close');
    assert.throws(() => sessionDir('../elsewhere'), /no session name/);
  } finally {
    await closeSession('test-shop').catch(() => undefined);
    server.close();
  }
});
