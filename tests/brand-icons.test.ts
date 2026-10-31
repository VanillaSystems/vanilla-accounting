/**
 * The app's icons are the brand's (desktop/brand-icons.json, tools/brand/icons.mjs): every pinned
 * file matches its hash, and no icon the app shipped before (the receipt with a check) is tracked
 * anywhere. An old icon put back by a merge or a copy fails here and in desktop:build.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error a plain .mjs tool without types
import { iconProblems } from '../tools/brand/icons.mjs';

test('every icon in the repository is the brand\'s', () => {
  assert.deepEqual(iconProblems('.'), []);
});

test('the receipt icon put back is refused', () => {
  const root = mkdtempSync(join(tmpdir(), 'icons-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-q');
  const pin = JSON.parse(readFileSync('desktop/brand-icons.json', 'utf8')) as { files: Record<string, string>; retired: string[] };
  execFileSync('mkdir', ['-p', join(root, 'desktop')]);
  writeFileSync(join(root, 'desktop/brand-icons.json'), JSON.stringify({ ...pin, files: { 'desktop/icon.png': pin.files['desktop/icon.png'] } }));
  const receipt = execFileSync('git', ['show', '7227869:desktop/icon.png']);
  writeFileSync(join(root, 'desktop/icon.png'), receipt);
  copyFileSync('desktop/icon.png', join(root, 'desktop/wave.png'));
  git('add', '.');
  assert.deepEqual(iconProblems(root), [
    'desktop/icon.png is not the brand\'s icon (copy it again: node tools/brand/icons.mjs <branding repo>)',
    'desktop/icon.png is a retired icon',
  ]);
});
