/**
 * Dependencies of the app that the desktop app does not pack, and with them every package only
 * they need (from package-lock.json). The app's code imports each of them only dynamically, on a
 * path the desktop app does not take; tools/desktop/build.mjs fails when the bundle imports one
 * statically.
 */
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const NOT_PACKED = {
  // Invoice PDFs: the desktop app prints with Electron's own Chromium (src/desktop/print.ts).
  'puppeteer-core': 'src/invoices/pdf.ts',
  // pdf.js draws pages on it; the engine only reads text (src/parsers/pdf-text.ts).
  '@napi-rs/canvas': 'pdfjs-dist (optional)',
  // The company's own Chrome per session (npm run browser); the Mac app gets it with the web channel.
  'playwright-core': 'src/platform/browser/chrome.ts',
  // Mail sources run under npm start and the CLI; the Mac app runs no source yet (ADR 0014, unit 2b).
  imapflow: 'src/platform/sources/mail-channel.ts',
  mailparser: 'src/platform/sources/mail-channel.ts',
};

/** The lockfile paths (node_modules/…) of the packages reachable from the app's dependencies without passing `skip`. */
function reachable(lock, skip) {
  const seen = new Set();
  // Node's lookup: the package's own node_modules, then each enclosing one up to the top.
  const resolve = (from, name) => {
    for (let dir = from; ;) {
      const path = dir ? `${dir}/node_modules/${name}` : `node_modules/${name}`;
      if (lock.packages[path]) return path;
      if (!dir) return undefined;
      const cut = dir.lastIndexOf('/node_modules/');
      dir = cut < 0 ? '' : dir.slice(0, cut);
    }
  };
  const visit = (from, deps) => {
    for (const name of Object.keys(deps ?? {})) {
      if (skip.has(name)) continue;
      const path = resolve(from, name);
      if (!path || seen.has(path)) continue;
      seen.add(path);
      const pkg = lock.packages[path];
      visit(path, { ...pkg.dependencies, ...pkg.optionalDependencies });
    }
  };
  visit('', lock.packages[''].dependencies);
  return seen;
}

/** electron-builder `files` patterns that leave out the not-packed packages and what only they need. */
function excludedPaths(root) {
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const all = reachable(lock, new Set());
  const kept = reachable(lock, new Set(Object.keys(NOT_PACKED)));
  return [...all].filter((p) => !kept.has(p)).sort();
}

module.exports = { NOT_PACKED, excludedPaths };
