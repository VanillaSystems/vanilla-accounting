# The desktop app

Vanilla Accounting as a Mac app (ADR 0006, form 3): one window on the same UI and the same engine
as `npm start`, with no terminal, Node.js or Homebrew needed. The code is in `src/desktop/`.

## How it is built

| Part | File | What it does |
|---|---|---|
| Main process | `src/desktop/main.ts` | One instance; starts the server on 127.0.0.1; opens the window; the native menu; window place, port, last books and the phone's pairing in `desktop.json` of the user data folder. |
| Server | `src/desktop/server.ts` | `/api/desktop` (the start screen's routes, the phone's switch), the built UI, and the books API (`src/server/api.ts`) once books are open. Opening other books switches the API in place. Requests naming another host are refused. Switched on, a second listener for the phone (below). |
| Background | `src/server/background.ts` | Shared with `npm start`: files arriving in the inbox (phone, drop, Finder) start their runs, at start for what waited and every 5 s after; the workflows' minute clock. Started once claude is known. |
| Start screen | `src/app/desktop/StartScreen.tsx` | At `/start` and whenever no books are open: open a folder, set up new books (the questions of `npm run init`, checked by `src/workspace/create.ts`), or open a copy of the demo. |
| Preload | `src/desktop/preload.ts` | The page's only bridge, `window.vanilla`: the folder dialog, menu commands (zoom), the UI language for the menu. Context isolation and the sandbox are on; the page has no Node. |
| PDFs | `src/desktop/print.ts` | Invoice and report PDFs printed by Electron's own Chromium in a hidden window (ADR 0012), so no browser has to be installed. `npm start` and the CLI keep printing with puppeteer-core. |
| claude CLI | `src/desktop/claude.ts` | Found through the person's login shell (an app from the Finder gets PATH `/usr/bin:/bin`) before the window opens; only its path is taken (`CLAUDE_BIN`), and the inbox job uses it. Without it, model features answer with what to install (`noClaude`), the inbox job does the steps that need no model, and everything else works. |
| Passwords | `src/secrets/sealed-store.ts` | The SMTP password, sealed by Electron's `safeStorage` (its key is the keychain item "vanilla-accounting Safe Storage") into `secrets.json` in the user data folder, per books. Firma › E-Mail-Versand saves it there; under `npm start` it stays in `.env`. |
| What is packed | `desktop/not-packed.cjs` | puppeteer-core, the canvas binary pdf.js would load, and the mail client of receipt collection (imapflow, mailparser) stay out, with every package only they need. The engine imports them only dynamically or from CLI code the bundle does not reach; `tools/desktop/build.mjs` fails when the bundle imports one at start. |
| Photos | `src/parsers/image-pdf.ts`, `src/parsers/smaller.ts` | A JPG, PNG or HEIC in the inbox becomes a one-page PDF, turned upright by its EXIF orientation; HEIC is decoded by `/usr/bin/sips`. An own photo or the phone's scan is made smaller before it gets its id: each large JPEG in it is scaled to 3000 pixels on its long side at quality 75, by `sips` as well; a received PDF, a signed or encrypted one stays byte for byte. |

## Receipts from the phone

The receipt app on the iPhone (`ios/`) and the scan page (`/scan`) send photos into the open
books' inbox, where the background run reads them like a drop. The phone pairs once, by scanning
a QR code the Mac shows in Firma › Handy.

**Security model.** The books API listens on 127.0.0.1 only, behind its host guard, as before;
nothing of it is on the network. The phone gets its own listener, and only while a person has
switched it on in Firma › Handy (off by default, and off again with one click):

| | |
|---|---|
| Listener | `0.0.0.0:<phone port>`, its own port, chosen by the system the first time and kept in `desktop.json`, so a paired phone finds the Mac after a restart. Only when that port is taken does it change; the phone then scans the new code. |
| Paths | `GET /scan`, `GET /scan/manifest.json` (the page, no data), `GET /api/status`, `POST /api/upload`. Everything else answers 404 there (`phoneApp`, `src/server/phone.ts`). |
| Token | 32 random bytes (base64url), made when the access is first switched on and kept while it is off. `/api/status` and `/api/upload` need `Authorization: Bearer <token>`; without it, or with another, 401 `phoneToken`, checked before the body is read and compared in constant time (both sides hashed, `timingSafeEqual`). The books API checks it once more (`phoneGate`). «Neuen Code erstellen» replaces it: every phone paired so far is refused until it scans the new code. |
| QR code | `http://<address>:<port>/scan#token=<token>`: the Mac's first Wi-Fi or Ethernet address. The token is in the fragment, which a browser never sends; the scan page keeps it in the phone's local storage and removes it from the address. The receipt app keeps it in the iOS Keychain (this device only). |
| Storage | `desktop.json` in the user data folder, written readable by the user only (0600). Whoever can read it can already read the books. |
| Network | Plain HTTP on the local network: someone on the same Wi-Fi who reads the traffic could see the token and upload into the inbox, never read the books. An uploaded file goes through the inbox's checks like any drop (the same bytes, a copy by its facts). |

