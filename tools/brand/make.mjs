// The app's brand files, rendered from the Vanilla Machines brand repository (docs/brand.md):
//   node tools/brand/make.mjs <path to the brand repo>
// Copies the SVGs the app shows as they are and rasterizes the icons with the installed Chrome.
import { createRequire } from 'node:module';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const brandRoot = process.argv[2];
if (!brandRoot || !existsSync(join(brandRoot, 'brand.json'))) {
  console.error('usage: node tools/brand/make.mjs <path to the brand repo (the folder with brand.json)>');
  process.exit(1);
}
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const puppeteer = createRequire(join(APP, 'package.json'))('puppeteer-core');

const product = (f) => join(brandRoot, 'assets/generated/vanilla-accounting', `vanilla-accounting-${f}.svg`);
const SRC = {
  icon: product('icon'),
  iconDark: product('icon-dark'),
  iconTinted: product('icon-tinted'),
  iconMac: product('icon-macos'),
  favicon: product('favicon'),
  lockup: join(brandRoot, 'assets/logo/vanilla-accounting/vanilla-accounting-logo-blue.svg'),
  lockupOnDark: product('logo-on-dark'),
  seal: join(brandRoot, 'assets/badge/swiss-engineering.svg'),
  sealMuted: join(brandRoot, 'assets/generated/badge/swiss-engineering-muted.svg'),
  sealMutedOnDark: join(brandRoot, 'assets/generated/badge/swiss-engineering-muted-on-dark.svg'),
  waveBlack: join(brandRoot, 'assets/mark/wave-black.svg'),
};
for (const f of Object.values(SRC)) if (!existsSync(f)) throw new Error(`missing in the brand repo: ${f}`);

const out = (p) => {
  const file = join(APP, p);
  mkdirSync(dirname(file), { recursive: true });
  return file;
};
const copy = (from, to) => copyFileSync(from, out(to));

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage();

/** The SVG file drawn at px × px; transparent where the SVG is. */
async function png(svgFile, px) {
  const data = Buffer.from(readFileSync(svgFile)).toString('base64');
  await page.setViewport({ width: px, height: px, deviceScaleFactor: 1 });
  await page.setContent(`<html><body style="margin:0;background:transparent"><img style="display:block;width:${px}px;height:${px}px" src="data:image/svg+xml;base64,${data}"></body></html>`);
  await page.waitForFunction(() => document.images[0].complete);
  return Buffer.from(await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: px, height: px } }));
}

/** An .ico of PNG images (Windows Vista and later read PNG entries). */
function ico(images) {
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach(({ px, buf }, i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(px >= 256 ? 0 : px, e);
    head.writeUInt8(px >= 256 ? 0 : px, e + 1);
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(buf.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += buf.length;
  });
  return Buffer.concat([head, ...images.map((x) => x.buf)]);
}
const icoOf = async (svgFile, sizes) => ico(await Promise.all(sizes.map(async (px) => ({ px, buf: await png(svgFile, px) }))));

// iOS rejects an app icon with an alpha channel; ImageMagick flattens it onto the icon's own ground.
function opaque(file) {
  execFileSync('magick', [file, '-alpha', 'off', `PNG24:${file}`]);
}

// macOS: the brand's macOS icon (tile with margin and shadow); at 16 and 32 px its favicon, a full
// tile whose wave stays readable that small.
const iconset = join(tmpdir(), `vanilla-accounting-${process.pid}.iconset`);
mkdirSync(iconset, { recursive: true });
for (const base of [16, 32, 128, 256, 512]) {
  for (const [scale, suffix] of [[1, ''], [2, '@2x']]) {
    const px = base * scale;
    writeFileSync(join(iconset, `icon_${base}x${base}${suffix}.png`), await png(px <= 32 ? SRC.favicon : SRC.iconMac, px));
  }
}
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', out('desktop/icon.icns')]);
rmSync(iconset, { recursive: true });
// The About panel's icon and the dock's when the app runs unpacked (src/desktop/main.ts).
writeFileSync(out('desktop/icon.png'), await png(SRC.iconMac, 512));
// Windows: the rounded tile, as the favicon draws it.
writeFileSync(out('desktop/icon.ico'), await icoOf(SRC.favicon, [16, 24, 32, 48, 64, 128, 256]));

// Browser tab, home-screen bookmark.
copy(SRC.favicon, 'public/favicon.svg');
writeFileSync(out('public/favicon.ico'), await icoOf(SRC.favicon, [16, 32, 48]));
writeFileSync(out('public/apple-touch-icon.png'), await png(SRC.icon, 180));

// iPhone: one 1024 image per appearance (light, dark, tinted); iOS scales and masks it.
const appicon = 'ios/Belege/Assets.xcassets/AppIcon.appiconset';
for (const f of readdirSync(join(APP, appicon))) if (f.endsWith('.png')) rmSync(join(APP, appicon, f));
const IOS = [['AppIcon-1024.png', SRC.icon, null], ['AppIcon-dark-1024.png', SRC.iconDark, 'dark'], ['AppIcon-tinted-1024.png', SRC.iconTinted, 'tinted']];
for (const [name, svg] of IOS) {
  writeFileSync(out(`${appicon}/${name}`), await png(svg, 1024));
  opaque(join(APP, appicon, name));
}
writeFileSync(out(`${appicon}/Contents.json`), JSON.stringify({
  images: IOS.map(([filename, , luminosity]) => ({
    ...(luminosity ? { appearances: [{ appearance: 'luminosity', value: luminosity }] } : {}),
    filename, idiom: 'universal', platform: 'ios', size: '1024x1024',
  })),
  info: { author: 'xcode', version: 1 },
}, null, 2) + '\n');

// In the app: start screen, About, loading and empty states (src/app/brand/).
copy(SRC.lockup, 'src/app/brand/assets/lockup.svg');
copy(SRC.lockupOnDark, 'src/app/brand/assets/lockup-on-dark.svg');
copy(SRC.iconMac, 'src/app/brand/assets/icon.svg');
copy(SRC.sealMuted, 'src/app/brand/assets/seal-muted.svg');
copy(SRC.sealMutedOnDark, 'src/app/brand/assets/seal-muted-on-dark.svg');
copy(SRC.waveBlack, 'src/app/brand/assets/wave-black.svg');

// The README header and the GitHub social preview (the lockup on white, 1280 × 640).
copy(SRC.lockup, 'docs/logo.svg');
copy(SRC.seal, 'docs/swiss-engineering.svg');
const lockup = Buffer.from(readFileSync(SRC.lockup)).toString('base64');
await page.setViewport({ width: 1280, height: 640, deviceScaleFactor: 1 });
await page.setContent(`<html><body style="margin:0;width:1280px;height:640px;background:#fff;display:grid;place-items:center"><img style="width:760px" src="data:image/svg+xml;base64,${lockup}"></body></html>`);
await page.waitForFunction(() => document.images[0].complete);
writeFileSync(out('docs/social-preview.png'), await page.screenshot({ clip: { x: 0, y: 0, width: 1280, height: 640 } }));

await browser.close();
const { version } = JSON.parse(readFileSync(join(brandRoot, 'brand.json'), 'utf8'));
console.log(`brand ${version}: icons, iOS app icon, in-app SVGs, README logo and social preview written`);
