/**
 * Packaging the desktop app (npm run desktop:build): a .dmg each for Apple silicon and Intel.
 * Signed and notarized only when the variables are set (docs/desktop.md); without them the app is
 * built unsigned, and macOS asks once before the first start.
 */
const { join } = require('node:path');
const { excludedPaths } = require('./not-packed.cjs');

const env = process.env;
const signed = Boolean(env.CSC_LINK);
const notarize = signed && Boolean(env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID);
/** owner/repo of the GitHub releases the app updates from; without it the app has no update feed. */
const releases = env.VANILLA_RELEASES?.split('/');

module.exports = {
  appId: 'org.vanilla-accounting.desktop',
  // The brand's names per surface (21-accounting-devices): Finder, Dock, Launchpad, the Windows Start
  // menu and the installer show the full name; the macOS menu bar the short one (CFBundleName, ≤ 15).
  // Proper names, never translated, so no InfoPlist.strings per language.
  productName: 'Vanilla Accounting',
  directories: { output: 'release', buildResources: 'desktop' },
  // What the app reads at run time from its own folder (APP_ROOT): the bundle, the built UI and the
  // app's data files. Packages come from package.json's dependencies; the UI's own are in dist/.
  files: [
    'package.json',
    'out/desktop/*.{mjs,cjs}',
    'dist/**/*',
    'reference/**/*',
    'processes/**/*',
    'AGENTS.md',
    'demo/**/*',
    'examples/cases/**/*',
    'src/server/scan.html',
    'src/app/i18n/locales/*.ts',
    'public-files.txt',
    // The dock's icon when the app runs unpacked (src/desktop/main.ts).
    'desktop/icon.png',
    '!node_modules/{react,react-dom,scheduler}/**/*',
    '!node_modules/@fontsource/{geist-mono,hanken-grotesk,instrument-sans}/**/*',
    // Packages the desktop app does not use (not-packed.cjs) and the parts of packages it does
    // not load: pdf.js runs its legacy build only, pdf-lib its CommonJS one, the invoice sheet
    // inlines the Latin woff2 files only (src/invoices/fonts.ts).
    ...excludedPaths(join(__dirname, '..')).map((p) => `!${p}/**/*`),
    '!node_modules/pdfjs-dist/{build,web,image_decoders,types}/**/*',
    '!node_modules/pdfjs-dist/legacy/{web,image_decoders}/**/*',
    '!node_modules/pdfjs-dist/legacy/build/{*.min.mjs,pdf.sandbox*}',
    '!node_modules/pdf-lib/{dist,es,src,ts3.4}/**/*',
    '!node_modules/@pdf-lib/*/{dist,es,src}/**/*',
    '!node_modules/@fontsource/*/files/{*.woff,*-italic.woff2,*-{cyrillic,cyrillic-ext,greek,greek-ext,vietnamese,hebrew}-*}',
    '!node_modules/**/*.{map,d.ts,d.mts,d.cts}',
  ],
  asar: true,
  // The chat's Claude reads the app's rules and process guides with its own tools, which cannot look
  // into the archive (src/chat/claude.ts).
  asarUnpack: ['AGENTS.md', 'processes/**/*'],
  // Chromium's own translations only for the app's languages.
  electronLanguages: ['de', 'fr', 'it', 'en'],
  // Hardening of the release build: the app's binary cannot be run as Node, takes no NODE_OPTIONS
  // or --inspect, loads its code only from app.asar and checks that archive's hash at start.
  // tools/desktop/smoke.mjs drives the fused build through the renderer (docs/desktop.md).
  electronFuses: {
    runAsNode: false,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    grantFileProtocolExtraPrivileges: false,
    // An unsigned build is signed ad hoc again after the fuses change the binary, or macOS kills it.
    resetAdHocDarwinSignature: !signed,
  },
  mac: {
    category: 'public.app-category.finance',
    extendInfo: { CFBundleName: 'Accounting', CFBundleDisplayName: 'Vanilla Accounting' },
    icon: 'desktop/icon.icns',
    // electron-updater on macOS installs from a zip; built only when there is a feed to publish it to.
    target: [{ target: 'dmg', arch: ['arm64', 'x64'] }, ...(releases?.length === 2 ? [{ target: 'zip', arch: ['arm64', 'x64'] }] : [])],
    hardenedRuntime: true,
    entitlements: 'desktop/entitlements.mac.plist',
    entitlementsInherit: 'desktop/entitlements.mac.plist',
    // null: no signing, even when the keychain holds an identity.
    identity: signed ? undefined : null,
    notarize,
  },
  win: { icon: 'desktop/icon.ico' },
  dmg: { artifactName: '${productName}-${version}-${arch}.${ext}' },
  // electron-updater reads its feed from here; the app checks only when package.json's desktop.autoUpdate is on.
  publish: releases?.length === 2 ? { provider: 'github', owner: releases[0], repo: releases[1] } : null,
};
