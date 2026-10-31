import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { browserCandidates, chromeForTesting } from '../src/invoices/pdf.js';

function place(file: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '');
}

test('the newest chromium build with a program wins, compared as numbers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ms-playwright-'));
  place(join(dir, 'chromium-999/chrome-linux/chrome'));
  place(join(dir, 'chromium-1234/chrome-linux64/chrome'));
  mkdirSync(join(dir, 'chromium-1300'));
  place(join(dir, 'chromium_headless_shell-1400/chrome-linux/chrome'));
  assert.equal(chromeForTesting('linux', { PLAYWRIGHT_BROWSERS_PATH: dir }), join(dir, 'chromium-1234/chrome-linux64/chrome'));
});

test('without PLAYWRIGHT_BROWSERS_PATH the cache under the home folder is read; none there is none', () => {
  const home = mkdtempSync(join(tmpdir(), 'home-'));
  assert.equal(chromeForTesting('darwin', {}, home), undefined);
  const program = join(home, 'Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
  place(program);
  assert.equal(chromeForTesting('darwin', {}, home), program);
});

test('the app tries CHROME_PATH, then Chrome for Testing, then the installed browsers', () => {
  const home = mkdtempSync(join(tmpdir(), 'home-'));
  const program = join(home, 'Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
  place(program);
  assert.deepEqual(browserCandidates('darwin', { CHROME_PATH: '/opt/chrome' }, home).slice(0, 3),
    ['/opt/chrome', program, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']);
});
