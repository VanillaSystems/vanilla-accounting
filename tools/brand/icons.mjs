/**
 * The app's icons are the brand's, copied from the branding repository and pinned by hash:
 *
 *   node tools/brand/icons.mjs ../../VanillaMachines/261011-branding    copy, render iOS sizes, pin
 *   node tools/brand/icons.mjs --check                                  verify (tests and desktop:build)
 *
 * desktop/brand-icons.json lists each icon file with its SHA-256, and the hashes of every icon the
 * app shipped before (the receipt with a check, the red wave). A copy moves the hashes it replaces
 * into `retired`, so an old icon can never come back: the check fails on any tracked image that
 * matches a retired hash, and desktop:build refuses to pack an icon that is not pinned.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PIN = 'desktop/brand-icons.json';
const IOS = 'ios/Belege/Assets.xcassets/AppIcon.appiconset';
const COPIES = {
  'desktop/icon.png': 'macos/AppIcon-1024.png',
  'desktop/icon.svg': 'macos/AppIcon.svg',
  'public/favicon.svg': 'web/favicon.svg',
  'public/favicon.ico': 'web/favicon.ico',
  'public/favicon-192.png': 'web/icon-192.png',
  'public/apple-touch-icon.png': 'web/apple-touch-icon.png',
  [`${IOS}/AppIcon-1024.png`]: 'ios/AppIcon-1024.png',
};
const IOS_SIZES = [40, 58, 60, 80, 87, 120, 180];

const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** What is wrong with the icons in `root`; empty when every pinned file matches and no retired icon is tracked. */
export function iconProblems(root = '.') {
  const pin = JSON.parse(readFileSync(join(root, PIN), 'utf8'));
  const problems = [];
  for (const [file, hash] of Object.entries(pin.files)) {
    if (!existsSync(join(root, file))) problems.push(`${file} is missing`);
    else if (sha(join(root, file)) !== hash) problems.push(`${file} is not the brand's icon (copy it again: node tools/brand/icons.mjs <branding repo>)`);
  }
  const retired = new Set(pin.retired);
  const tracked = execFileSync('git', ['ls-files', '-z', '--', '*.png', '*.svg', '*.ico', '*.icns'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  for (const file of tracked) if (existsSync(join(root, file)) && retired.has(sha(join(root, file)))) problems.push(`${file} is a retired icon`);
  return problems;
}

function copy(brand) {
  const pin = JSON.parse(readFileSync(PIN, 'utf8'));
  const before = Object.values(pin.files);
  for (const [to, from] of Object.entries(COPIES)) copyFileSync(join(brand, 'assets/app-icons', from), to);
  for (const px of IOS_SIZES) execFileSync('sips', ['-s', 'format', 'png', '-z', String(px), String(px), `${IOS}/AppIcon-1024.png`, '--out', `${IOS}/AppIcon-${px}.png`], { stdio: 'ignore' });
  const files = Object.fromEntries([...Object.keys(COPIES), ...IOS_SIZES.map((px) => `${IOS}/AppIcon-${px}.png`)].sort().map((f) => [f, sha(f)]));
  const now = new Set(Object.values(files));
  const retired = [...new Set([...pin.retired, ...before])].filter((h) => !now.has(h)).sort();
  writeFileSync(PIN, `${JSON.stringify({ source: pin.source, files, retired }, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = process.argv[2];
  if (arg && arg !== '--check') copy(arg);
  const problems = iconProblems();
  if (problems.length) { console.error(`Icons:\n  ${problems.join('\n  ')}`); process.exit(1); }
  console.log('icons: the brand\'s, none retired');
}
