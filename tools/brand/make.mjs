// The app's brand files, copied from the Vanilla Machines brand repository (docs/brand.md):
//   node tools/brand/make.mjs <path to the brand repo>
// The brand renders its icons itself (`npm run icons` there); the app takes them byte for byte.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const brandRoot = process.argv[2];
if (!brandRoot || !existsSync(join(brandRoot, 'brand.json'))) {
  console.error('usage: node tools/brand/make.mjs <path to the brand repo (the folder with brand.json)>');
  process.exit(1);
}

const icons = (f) => join(brandRoot, 'assets/app-icons', f);
const generated = (f) => join(brandRoot, 'assets/generated', f);
const appicon = 'ios/Accounting/Assets.xcassets/AppIcon.appiconset';
const IOS = [['AppIcon-1024.png', null], ['AppIcon-dark-1024.png', 'dark'], ['AppIcon-tinted-1024.png', 'tinted']];

/** Path in the app ← file in the brand repo. */
const FILES = {
  'desktop/icon.icns': icons('macos/AppIcon.icns'),
  'desktop/icon.ico': icons('windows/app.ico'),
  // The dock's icon when the app runs unpacked (src/desktop/main.ts).
  'desktop/icon.png': icons('macos/AppIcon-1024.png'),
  'public/favicon.svg': icons('web/favicon.svg'),
  'public/favicon.ico': icons('web/favicon.ico'),
  'public/apple-touch-icon.png': icons('web/apple-touch-icon.png'),
  ...Object.fromEntries(IOS.map(([name]) => [`${appicon}/${name}`, icons(`ios/${name}`)])),
  // Start screen, About, loading and empty states (src/app/brand/).
  'src/app/brand/assets/lockup.svg': join(brandRoot, 'assets/logo/vanilla-accounting/vanilla-accounting-logo-blue.svg'),
  'src/app/brand/assets/lockup-on-dark.svg': generated('vanilla-accounting/vanilla-accounting-logo-on-dark.svg'),
  'src/app/brand/assets/icon.svg': generated('vanilla-accounting/vanilla-accounting-icon-macos.svg'),
  'src/app/brand/assets/seal-muted.svg': generated('badge/swiss-engineering-muted.svg'),
  'src/app/brand/assets/seal-muted-on-dark.svg': generated('badge/swiss-engineering-muted-on-dark.svg'),
  'src/app/brand/assets/wave-black.svg': join(brandRoot, 'assets/mark/wave-black.svg'),
  // The README header and the GitHub social preview.
  'docs/logo.svg': join(brandRoot, 'assets/logo/vanilla-accounting/vanilla-accounting-logo-blue.svg'),
  'docs/swiss-engineering.svg': join(brandRoot, 'assets/badge/swiss-engineering.svg'),
  'docs/social-preview.png': icons('social-preview-1280x640.png'),
};
const missing = Object.values(FILES).filter((f) => !existsSync(f));
if (missing.length) throw new Error(`missing in the brand repo (run \`npm run icons\` there):\n${missing.join('\n')}`);

for (const f of readdirSync(join(APP, appicon))) if (f.endsWith('.png')) rmSync(join(APP, appicon, f));
for (const [to, from] of Object.entries(FILES)) {
  mkdirSync(dirname(join(APP, to)), { recursive: true });
  copyFileSync(from, join(APP, to));
}
// iPhone: one 1024 image per appearance (light, dark, tinted); iOS scales and masks it.
writeFileSync(join(APP, appicon, 'Contents.json'), JSON.stringify({
  images: IOS.map(([filename, luminosity]) => ({
    ...(luminosity ? { appearances: [{ appearance: 'luminosity', value: luminosity }] } : {}),
    filename, idiom: 'universal', platform: 'ios', size: '1024x1024',
  })),
  info: { author: 'xcode', version: 1 },
}, null, 2) + '\n');

// The README's deploy button (the brand's Applications page): a black pill, the white wave on the
// left, Instrument Sans 600, 8 px radius. GitHub shows an SVG as an image, so the font travels inside.
const wave = readFileSync(join(brandRoot, 'assets/mark/wave-white.svg'), 'utf8').match(/<path [^>]*\/>/)[0];
const font = readFileSync(join(APP, 'node_modules/@fontsource/instrument-sans/files/instrument-sans-latin-600-normal.woff2')).toString('base64');
writeFileSync(join(APP, 'docs/deploy-button.svg'), `<svg xmlns="http://www.w3.org/2000/svg" width="252" height="36" viewBox="0 0 252 36" role="img" aria-label="Deploy to Vanilla Machines">
<style>@font-face{font-family:"Instrument Sans";font-weight:600;src:url(data:font/woff2;base64,${font}) format("woff2")}</style>
<rect width="252" height="36" rx="8" fill="#000000"/>
<svg x="14" y="11" width="19" height="14" viewBox="0.437 -0.001 41.473 30.612">${wave}</svg>
<text x="42" y="22.5" textLength="196" lengthAdjust="spacingAndGlyphs" fill="#FFFFFF" font-family="Instrument Sans, sans-serif" font-weight="600" font-size="14">Deploy to Vanilla Machines</text>
</svg>
`);

const { version } = JSON.parse(readFileSync(join(brandRoot, 'brand.json'), 'utf8'));
console.log(`brand ${version}: ${Object.keys(FILES).length} files copied, the iPhone icon set written`);
