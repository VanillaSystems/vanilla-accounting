/**
 * The app's icons are the brand's, copied from the branding repository and pinned by hash:
 *
 *   node tools/brand/icons.mjs ../../VanillaMachines/261011-branding    copy, pin
 *   node tools/brand/icons.mjs --check                                  verify (tests and desktop:build)
 *
 * The desktop and the web take the wave; the iPhone app (Vanilla Belege) takes its own set, the plain
 * receipt glyph of the Belege area, as three 1024 px masters (light, dark, tinted) from which Xcode
 * renders every size: the per-size form of an AppIcon set drops the dark and tinted appearances.
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
  [`${IOS}/AppIcon-1024.png`]: 'ios-belege/AppIcon-1024.png',
  [`${IOS}/AppIcon-dark-1024.png`]: 'ios-belege/AppIcon-dark-1024.png',
  [`${IOS}/AppIcon-tinted-1024.png`]: 'ios-belege/AppIcon-tinted-1024.png',
};

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
  const files = Object.fromEntries(Object.keys(COPIES).sort().map((f) => [f, sha(f)]));
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