What the inbox does with a phone's file: the background run reads it as it arrives. The same
bytes sent twice (a retry) leave the inbox, and the run says «schon da»; a scan of a receipt the
books hold already (other bytes, the same facts) is linked to nothing, and Belege asks «möglicher
Doppelbeleg» (`src/intake/duplicates.ts`). A till receipt without a printed date takes the day
the phone took it (`X-Captured-At`, carried in the inbox name, `src/intake/captured.ts`), and its
detail says so.

macOS may ask once whether «Vanilla Accounting» may accept incoming connections; the access only
works after «Erlauben». Under `npm start` the server listens on every interface as before; with
`VANILLA_PHONE_TOKEN` set in `.env`, requests from the network to `/api/status` and `/api/upload` need that token, and the
terminal prints the pairing link. Without it they stay open, as for development before.

The port is kept from one start to the next, because the page stores theme, zoom and language
per origin. The page's zoom is its own (`src/app/shell/prefs.ts`); View › Vergrössern,
Verkleinern and Originalgrösse step it, and ⌘+ ⌘− ⌘0 still reach the page.

## Commands

    npm run desktop          # build the UI and the main process, then run the app from this checkout
    npm run desktop:build    # release/Vanilla Accounting-<version>-arm64.dmg and -x64.dmg
    node tools/desktop/smoke.mjs "release/mac-arm64/Vanilla Accounting.app" .verify/evidence/release/b

`tools/desktop/build.mjs` bundles `src/desktop` into `out/desktop/` (two folders below the app
root, as `APP_ROOT` expects) and fails when the bundle imports a package that is not a
dependency in `package.json`, since only those are packed. The icon is the brand's: the wave in tram
blue (`assets/app-icons/macos/AppIcon.svg` and `AppIcon-1024.png` of the branding repository,
copied to `desktop/icon.svg` and `desktop/icon.png`; its `web/` set is `public/favicon*` and
`apple-touch-icon.png`; its `ios/` icon is the phone app's AppIcon set). `node tools/brand/icons.mjs
<branding repo>` copies them all, renders the phone sizes and pins each file's hash in
`desktop/brand-icons.json`; the hashes it replaces become `retired`. tests/brand-icons.test.ts and
`desktop:build` refuse an icon that is not pinned or a retired one anywhere in the repository, so
the old receipt icon cannot come back through a merge.

**Run it in a VM, never on your own desktop:** `npm run desktop:e2e` installs the built app into
the Tart VM `vanilla-e2e` over the copy there (as an update would) and runs the smoke test inside
it, with no window on the host; `-- --fresh` uses a throwaway clone of `vanilla-clean` for a first
installation, `-- --watch` shows the VM in a window. `tools/desktop/vm-e2e.sh` says what it needs
(an SSH key installed once). The evidence comes back to `/tmp/vanilla-e2e/out/`.

The smoke test starts the packaged app with only `/usr/bin:/bin` on its PATH and a fresh user data
folder (so it never opens books of the machine), and drives it: start screen, Demo, every area,
issuing an invoice (one page, the QR-bill decodes), the SMTP password saved in Firma and the
invoice sent to a local SMTP server (the attachment's hash is the stored PDF's), a PDF, a PNG and
a HEIC dropped and read by the inbox job, a camt.053 that pays the invoice, new books (committed
to git), File › Demo through the menu, a restart, and a start without claude. claude is
`tests/support/stub-bin/claude`, found through a login shell whose PATH holds it. Screenshots and
`smoke.json` go to the evidence folder. When the login keychain already holds the item
"vanilla-accounting Safe Storage" (an installed copy of the app made it), the smoke starts the app
with Chromium's `--use-mock-keychain` and checks that the item stays as it was: an unsigned
build of another signature would otherwise wait on macOS's prompt for it, and a test must not
change a person's keychain. [releasing.md](releasing.md) explains the prompt and how a release
is built, proven and published.

The release build is fused (`electronFuses` in the builder config): no `ELECTRON_RUN_AS_NODE`,
no `NODE_OPTIONS`, no `--inspect`, code only from `app.asar` with its hash checked, encrypted
cookies. So the smoke reaches the page through Chromium's `--remote-debugging-port`, and the
native menu through `window.vanillaSmoke`, which the preload exposes only when the app is started
with `--vanilla-smoke`. Both are command-line switches: a person opening the app from the Finder
has neither, and whoever can start it with switches could drive the page anyway.

## Signing, notarization, updates

`desktop/electron-builder.config.cjs` reads the environment:

| Variable | Effect |
|---|---|
| `CSC_LINK`, `CSC_KEY_PASSWORD` | the Developer ID certificate (.p12) and its password: the app is signed. Without them it is not signed, even when the keychain holds an identity. |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | with a signing certificate: the app is notarized. |
| `VANILLA_RELEASES` | `owner/repo` of the GitHub releases: the update feed written into the app, and the `.zip` files the updater installs from. |

The app checks for updates only when `package.json` has `"desktop": { "autoUpdate": true }`
(or `VANILLA_AUTO_UPDATE=1` is set), and only as a packaged app. Help › Dokumentation appears
when `package.json` has a `homepage`.

An unsigned app is refused by Gatekeeper on another Mac until the person allows it in System
Settings › Privacy & Security; a signed and notarized one opens with a double-click.
