# The desktop app

Vanilla Accounting as a Mac app (ADR 0006, form 3): one window on the same UI and the same engine
as `npm start`, with no terminal, Node.js or Homebrew needed. The code is in `src/desktop/`.

## How it is built

| Part | File | What it does |
|---|---|---|
| Main process | `src/desktop/main.ts` | One instance; starts the server on 127.0.0.1; opens the window; the native menu; window place, port and last books in `desktop.json` of the user data folder. |
| Server | `src/desktop/server.ts` | `/api/desktop` (the start screen's routes), the built UI, and the books API (`src/server/api.ts`) once books are open. Opening other books switches the API in place. Requests naming another host are refused. |
| Start screen | `src/app/desktop/StartScreen.tsx` | At `/start` and whenever no books are open: open a folder, set up new books (the questions of `npm run init`, checked by `src/workspace/create.ts`), or open a copy of the demo. |
| Preload | `src/desktop/preload.ts` | The page's only bridge, `window.vanilla`: the folder dialog, menu commands (zoom), the UI language for the menu. Context isolation and the sandbox are on; the page has no Node. |
| PDFs | `src/desktop/print.ts` | Invoice and report PDFs printed by Electron's own Chromium in a hidden window (ADR 0012), so no browser has to be installed. `npm start` and the CLI keep printing with puppeteer-core. |
| claude CLI | `src/desktop/claude.ts` | Found through the person's login shell (an app from the Finder gets PATH `/usr/bin:/bin`); only its path is taken. Without it, model features answer with what to install (`noClaude`), everything else works. |

The port is kept from one start to the next, because the page stores theme, zoom and language
per origin. The page's zoom is its own (`src/app/shell/prefs.ts`); View › Vergrössern,
Verkleinern and Originalgrösse step it, and ⌘+ ⌘− ⌘0 still reach the page.

## Commands

    npm run desktop          # build the UI and the main process, then run the app from this checkout
    npm run desktop:build    # the .dmg files for Apple silicon and Intel, in release/
    node tools/desktop/smoke.mjs "release/mac-arm64/Vanilla Accounting.app" .verify/evidence/release/b

`tools/desktop/build.mjs` bundles `src/desktop` into `out/desktop/` (two folders below the app
root, as `APP_ROOT` expects) and fails when the bundle imports a package that is not a
dependency in `package.json`, since only those are packed. `tools/desktop/icon.mjs` renders
`desktop/icon.svg` to the PNG electron-builder makes the icon from.

The smoke test starts the packaged app with only `/usr/bin:/bin` on its PATH and a fresh user data
folder (so it never opens books of the machine), and drives it: start screen, Demo, every area,
issuing an invoice (one page, the QR-bill decodes), new books, File › Demo through the menu, a
restart, and a start without claude. Screenshots and `smoke.json` go to the evidence folder.

## Signing, notarization, updates

`desktop/electron-builder.config.cjs` reads the environment:

| Variable | Effect |
|---|---|
| `CSC_LINK`, `CSC_KEY_PASSWORD` | the Developer ID certificate (.p12) and its password: the app is signed. Without them it is not signed, even when the keychain holds an identity. |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | with a signing certificate: the app is notarized. |
| `VANILLA_RELEASES` | `owner/repo` of the GitHub releases: the update feed written into the app. |

The app checks for updates only when `package.json` has `"desktop": { "autoUpdate": true }`
(or `VANILLA_AUTO_UPDATE=1` is set), and only as a packaged app. Help › Dokumentation appears
when `package.json` has a `homepage`.

An unsigned app is refused by Gatekeeper on another Mac until the person allows it in System
Settings › Privacy & Security; a signed and notarized one opens with a double-click.
