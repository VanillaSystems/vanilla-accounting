/**
 * Packaging the desktop app (npm run desktop:build): a .dmg each for Apple silicon and Intel.
 * Signed and notarized only when the variables are set (docs/desktop.md); without them the app is
 * built unsigned, and macOS asks once before the first start.
 */
const env = process.env;
const signed = Boolean(env.CSC_LINK);
const notarize = signed && Boolean(env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID);
/** owner/repo of the GitHub releases the app updates from; without it the app has no update feed. */
const releases = env.VANILLA_RELEASES?.split('/');

module.exports = {
  appId: 'org.vanilla-accounting.desktop',
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
    'demo/**/*',
    'examples/cases/**/*',
    'src/server/scan.html',
    'src/app/i18n/locales/*.ts',
    'public-files.txt',
    '!node_modules/{react,react-dom,scheduler}/**/*',
    '!node_modules/@fontsource/{geist-mono,hanken-grotesk,instrument-sans}/**/*',
  ],
  asar: true,
  mac: {
    category: 'public.app-category.finance',
    icon: 'desktop/icon.png',
    target: [{ target: 'dmg', arch: ['arm64', 'x64'] }],
    hardenedRuntime: true,
    entitlements: 'desktop/entitlements.mac.plist',
    entitlementsInherit: 'desktop/entitlements.mac.plist',
    // null: no signing, even when the keychain holds an identity.
    identity: signed ? undefined : null,
    notarize,
  },
  dmg: { artifactName: '${productName}-${version}-${arch}.${ext}' },
  // electron-updater reads its feed from here; the app checks only when package.json's desktop.autoUpdate is on.
  publish: releases?.length === 2 ? { provider: 'github', owner: releases[0], repo: releases[1] } : null,
};
